import { generateRoomId, issueToken, verifyToken } from './token.ts'
import { toBase64 } from './keys.ts'
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_REQUEST_BYTES,
  TOKEN_TTL_MS,
  blobShapeInvalid,
  ciphertextBytes,
  iterationsInvalid,
  kdfVersionInvalid,
  allowedOrigin,
  type Blob,
} from './types.ts'

export { Room } from './room.ts'

export interface Env {
  ROOM: DurableObjectNamespace
  TOKEN_SECRET: string
  ASSETS: Fetcher
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
  // ⚠ 判定できない入力は「大きすぎる」側に倒す。false を返すと上限検査が素通りする
  if (!blob || typeof blob.ciphertext !== 'string') return true
  // 文字数ではなく復号後のバイト数で見る（設計 §7.4 の 256KB はバイト数）
  return ciphertextBytes(blob.ciphertext) > MAX_CIPHERTEXT_BYTES
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  // 生の本文での足切りを更新側だけに置くと、作成経路から巨大な本文が入る
  const raw = await request.text()
  if (raw.length > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'blob_too_large' }, { status: 413 })
  }
  let body: { salt?: string; authKey?: string; blob?: Blob; iterations?: number; kdfVersion?: number }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.salt) return Response.json({ error: 'salt_required' }, { status: 400 })
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })
  if (!body.blob?.ciphertext) return Response.json({ error: 'blob_required' }, { status: 400 })
  if (blobShapeInvalid(body.blob)) return Response.json({ error: 'invalid_blob' }, { status: 400 })
  if (blobTooLarge(body.blob)) return Response.json({ error: 'blob_too_large' }, { status: 413 })
  // 反復回数は部屋に残す。クライアントが後から既定値を変えても、
  // その部屋は作られた時の値で鍵を導出できる（残さないと入室不能になる）
  if (iterationsInvalid(body.iterations)) {
    return Response.json({ error: 'invalid_iterations' }, { status: 400 })
  }
  // 正規化の規則も部屋ごとに残す（変えると既存の部屋が開けなくなるため）
  if (kdfVersionInvalid(body.kdfVersion)) {
    return Response.json({ error: 'invalid_kdf_version' }, { status: 400 })
  }

  const roomId = generateRoomId()
  const now = Date.now()
  const res = await roomStub(env, roomId).fetch('https://do/create', {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      salt: body.salt,
      authKeyHash: await hashAuthKey(body.authKey),
      iterations: body.iterations,
      kdfVersion: body.kdfVersion,
      blob: body.blob,
      now,
    }),
  })
  if (!res.ok) return Response.json({ error: 'create_failed' }, { status: 500 })
  // ⚠ DO が採番した版をそのまま渡す。ここで数え直さない（数える主体は1つ）
  const { rev } = (await res.json()) as { rev?: number }

  return Response.json({
    roomId,
    token: await issueToken(roomId, env.TOKEN_SECRET, TOKEN_TTL_MS, now),
    rev: rev ?? 0,
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
    if (body.length > MAX_REQUEST_BYTES) {
      return Response.json({ error: 'blob_too_large' }, { status: 413 })
    }
    let parsed: Blob | undefined
    try {
      parsed = JSON.parse(body) as Blob
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    // 判定は作成時（handleCreateRoom）と同じ関数で行う。
    // ここだけ別の基準にすると「作成では弾かれるのに更新では通る」穴ができる
    if (blobShapeInvalid(parsed)) {
      return Response.json({ error: 'invalid_blob' }, { status: 400 })
    }
    if (blobTooLarge(parsed)) {
      return Response.json({ error: 'blob_too_large' }, { status: 413 })
    }
  }
  const res = await roomStub(env, roomId).fetch('https://do/blob', {
    method: request.method,
    body,
    // 書いた本人へ中継し返さないための識別子。中身には関与しない
    headers: { 'X-Client-Id': request.headers.get('X-Client-Id') ?? '' },
  })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleDeleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  let body: { authKey?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })
  const res = await roomStub(env, roomId).fetch('https://do/delete', {
    method: 'POST',
    body: JSON.stringify({ authKeyHash: await hashAuthKey(body.authKey), now: Date.now() }),
  })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleWebSocket(request: Request, env: Env, roomId: string): Promise<Response> {
  // ⚠ Upgrade を確認せずに DO へ渡すと、使われない WebSocket が DO 側に作られて
  // Hibernation で生き残り続ける（ブロードキャストの相手も増える）
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'websocket_upgrade_required' }, { status: 400 })
  }
  const url = new URL(request.url)
  const token = url.searchParams.get('token') ?? ''
  if (!(await verifyToken(token, roomId, env.TOKEN_SECRET, Date.now()))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  // ⚠ DO へは URL を組み直して渡すので、**クエリは明示的に運ぶ**。
  // 落とすと接続に client が付かず、書いた本人にも中継し返してしまう
  const client = encodeURIComponent(url.searchParams.get('client') ?? '')
  return roomStub(env, roomId).fetch(`https://do/ws?client=${client}`, {
    headers: request.headers,
  })
}

