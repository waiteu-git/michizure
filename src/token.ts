import { toBase64 } from './keys.ts'

const enc = new TextEncoder()
// Crockford base32 から I / L / O / U を除いた文字集合。読み間違いを避ける
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

/**
 * 🔴 base64url にする理由。トークンは WebSocket 接続でクエリ文字列に載せるしかない
 * （ブラウザは WS のハンドシェイクにヘッダを付けられない）。標準 base64 の `+` は
 * クエリ文字列の解析で【空白に化ける】ため、署名に `+` が入った瞬間に検証が失敗する。
 * 署名32バイトなら約半数のトークンが該当し、「ときどき繋がらない」という形で出る。
 */
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))))
}

export async function issueToken(
  roomId: string,
  secret: string,
  ttlMs: number,
  now: number,
): Promise<string> {
  const payload = `${roomId}.${now + ttlMs}`
  return `${payload}.${await sign(payload, secret)}`
}

export async function verifyToken(
  token: string,
  roomId: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [tokenRoomId, expiresAt, sig] = parts
  if (tokenRoomId !== roomId) return false
  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || now > expiry) return false
  const expected = await sign(`${tokenRoomId}.${expiresAt}`, secret)
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}
