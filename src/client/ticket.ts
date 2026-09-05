import type { RoomState } from './api.ts'
import { toUrlSafe, fromUrlSafe } from './entry.ts'
import { sealBytes, openBytes } from '../box.ts'
import { deriveKeys } from '../keys.ts'

/**
 * 圏外入室券（設計 §9.1）。**暗号文を手渡して、サーバーに触れずに入室する。**
 *
 * 券に入るのは salt・反復回数・kdfVersion・iv・暗号文だけで、**合言葉は入らない**。
 * 受け取った人は必ず5語を別経路（声・別のメッセージ）で聞く必要がある。
 * ⇒ 設計 §7.6.1 ② の「リンク1本で部屋が開く状態を作らない」は保たれる。
 *
 * ⚠ URL のフラグメント（`#` 以降）に載せる。フラグメントは**サーバーへ送られない**ので、
 * 券を開いた事実も中身もサーバーには渡らない。
 */

/**
 * ファイル渡し（中身入りの券）の上限。QR ではなくファイルなので余裕がある。
 * サーバー側の暗号文上限（設計 §7.4 の 256KB）より小さければよい。
 */
export const MAX_FILE_TICKET_BYTES = 200_000

export type Ticket = {
  salt: string
  iterations: number
  kdfVersion: number
  iv: string
  ciphertext: string
}

/**
 * 🔴 **券に載せる前に平文を縮める。暗号文は縮まない。**
 *
 * 素の RoomState は UUID だらけで、6人の旅行なら参加者欄だけで1件216バイトになる。
 * 実測（2026-09-06）: 10件の部屋が素の JSON で 4,502 B ＝ QR に入らない。
 * 索引化（メンバーIDを 0..n の番号へ）＋ deflate で 770 B まで落ちる。
 *
 * ⚠ **予約の id は落とさない。** 受け取った側が id を作り直すと、後で電波が戻って
 * 合流した時に**同じ記録が二重になる**（3方向マージは id で同一性を見る）。
 * id は 16バイトの生値として持ち、圧縮に任せる。
 */
type Compact = {
  n: string
  s: string | null
  e: string | null
  /** [名前, id16バイト] */
  m: [string, number[]][]
  /** [id16バイト, 種別, 内容, 立替者の番号, 金額, 参加者の番号[], 支払済の番号[]] */
  b: [number[], string, string, number, number, number[], number[]][]
}

const hex = (n: number) => n.toString(16).padStart(2, '0')

function uuidToBytes(u: string): number[] {
  const h = u.replace(/-/g, '')
  return Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16))
}