/**
 * 検索結果に出さない。
 *
 * ⚠ 面は3つある（robots.txt / meta タグ / このヘッダ）。**robots.txt はお願いでしかなく**、
 * meta タグは HTML にしか効かない。ヘッダは API の応答にも効く。
 * 根拠＝**2026-09-04 のユーザー裁定「非公開開発のみ先行可」**。本人が再裁定するまで
 * 生きている。検索結果に出ることは、この裁定そのものを壊す。
 *
 * ⚠ 以前の根拠（グレーゾーン解消制度の事前相談中は「非公開・宣伝なし」が条件）は
 * **2026-09-10 に METI が制度の適用不可を回答して消えた**。だが**裁定は根拠の一部が
 * 消えただけで生きている**。⇒ ここを外すのは、本人の再裁定が出てから。
 */
function noIndex(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return out
}

/**
 * ネイティブのシェルは別オリジンになるので、API に CORS が要る。
 *
 * 🔴 **許可は一覧に一致した時だけ。** 要求された Origin を無条件に返す（反射する）と
 * 全開と同じで、誰のページからでも部屋を叩けるようになる。
 * ⚠ Cookie は使っていない（認証は Authorization ヘッダ）ので credentials は許可しない。
 */
function withCors(res: Response, origin: string | null): Response {
  const allowed = allowedOrigin(origin)
  if (!allowed) return res
  const out = new Response(res.body, res)
  out.headers.set('Access-Control-Allow-Origin', allowed)
  out.headers.set('Vary', 'Origin')
  return out
}

function preflight(origin: string | null): Response | null {
  const allowed = allowedOrigin(origin)
  if (!allowed) return null
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client-Id',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  })
}

async function route(request: Request, env: Env): Promise<Response> {
  {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return handleCreateRoom(request, env)
    }

    const saltMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/salt$/)
    if (saltMatch && request.method === 'GET') return handleSalt(env, saltMatch[1])

    const enterMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/enter$/)
    if (enterMatch && request.method === 'POST') return handleEnterRoom(request, env, enterMatch[1])

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})$/)
    if (roomMatch && request.method === 'DELETE') return handleDeleteRoom(request, env, roomMatch[1])

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/ws$/)
    if (wsMatch) return handleWebSocket(request, env, wsMatch[1])

    const blobMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/blob$/)
    if (blobMatch && (request.method === 'GET' || request.method === 'PUT')) {
      return handleBlob(request, env, blobMatch[1])
    }

    // 🔴 /r/<部屋ID> は【利用者が共有する URL】。ここで 404 を返すと、
    // 受け取った人がリンクを開いても何も出ない。
    // アセットに一致しないパスは Worker へ来るので、明示的に画面を返す
    if (/^\/r\/[0-9A-Z]{16}$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request))
    }

    return new Response('Not Found', { status: 404 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    if (request.method === 'OPTIONS') {
      const pre = preflight(origin)
      if (pre) return pre
    }
    return withCors(noIndex(await route(request, env)), origin)
  },
} satisfies ExportedHandler<Env>
