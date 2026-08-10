import { DurableObject } from 'cloudflare:workers'
import { ROOM_TTL_MS, type Blob, type RoomMeta } from './types'

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/create') return this.handleCreate(request)
    if (url.pathname === '/salt') return this.handleSalt()
    if (url.pathname === '/enter') return this.handleEnter(request)
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

  async alarm(): Promise<void> {
    // Task 11 で実装する
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
