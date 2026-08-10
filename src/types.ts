export const MAX_MEMBERS = 20 // クライアント側でのみ強制する。サーバーは検証できない
export const MAX_BLOB_BYTES = 256 * 1024 // サーバー側の唯一の防御
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
