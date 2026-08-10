import { DurableObject } from 'cloudflare:workers'
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_REQUEST_BYTES,
  ROOM_TTL_MS,
  ciphertextBytes,
  type Blob,
  type RoomMeta,
} from './types.ts'

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/create') return this.handleCreate(request)
    if (url.pathname === '/salt') return this.handleSalt()
    if (url.pathname === '/enter') return this.handleEnter(request)
    if (url.pathname === '/blob' && request.method === 'GET') return this.handleGetBlob()
    if (url.pathname === '/blob' && request.method === 'PUT') return this.handlePutBlob(request)
    if (url.pathname === '/ws') return this.handleWebSocket()
    if (url.pathname === '/delete') return this.handleDelete(request)
    return new Response('Not Found', { status: 404 })
  }

  private sql() {
    return this.ctx.storage.sql
  }

  private ensureSchema(): void {
    this.sql().exec('CREATE TABLE IF NOT EXISTS room (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  private put(key: string, value: unknown): void {
    this.sql().exec(
      'INSERT INTO room (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    )
  }

  private get<T>(key: string): T | null {
    const rows = [...this.sql().exec('SELECT value FROM room WHERE key = ?', key)]
    return rows.length === 0 ? null : (JSON.parse(rows[0].value as string) as T)
  }

  private async handleCreate(request: Request): Promise<Response> {
    this.ensureSchema()
    if (this.get<RoomMeta>('meta') !== null) {
      return Response.json({ error: 'already_exists' }, { status: 409 })
    }
    const body = (await request.json()) as {
      roomId: string
      salt: string
      authKeyHash: string
      blob: Blob
      now: number
    }
    this.put('meta', {
      roomId: body.roomId,
      createdAt: body.now,
      lastAccessAt: body.now,
      schemaVersion: 1,
    } satisfies RoomMeta)
    this.put('auth', { salt: body.salt, authKeyHash: body.authKeyHash })
    this.put('blob', body.blob)
    await this.ctx.storage.setAlarm(body.now + ROOM_TTL_MS)
    return Response.json({ ok: true })
  }

  private handleSalt(): Response {
    this.ensureSchema()
    const auth = this.get<{ salt: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })
    // ソルトは秘密ではない。認証前に渡さないとクライアントが鍵を導出できない
    return Response.json({ salt: auth.salt })
  }

  /**
   * authKey を照合する経路すべてで共有する。
   * ⚠ 入室だけをバックオフしても、同じ authKey を試せる経路（削除など）が
   * 素通りなら総当たり対策として意味がない。新しい経路を足す時は必ずここを通す。
   */
  private checkAuth(
    candidateHash: string,
    now: number,
  ): { ok: true } | { ok: false; status: 429 | 401 | 404 } {
    const auth = this.get<{ authKeyHash: string }>('auth')
    if (auth === null) return { ok: false, status: 404 }

    const gate = this.get<{ failures: number; blockedUntil: number }>('gate') ?? {
      failures: 0,
      blockedUntil: 0,
    }
    if (now < gate.blockedUntil) return { ok: false, status: 429 }

    if (!constantTimeEquals(candidateHash, auth.authKeyHash)) {
      const failures = gate.failures + 1
      // 5回目以降は指数バックオフ（5回目=1分、6回目=2分…最大1時間）
      const blockedUntil =
        failures >= 5 ? now + Math.min(60_000 * 2 ** (failures - 5), 3_600_000) : 0
      this.put('gate', { failures, blockedUntil })
      return { ok: false, status: 401 }
    }

    this.put('gate', { failures: 0, blockedUntil: 0 })
    return { ok: true }
  }

  private async handleEnter(request: Request): Promise<Response> {
    this.ensureSchema()
    const body = (await request.json()) as { authKeyHash: string; now: number }
    const result = this.checkAuth(body.authKeyHash, body.now)
    if (!result.ok) {
      const code =
        result.status === 404 ? 'not_found' : result.status === 429 ? 'too_many_attempts' : 'invalid_key'
      return Response.json({ error: code }, { status: result.status })
    }

    const meta = this.get<RoomMeta>('meta')!
    this.put('meta', { ...meta, lastAccessAt: body.now })
    await this.ctx.storage.setAlarm(body.now + ROOM_TTL_MS)
    return Response.json({ ok: true })
  }

  private handleGetBlob(): Response {
    this.ensureSchema()
    const blob = this.get<Blob>('blob')
    if (blob === null) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(blob)
  }

  private async handlePutBlob(request: Request): Promise<Response> {
    this.ensureSchema()
    if (this.get<Blob>('blob') === null) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    // 中身は読まない。読めない。サイズだけ見る
    const blob = (await request.json()) as Blob
    if (typeof blob?.ciphertext !== 'string' || typeof blob?.iv !== 'string') {
      return Response.json({ error: 'invalid_blob' }, { status: 400 })
    }
    this.put('blob', blob)
    return Response.json({ ok: true })
  }

  private handleWebSocket(): Response {
    this.ensureSchema()
    const blob = this.get<Blob>('blob')
    if (blob === null) return new Response('not found', { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Hibernation API。server.accept() を使うと DO が常駐し duration 課金が続く
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'init', blob }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    if (message.length > MAX_REQUEST_BYTES) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }
    let msg: { type?: string; blob?: Blob }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (msg.type !== 'update' || typeof msg.blob?.ciphertext !== 'string') return
    // 判定は HTTP の作成・更新と同じ基準に揃える（設計 §7.4 の唯一の防御）
    if (ciphertextBytes(msg.blob.ciphertext) > MAX_CIPHERTEXT_BYTES) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }

    this.ensureSchema()
    // 削除済みの部屋へ書き戻さない。接続が生きていても部屋はもう無い
    if (this.get<RoomMeta>('meta') === null) {
      ws.send(JSON.stringify({ type: 'error', code: 'room_deleted' }))
      ws.close(1000, 'room deleted')
      return
    }
    this.put('blob', msg.blob)

    // 送信者を除外するのはここだけ。クライアント側に重複防止フラグを置いてはならない
    const payload = JSON.stringify({ type: 'update', blob: msg.blob })
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(payload)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1004 / 1005（コード無し）/ 1006（異常終了）は close() に渡すと例外になる
    const reusable = code >= 1000 && code < 5000 && code !== 1004 && code !== 1005 && code !== 1006
    if (reusable) ws.close(code, reason)
    else ws.close()
  }

  /** テスト専用。ストレージの全内容を文字列で返す。平文が混入していないかの検査に使う */
  async dumpForTest(): Promise<string> {
    this.ensureSchema()
    const rows = [...this.sql().exec('SELECT key, value FROM room')]
    return JSON.stringify(rows)
  }

  private async handleDelete(request: Request): Promise<Response> {
    this.ensureSchema()
    const body = (await request.json()) as { authKeyHash: string; now: number }
    // 入室と同じ関門を通す（ここを素通りさせると入室側のバックオフが無意味になる）
    const result = this.checkAuth(body.authKeyHash, body.now)
    if (!result.ok) {
      const code =
        result.status === 404 ? 'not_found' : result.status === 429 ? 'too_many_attempts' : 'invalid_key'
      return Response.json({ error: code }, { status: result.status })
    }
    await this.destroy()
    return Response.json({ ok: true })
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    // 🔴 生きている接続を残すと、そこから update が届いて部屋が復活する。
    // 「削除したのに戻る」は privacy 上いちばん悪い壊れ方なので必ず閉じる
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(JSON.stringify({ type: 'error', code: 'room_deleted' }))
      ws.close(1000, 'room deleted')
    }
  }

  async alarm(): Promise<void> {
    this.ensureSchema()
    const meta = this.get<RoomMeta>('meta')
    if (meta === null) return
    if (Date.now() - meta.lastAccessAt >= ROOM_TTL_MS) {
      await this.destroy()
      return
    }
    // まだ使われているので次の期限へ再設定する
    await this.ctx.storage.setAlarm(meta.lastAccessAt + ROOM_TTL_MS)
  }

  /** テスト専用。lastAccessAt を任意の時刻に書き換える */
  async setLastAccessForTest(at: number): Promise<void> {
    this.ensureSchema()
    const meta = this.get<RoomMeta>('meta')
    if (meta === null) return
    this.put('meta', { ...meta, lastAccessAt: at })
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
