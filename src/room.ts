import { DurableObject } from 'cloudflare:workers'
import { ROOM_TTL_MS, type Blob, type RoomMeta } from './types'

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/create') return this.handleCreate(request)
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

  async alarm(): Promise<void> {
    // Task 11 で実装する
  }
}
