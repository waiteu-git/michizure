// 本番の反復回数。ローエンド端末で実測して調整すること（設計 §16 の未決事項）
export const PBKDF2_ITERATIONS = 600_000

const enc = new TextEncoder()

// String.fromCharCode(...bytes) は引数の個数がそのままスタックに積まれるため、
// 数万バイトの暗号文を渡すと RangeError になる。分割して積む
const CHUNK = 0x8000

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function generateSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

/**
 * 合言葉から authKey（サーバーへ送る）と encKey（送らない）を導出する。
 * 別々の info から HKDF で分岐させるため、authKey が漏れても encKey は導出できない。
 */
export async function deriveKeys(
  passphrase: string,
  salt: string,
  iterations: number,
): Promise<{ authKey: string; encKeyBits: ArrayBuffer }> {
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ])
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
    pwKey,
    256,
  )
  const master = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits'])

  const derive = (info: string) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
      master,
      256,
    )

  const [authBits, encKeyBits] = await Promise.all([
    derive('michizure-auth-v1'),
    derive('michizure-enc-v1'),
  ])
  return { authKey: toBase64(new Uint8Array(authBits)), encKeyBits }
}
