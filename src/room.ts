import { DurableObject } from 'cloudflare:workers'
import { MAX_BLOB_BYTES, ROOM_TTL_MS, type Blob, type RoomMeta } from './types'

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

  private async handleEnter(request: Request): Promise<Response> {
    this.ensureSchema()
    const auth = this.get<{ salt: string; authKeyHash: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })

    const body = (await request.json()) as { authKeyHash: string; now: number }
    const gate = this.get<{ failures: number; blockedUntil: number }>('gate') ?? {
      failures: 0,
      blockedUntil: 0,
    }
    if (body.now < gate.blockedUntil) {
      return Response.json({ error: 'too_many_attempts' }, { status: 429 })
    }

    if (!constantTimeEquals(body.authKeyHash, auth.authKeyHash)) {
      const failures = gate.failures + 1
      // 5回目以降は指数バックオフ（5回目=1分、6回目=2分…最大1時間）
      const blockedUntil =
        failures >= 5 ? body.now + Math.min(60_000 * 2 ** (failures - 5), 3_600_000) : 0
      this.put('gate', { failures, blockedUntil })
      return Response.json({ error: 'invalid_key' }, { status: 401 })
    }

    this.put('gate', { failures: 0, blockedUntil: 0 })
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
    if (message.length > MAX_BLOB_BYTES * 2) {
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
    if (msg.blob.ciphertext.length > MAX_BLOB_BYTES) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }

    this.ensureSchema()
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
    const auth = this.get<{ authKeyHash: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })
    const body = (await request.json()) as { authKeyHash: string }
    if (!constantTimeEquals(body.authKeyHash, auth.authKeyHash)) {
      return Response.json({ error: 'invalid_key' }, { status: 401 })
    }
    await this.destroy()
    return Response.json({ ok: true })
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
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
