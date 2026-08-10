import { toBase64, fromBase64 } from './keys'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function importKey(encKeyBits: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encKeyBits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(
  encKeyBits: ArrayBuffer,
  plain: unknown,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(encKeyBits)
  // GCM では IV の再利用が致命的なので、暗号化のたびに必ず新しく生成する
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(plain)),
  )
  return { ciphertext: toBase64(new Uint8Array(buf)), iv: toBase64(iv) }
}

export async function open<T>(encKeyBits: ArrayBuffer, ciphertext: string, iv: string): Promise<T> {
  const key = await importKey(encKeyBits)
  // 鍵違い・改ざんはここで例外になる（AES-GCM の認証タグ検証）
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  )
  return JSON.parse(dec.decode(buf)) as T
}
