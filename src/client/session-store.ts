import { toBase64, fromBase64 } from '../keys.ts'
import type { Session } from './api.ts'

/**
 * この端末に部屋を覚えておく。
 *
 * ⚠ **復号鍵をこの端末に置く**ということ。合言葉を毎回打たずに済む代わりに、
 * この端末を使える人はこの部屋を開ける。共用端末では「この端末から消す」を使う。
 * オフラインで開けるようにするにも、鍵が手元に無いと成立しない。
 */
const KEY = 'michizure.rooms.v1'

type Stored = { roomId: string; token: string; encKey: string; name: string }

export function remember(s: Session, name: string): void {
  const all = rememberedAll()
  const next = all.filter((r) => r.roomId !== s.roomId)
  next.unshift({
    roomId: s.roomId,
    token: s.token,
    encKey: toBase64(new Uint8Array(s.encKeyBits)),
    name,
  })
  localStorage.setItem(KEY, JSON.stringify(next))
}

export function rememberedAll(): Stored[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Stored[]
  } catch {
    return []
  }
}

export function remembered(roomId: string): Session | null {
  const hit = rememberedAll().find((r) => r.roomId === roomId)
  if (!hit) return null
  const bytes = fromBase64(hit.encKey)
  return { roomId: hit.roomId, token: hit.token, encKeyBits: bytes.buffer as ArrayBuffer }
}

export function forget(roomId: string): void {
  localStorage.setItem(KEY, JSON.stringify(rememberedAll().filter((r) => r.roomId !== roomId)))
}
