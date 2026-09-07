import { DurableObject } from 'cloudflare:workers'
import {
  GATE_DECAY_MS,
  MAX_CIPHERTEXT_BYTES,
  MAX_REQUEST_BYTES,
  ROOM_TTL_MS,
  blobShapeInvalid,
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
    if (url.pathname === '/ws') return this.handleWebSocket(request)
    if (url.pathname === '/delete') return this.handleDelete(request)
    return new Response('Not Found', { status: 404 })
  }

  private sql() {
    return this.ctx.storage.sql
  }

  /**
   * 🔴 テーブルを作るのは【書き込み時だけ】。
   * 読み取りで CREATE TABLE すると、存在しない部屋IDを叩かれただけで
   * DO のストレージが作られ、alarm も無いので永久に残る＝空部屋を無限に量産できる。
   */
  private ensureSchema(): void {
    this.sql().exec('CREATE TABLE IF NOT EXISTS room (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  private tableExists(): boolean {
    const rows = [
      ...this.sql().exec("SELECT name FROM sqlite_master WHERE type='table' AND name='room'"),
    ]
    return rows.length > 0
  }

  private put(key: string, value: unknown): void {
    this.ensureSchema()
    this.sql().exec(
      'INSERT INTO room (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    )
  }

  /**
   * 🔴 **blob を書く唯一の入口。版を必ず1つ進める。**
   *
   * 書き込み経路は create / PUT / WS の3つある。どれか1つでも版を進め忘れると、
   * 「今の版を見ている」と信じた別の端末の書き込みを通してしまい、
   * **その端末が持っている記録が黙って消える**。経路ごとに書かず、ここを通す。
   */
  private writeBlob(blob: Blob): number {
    const next = this.rev() + 1
    this.put('blob', blob)
    this.put('rev', next)
    return next
  }

  /** 今サーバーが持っている版。まだ一度も書いていなければ 0 */
  private rev(): number {
    return this.get<number>('rev') ?? 0
  }

  private get<T>(key: string): T | null {
    if (!this.tableExists()) return null
    const rows = [...this.sql().exec('SELECT value FROM room WHERE key = ?', key)]
    return rows.length === 0 ? null : (JSON.parse(rows[0].value as string) as T)
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (this.get<RoomMeta>('meta') !== null) {
      return Response.json({ error: 'already_exists' }, { status: 409 })
    }
    const body = (await request.json()) as {
      roomId: string
      salt: string
      authKeyHash: string
      iterations: number
      kdfVersion: number
      blob: Blob
      now: number
    }
    this.put('meta', {
      roomId: body.roomId,
      createdAt: body.now,
      lastAccessAt: body.now,
      schemaVersion: 1,
    } satisfies RoomMeta)
    // 🔴 iterations は部屋ごとに残す。既定値を後から変えると、
    // 残していない部屋は入室も復号もできなくなる（設計 §16 は変える前提）
    this.put('auth', {
      salt: body.salt,
      authKeyHash: body.authKeyHash,
      iterations: body.iterations,
      kdfVersion: body.kdfVersion,
    })
    // ⚠ 版を返す。返さないと、**作った本人が今の版を知る手段が無い**＝最初の書き込みが
    // 必ず 409 になり、土台も無いのでマージもできず、その端末は永久に送れなくなる
    // （2026-09-07 のレビューで3つの観点が独立に指した欠陥）
    const rev = this.writeBlob(body.blob)
    await this.ctx.storage.setAlarm(body.now + ROOM_TTL_MS)
    return Response.json({ ok: true, rev })
  }

  private handleSalt(): Response {
    const auth = this.get<{ salt: string; iterations: number; kdfVersion: number }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })
    // ソルトは秘密ではない。認証前に渡さないとクライアントが鍵を導出できない。
    // iterations と kdfVersion も同じ理由で返す
    // （その部屋が作られた時の反復回数と正規化規則でしか鍵は再現しない）
    return Response.json({
      salt: auth.salt,
      iterations: auth.iterations,
      kdfVersion: auth.kdfVersion,
    })
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

    const stored = this.get<{ failures: number; blockedUntil: number; lastFailureAt: number }>(
      'gate',
    ) ?? { failures: 0, blockedUntil: 0, lastFailureAt: 0 }
    // 失敗は時間で減衰させる。減衰が無いと「先月5回打ち間違えた」が永久に効き、
    // 次の1回でいきなり長時間ロックされる
    const gate =
      now - stored.lastFailureAt > GATE_DECAY_MS
        ? { failures: 0, blockedUntil: 0, lastFailureAt: 0 }
        : stored

    if (now < gate.blockedUntil) return { ok: false, status: 429 }

    if (!constantTimeEquals(candidateHash, auth.authKeyHash)) {
      const failures = gate.failures + 1
      // 5回目以降は指数バックオフ（5回目=1分、6回目=2分…最大1時間）
      const blockedUntil =
        failures >= 5 ? now + Math.min(60_000 * 2 ** (failures - 5), 3_600_000) : 0
      this.put('gate', { failures, blockedUntil, lastFailureAt: now })
      return { ok: false, status: 401 }
    }

    this.put('gate', { failures: 0, blockedUntil: 0, lastFailureAt: 0 })
    return { ok: true }
  }

  /** テスト専用。関門の状態を任意に書き換える */
  async setGateForTest(gate: {
    failures: number
    blockedUntil: number
    lastFailureAt: number
  }): Promise<void> {
    this.put('gate', gate)
  }

  private async handleEnter(request: Request): Promise<Response> {
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
    const blob = this.get<Blob>('blob')
    if (blob === null) return Response.json({ error: 'not_found' }, { status: 404 })
    // ⚠ 版も返す。これを持って帰らないと、次の書き込みで必ず断られる
    return Response.json({ ...blob, rev: this.rev() })
  }

  private async handlePutBlob(request: Request): Promise<Response> {
    if (this.get<Blob>('blob') === null) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    // 中身は読まない。読めない。形とサイズだけ見る
    const body = (await request.json()) as Blob & { baseRev?: unknown }
    if (blobShapeInvalid(body)) {
      return Response.json({ error: 'invalid_blob' }, { status: 400 })
    }

    /**
     * 🔴 **今の版を見ていない書き込みは受けない。**
     *
     * 受けてしまうと、2台が**同時に**電波を取り戻した時に双方が丸ごと上書きし、
     * **後の1本が前の記録を黙って消す**。サーバーは中身を読めないので、
     * 消えたことにも気づけないし、直す手段も無い。
     * 2026-09-06、2タブの実測で再現（PUT が2本続けて 200 OK になり、
     * 先に書いた側の記録が両方の端末から消えた）。
     *
     * 断られた側は取り込み直してから送り直す＝そこで初めて3方向マージが働く。
     */
    const current = this.rev()
    if (body.baseRev !== current) {
      return Response.json({ error: 'stale', rev: current }, { status: 409 })
    }

    // ⚠ baseRev は保存しない（暗号文の一部ではない）。形を揃えてから書く
    const blob: Blob = { ciphertext: body.ciphertext, iv: body.iv, blobVersion: body.blobVersion }
    const rev = this.writeBlob(blob)
    // 🔴 PUT でも中継する。しないと「同じ部屋を開いている人に届かない」ため
    // クライアントが WS でも書くことになり、**書き込み経路が増える**。
    // 検査を全部の面に入れ忘れる形を自分で作らないための判断（設計 §8）
    this.broadcast(blob, rev, request.headers.get('X-Client-Id'))
    return Response.json({ ok: true, rev })
  }

  private handleWebSocket(request: Request): Response {
    const blob = this.get<Blob>('blob')
    if (blob === null) return new Response('not found', { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Hibernation API。server.accept() を使うと DO が常駐し duration 課金が続く
    this.ctx.acceptWebSocket(server)
    // 誰の接続かを覚えておく。書いた本人へ中継し返さないために要る。
    // ⚠ Hibernation で DO が退避しても残るよう、変数ではなく接続に括り付ける
    const clientId = new URL(request.url).searchParams.get('client') ?? ''
    server.serializeAttachment({ clientId })
    server.send(JSON.stringify({ type: 'init', blob, rev: this.rev() }))
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 更新を他の接続へ配る。**書いた本人には返さない。**
   *
   * このプロジェクトの前身で、送信者除外が効いているつもりで実際には
   * 他端末の更新を握り潰していた不具合があった。除外の判定はここ1箇所に集約し、
   * クライアント側に重複防止フラグを置いてはならない。
   */
  private broadcast(blob: Blob, rev: number, exclude: WebSocket | string | null): void {
    const payload = JSON.stringify({ type: 'update', blob, rev })
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === exclude) continue
      if (typeof exclude === 'string' && exclude !== '') {
        const att = peer.deserializeAttachment() as { clientId?: string } | null
        if (att?.clientId === exclude) continue
      }
      peer.send(payload)
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    if (message.length > MAX_REQUEST_BYTES) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }
    let msg: { type?: string; blob?: Blob; baseRev?: unknown }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    // 🔴 書き込み経路は create / PUT / WS の3つ。判定は必ず同じ関数を通す。
    // ここだけ ciphertext の型しか見ていなかったため、iv の無い update 1通で
    // 部屋の唯一の暗号文と iv が同時に消えていた（サーバーに復旧手段は無い）
    if (msg.type !== 'update' || blobShapeInvalid(msg.blob)) {
      ws.send(JSON.stringify({ type: 'error', code: 'invalid_blob' }))
      return
    }
    if (ciphertextBytes(msg.blob!.ciphertext) > MAX_CIPHERTEXT_BYTES) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }

    // 削除済みの部屋へ書き戻さない。接続が生きていても部屋はもう無い
    if (this.get<RoomMeta>('meta') === null) {
      ws.send(JSON.stringify({ type: 'error', code: 'room_deleted' }))
      ws.close(1000, 'room deleted')
      return
    }

    // 🔴 PUT と**同じ照合**。片面だけ守ると、そちらを通るだけで上書きが復活する
    const current = this.rev()
    if (msg.baseRev !== current) {
      ws.send(JSON.stringify({ type: 'error', code: 'stale', rev: current }))
      return
    }
    const rev = this.writeBlob(msg.blob!)
    this.broadcast(msg.blob!, rev, ws)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1004 / 1005（コード無し）/ 1006（異常終了）は close() に渡すと例外になる
    const reusable = code >= 1000 && code < 5000 && code !== 1004 && code !== 1005 && code !== 1006
    if (reusable) ws.close(code, reason)
    else ws.close()
  }

  /**
   * テスト専用。ストレージの全内容を返す。平文が混入していないかの検査に使う。
   * ⚠ 自作テーブルだけを見ると、別のテーブルに漏れたデータを見逃す。
   * ⚠ ここで CREATE TABLE してはいけない（検査そのものがストレージを作ってしまう）
   */
  async dumpForTest(): Promise<string> {
    // `_cf_*` は Durable Objects の内部テーブルで、読もうとすると SQLITE_AUTH で拒否される
    const tables = [
      ...this.sql().exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      ),
    ].map((r) => r.name as string)
    const out: Record<string, unknown> = {}
    for (const table of tables) {
      out[table] = [...this.sql().exec(`SELECT * FROM ${table}`)]
    }
    // 🔴 **KV 側も必ず含める。** `ctx.storage.put()` の値は `_cf_KV` に入るが、
    // そのテーブルは上の除外条件で落ちるうえ、直接 SELECT すると SQLITE_AUTH で拒否される。
    // ⇒ SQL では原理的に見えない。`ctx.storage.list()` で取るしかない。
    //
    // ⚠ ここが抜けていると、この関数を使う「平文が保存されていないこと」の検査は
    // **KV へ書かれた平文に対して常に緑を返す**（＝検査が在るのに何も守っていない）。
    // 監査 item 20 で一度指摘され、SQL 側だけ広げて ✅ にしてしまっていた（2026-09-05 に再発見）。
    // この DO 自身が `ctx.storage.setAlarm` 等で KV を使っているので、絵空事ではない。
    out['_storage_kv'] = Object.fromEntries(await this.ctx.storage.list())
    return JSON.stringify(out)
  }

  private async handleDelete(request: Request): Promise<Response> {
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