function bytesToUuid(b: number[]): string {
  const h = b.map(hex).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function compactState(st: RoomState): Compact {
  const idx = new Map(st.members.map((m, i) => [m.id, i]))
  return {
    n: st.name,
    s: st.startDate,
    e: st.endDate,
    m: st.members.map((m) => [m.name, uuidToBytes(m.id)]),
    b: st.bookings.map((b) => [
      uuidToBytes(b.id),
      b.category,
      b.description,
      idx.get(b.payer) ?? -1,
      b.amount,
      b.participants.map((p) => idx.get(p) ?? -1).filter((i) => i >= 0),
      Object.entries(b.paid ?? {})
        .filter(([, v]) => v)
        .map(([p]) => idx.get(p) ?? -1)
        .filter((i) => i >= 0),
    ]),
  }
}

export function expandState(c: Compact): RoomState {
  const members = c.m.map(([name, id]) => ({ id: bytesToUuid(id), name }))
  const at = (i: number) => members[i]?.id ?? ''
  return {
    name: c.n,
    startDate: c.s,
    endDate: c.e,
    members,
    bookings: c.b.map(([id, category, description, payer, amount, parts, paid]) => ({
      id: bytesToUuid(id),
      category,
      description,
      payer: at(payer),
      amount,
      participants: parts.map(at).filter(Boolean),
      paid: Object.fromEntries(paid.map((i) => [at(i), true as const])),
    })),
  }
}

async function through(
  stream: CompressionStream | DecompressionStream,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const w = stream.writable.getWriter()
  void w.write(bytes)
  void w.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/** 縮める。⚠ 暗号化の【前】に呼ぶこと（暗号文は縮まない） */
export async function deflate(st: RoomState): Promise<Uint8Array<ArrayBuffer>> {
  // ⚠ TextEncoder().encode() の型は ArrayBufferLike なので、明示的に締める
  const json = new TextEncoder().encode(JSON.stringify(compactState(st))) as Uint8Array<ArrayBuffer>
  return through(new CompressionStream('deflate-raw'), json)
}

/** 戻す。壊れていたら投げる（呼び出し側で「券ではなかった」として扱う） */
export async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<RoomState> {
  const json = await through(new DecompressionStream('deflate-raw'), bytes)
  return expandState(JSON.parse(new TextDecoder().decode(json)) as Compact)
}

/** 区切りは `.`——base64url に現れない文字なので、分解が曖昧にならない */
export function encodeTicket(t: Ticket): string {
  return [
    String(t.kdfVersion),
    String(t.iterations),
    toUrlSafe(t.salt),
    toUrlSafe(t.iv),
    toUrlSafe(t.ciphertext),
  ].join('.')
}

/** 壊れていたら null（拾った文字列を渡されうる場所なので、例外にしない） */
export function decodeTicket(s: string): Ticket | null {
  const parts = s.split('.')
  if (parts.length !== 5) return null
  const [v, iter, salt, iv, ct] = parts
  const kdfVersion = Number(v)
  const iterations = Number(iter)
  if (!Number.isInteger(kdfVersion) || !Number.isInteger(iterations)) return null
  if (!salt || !iv || !ct) return null
  return {
    kdfVersion,
    iterations,
    salt: fromUrlSafe(salt),
    iv: fromUrlSafe(iv),
    ciphertext: fromUrlSafe(ct),
  }
}

export function ticketBytes(t: Ticket): number {
  return new TextEncoder().encode(encodeTicket(t)).length
}

/** 券を含む共有 URL。⚠ フラグメントに置く（サーバーへ送らないため） */
export function ticketUrl(origin: string, roomId: string, t: Ticket): string {
  return `${origin}/r/${roomId}#t=${encodeTicket(t)}`
}

/** 中身入りの券がファイルとして扱える大きさか（QR には載せない） */
export function fitsFile(t: Ticket): boolean {
  return ticketBytes(t) <= MAX_FILE_TICKET_BYTES
}

/** URL のフラグメントから券を取り出す。無ければ null */
export function ticketFromHash(hash: string): Ticket | null {
  const m = hash.match(/[#&]t=([^&]+)/)
  return m ? decodeTicket(m[1]) : null
}

/**
 * 券を作る。**縮めてから封をする**（暗号文は縮まないので順序が重要）。
 *
 * ⚠ `seal` ではなく `sealBytes` を使う。`seal` は JSON.stringify するので、
 * 圧縮済みのバイト列を渡すと1バイト1エントリのオブジェクトに膨らむ。
 */
export async function makeTicket(
  st: RoomState,
  encKeyBits: ArrayBuffer,
  salt: string,
  iterations: number,
  kdfVersion: number,
): Promise<Ticket> {
  const packed = await deflate(st)
  const { ciphertext, iv } = await sealBytes(encKeyBits, packed)
  return { salt, iterations, kdfVersion, iv, ciphertext }
}

/**
 * 券を開く。**合言葉が違えばここで例外**（AES-GCM の認証タグ）＝
 * サーバーに一度も問い合わせずに、端末の中だけで拒否できる。
 */
export async function openTicket(t: Ticket, passphrase: string): Promise<RoomState> {
  const { encKeyBits } = await deriveKeys(passphrase, t.salt, t.iterations, t.kdfVersion)
  return inflate(await openBytes(encKeyBits, t.ciphertext, t.iv))
}


