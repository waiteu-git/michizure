import { toBase64, fromBase64 } from '../keys.ts'
import type { Session } from './api.ts'
import type { Entry } from './entry.ts'

/**
 * この端末に部屋を覚えておく。
 *
 * ⚠ **復号鍵をこの端末に置く**ということ。合言葉を毎回打たずに済む代わりに、
 * この端末を使える人はこの部屋を開ける。共用端末では「この端末から消す」を使う。
 * オフラインで開けるようにするにも、鍵が手元に無いと成立しない。
 */
const KEY = 'michizure.rooms.v1'

/**
 * ⚠ `entry` ＝入口の材料（salt・反復回数・kdfVersion）。**秘密ではない。**
 * サーバーの `/salt` は認証なしで誰にでも返す（鍵を作る前に要るため）ので、
 * 端末に控えても新しく漏れるものは無い。合言葉も authKey も入らない。
 *
 * 🔴 **控えないと、圏外で人を招けない。** 招く側は毎回サーバーへ取りに行くことになり、
 * 「招かれた人は電波なしで入れる」のに「招く側は電波が要る」という裏返しが起きる
 * ——一番普通の場面（宿に着いてから誰かを招く）が、一番電波の悪い場所。
 */
type Stored = { roomId: string; token: string; encKey: string; name: string; entry?: Entry }

export function remember(s: Session, name: string, entry?: Entry): void {
  const all = rememberedAll()
  const prev = all.find((r) => r.roomId === s.roomId)
  const next = all.filter((r) => r.roomId !== s.roomId)
  next.unshift({
    roomId: s.roomId,
    token: s.token,
    encKey: toBase64(new Uint8Array(s.encKeyBits)),
    name,
    // ⚠ 渡されなければ前の控えを保つ。remember は名前の更新でも呼ばれるので、
    // 素直に上書きすると**入口の材料が黙って消える**
    entry: entry ?? prev?.entry,
  })
  localStorage.setItem(KEY, JSON.stringify(next))
}

/** 入口の材料。無ければ null（サーバーへ取りに行くしかない古い控え） */
export function rememberedEntry(roomId: string): Entry | null {
  return rememberedAll().find((r) => r.roomId === roomId)?.entry ?? null
}

/** 取りに行けた入口の材料を、後から足す（古い控えの救済＝次からは圏外でも招ける） */
export function rememberEntry(roomId: string, entry: Entry): void {
  const all = rememberedAll()
  const hit = all.find((r) => r.roomId === roomId)
  if (!hit) return
  hit.entry = entry
  localStorage.setItem(KEY, JSON.stringify(all))
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
