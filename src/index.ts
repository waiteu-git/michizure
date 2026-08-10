import { generateRoomId, issueToken } from './token'
import { toBase64 } from './keys'
import { MAX_BLOB_BYTES, TOKEN_TTL_MS, type Blob } from './types'

export { Room } from './room'

export interface Env {
  ROOM: DurableObjectNamespace
  TOKEN_SECRET: string
}

function roomStub(env: Env, roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId))
}

/** authKey をそのまま保存しないためのハッシュ。ストレージが漏れても認証には使えない */
export async function hashAuthKey(authKey: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authKey))
  return toBase64(new Uint8Array(buf))
}

export function blobTooLarge(blob: Blob | undefined): boolean {
  if (!blob || typeof blob.ciphertext !== 'string') return false
  return blob.ciphertext.length > MAX_BLOB_BYTES
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  let body: { salt?: string; authKey?: string; blob?: Blob }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.salt) return Response.json({ error: 'salt_required' }, { status: 400 })
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })
  if (!body.blob?.ciphertext) return Response.json({ error: 'blob_required' }, { status: 400 })
  if (blobTooLarge(body.blob)) return Response.json({ error: 'blob_too_large' }, { status: 413 })

  const roomId = generateRoomId()
  const now = Date.now()
  const res = await roomStub(env, roomId).fetch('https://do/create', {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      salt: body.salt,
      authKeyHash: await hashAuthKey(body.authKey),
      blob: body.blob,
      now,
    }),
  })
  if (!res.ok) return Response.json({ error: 'create_failed' }, { status: 500 })

  return Response.json({
    roomId,
    token: await issueToken(roomId, env.TOKEN_SECRET, TOKEN_TTL_MS, now),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return handleCreateRoom(request, env)
    }
    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
