import { generateRoomId, issueToken, verifyToken } from './token'
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

async function handleSalt(env: Env, roomId: string): Promise<Response> {
  const res = await roomStub(env, roomId).fetch('https://do/salt')
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleEnterRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  let body: { authKey?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })

  const now = Date.now()
  const res = await roomStub(env, roomId).fetch('https://do/enter', {
    method: 'POST',
    body: JSON.stringify({ authKeyHash: await hashAuthKey(body.authKey), now }),
  })
  if (!res.ok) return new Response(res.body, { status: res.status })

  return Response.json({ token: await issueToken(roomId, env.TOKEN_SECRET, TOKEN_TTL_MS, now) })
}

async function authorize(request: Request, env: Env, roomId: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token ? verifyToken(token, roomId, env.TOKEN_SECRET, Date.now()) : false
}

async function handleBlob(request: Request, env: Env, roomId: string): Promise<Response> {
  if (!(await authorize(request, env, roomId))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  let body: string | undefined
  if (request.method === 'PUT') {
    body = await request.text()
    // 生の本文での足切り。巨大な本文を JSON.parse しないための安い防御
    if (body.length > MAX_BLOB_BYTES * 2) {
      return Response.json({ error: 'blob_too_large' }, { status: 413 })
    }
    let parsed: Blob | undefined
    try {
      parsed = JSON.parse(body) as Blob
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    // 判定は作成時（handleCreateRoom）と同じ blobTooLarge で行う。
    // ここだけ別の基準にすると「作成では 413 なのに更新では通る」穴ができる
    if (blobTooLarge(parsed)) {
      return Response.json({ error: 'blob_too_large' }, { status: 413 })
    }
  }
  const res = await roomStub(env, roomId).fetch('https://do/blob', { method: request.method, body })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleWebSocket(request: Request, env: Env, roomId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  if (!(await verifyToken(token, roomId, env.TOKEN_SECRET, Date.now()))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return roomStub(env, roomId).fetch('https://do/ws', { headers: request.headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return handleCreateRoom(request, env)
    }

    const saltMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/salt$/)
    if (saltMatch && request.method === 'GET') return handleSalt(env, saltMatch[1])

    const enterMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/enter$/)
    if (enterMatch && request.method === 'POST') return handleEnterRoom(request, env, enterMatch[1])

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/ws$/)
    if (wsMatch) return handleWebSocket(request, env, wsMatch[1])

    const blobMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/blob$/)
    if (blobMatch && (request.method === 'GET' || request.method === 'PUT')) {
      return handleBlob(request, env, blobMatch[1])
    }

    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
