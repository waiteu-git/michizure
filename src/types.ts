export const MAX_MEMBERS = 20 // クライアント側でのみ強制する。サーバーは検証できない

/**
 * サーバー側の唯一の防御（設計 §7.4）。**復号後の暗号文のバイト数**の上限。
 *
 * ⚠ `ciphertext` は base64 の【文字列】なので、`ciphertext.length` をこの値と
 * 直接比べてはいけない。base64 は 3 バイトを 4 文字にするため、文字数で切ると
 * 実際の上限が 3/4（＝192KiB）に縮み、spec の 256KB と静かにズレる。
 * 比較には必ず ciphertextBytes() を使う。
 */
export const MAX_CIPHERTEXT_BYTES = 256 * 1024

/** base64 文字列が表す復号後のバイト数。サイズ上限の判定にだけ使う（厳密さは不要） */
export function ciphertextBytes(ciphertext: string): number {
  const padding = ciphertext.endsWith('==') ? 2 : ciphertext.endsWith('=') ? 1 : 0
  return Math.floor((ciphertext.length * 3) / 4) - padding
}

/**
 * 本文そのものの足切り。巨大な本文を JSON.parse しないための安い防御で、
 * 上の上限より必ず緩くする（ここで先に弾くと上限の意味が変わってしまう）。
 * 256KiB のバイト列は base64 で約 341KiB になるため、その上に余裕を取る。
 */
export const MAX_REQUEST_BYTES = 512 * 1024

/** 96bit の IV は base64 で16文字。将来の方式変更を見込んでも64文字あれば足りる */
export const MAX_IV_CHARS = 64

/**
 * 暗号文の「形」だけを見る。中身は読まない・読めない。
 * ⚠ ciphertext だけを見ていると iv など他のフィールドが素通りし、
 * サイズ上限をすり抜けて保存されてしまう。
 */
export function blobShapeInvalid(blob: unknown): boolean {
  const b = blob as Blob | undefined
  if (!b || typeof b.ciphertext !== 'string' || typeof b.iv !== 'string') return true
  if (b.iv.length > MAX_IV_CHARS) return true
  return false
}
export const ROOM_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 最終アクセスから1年
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30日

/** サーバーが保持する暗号文。サーバーはこの中身を読めない */
export interface Blob {
  ciphertext: string
  iv: string
  blobVersion: number
}

/** サーバーが保持する平文のメタデータ */
export interface RoomMeta {
  roomId: string
  createdAt: number
  lastAccessAt: number
  schemaVersion: number
}

// --- 以下はクライアントだけが扱う。サーバーには平文で渡らない ---

export interface Member {
  id: string
  name: string
}

export interface Booking {
  id: string // クライアント生成の UUID
  category: string
  description: string
  payer: string // Member.id
  amount: number
  participants: string[] // Member.id[]
  paid: Record<string, true>
}

export interface RoomState {
  name: string
  startDate: string | null
  endDate: string | null
  members: Member[]
  bookings: Booking[]
}

export type ClientMessage = { type: 'update'; blob: Blob }
export type ServerMessage =
  | { type: 'init'; blob: Blob | null }
  | { type: 'update'; blob: Blob }
  | { type: 'error'; code: string }
