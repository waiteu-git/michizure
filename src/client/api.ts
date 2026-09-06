import { deriveKeys, toBase64 } from '../keys.ts'
import { seal, open } from '../box.ts'
import { KDF_VERSION } from '../types.ts'
import { getApiBase } from './config.ts'
import { PBKDF2_ITERATIONS } from '../keys.ts'

export type RoomState = {
  name: string
  startDate: string | null
  endDate: string | null
  members: { id: string; name: string }[]
  bookings: Booking[]
}

export type Booking = {
  id: string
  category: string
  description: string
  payer: string
  amount: number
  participants: string[]
  paid: Record<string, boolean>
}

export type Session = { roomId: string; token: string; encKeyBits: ArrayBuffer }

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export function emptyState(name: string): RoomState {
  return { name, startDate: null, endDate: null, members: [], bookings: [] }
}

/** 部屋を作る。⚠ 合言葉もその平文もサーバーへは送らない */
export async function createRoom(
  passphrase: string,
  state: RoomState,
): Promise<Session & { salt: string }> {
  const salt = generateSaltB64()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, PBKDF2_ITERATIONS)
  const blob = { ...(await seal(encKeyBits, state)), blobVersion: 1 }
  const res = await fetch(`${getApiBase()}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      salt,
      authKey,
      blob,
      iterations: PBKDF2_ITERATIONS,
      kdfVersion: KDF_VERSION,
    }),
  })
  const { roomId, token } = await json<{ roomId: string; token: string }>(res)
  return { roomId, token, encKeyBits, salt }
}

function generateSaltB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

/**
 * 合言葉で入室する。
 * ⚠ 鍵は**その部屋が作られた時の反復回数と正規化規則**でしか再現しない。
 * 既定値ではなくサーバーが返した値を使う（設計 §7.6.1 ④）。
 */
/**
 * 部屋の入口の情報（salt・反復回数・正規化の版）。**認証は要らない。**
 *
 * 圏外入室券（設計 §9.1）を後から作り直すのに使う。作った直後の画面を離れると
 * 券の材料が手元から消えるが、旅の途中で人を招く場面のほうが普通なので、
 * ここから取り直せる必要がある。
 * ⚠ **通信が要る**＝圏外では券を作れない。招くのは宿など電波のある場所を想定。
 */
export async function roomEntry(
  roomId: string,
): Promise<{ salt: string; iterations: number; kdfVersion: number }> {
  return json(await fetch(`${getApiBase()}/api/rooms/${roomId}/salt`))
}

export async function enterRoom(roomId: string, passphrase: string): Promise<Session> {
  const meta = await json<{ salt: string; iterations: number; kdfVersion: number }>(
    await fetch(`${getApiBase()}/api/rooms/${roomId}/salt`),
  )
  const { authKey, encKeyBits } = await deriveKeys(
    passphrase,
    meta.salt,
    meta.iterations,
    meta.kdfVersion,
  )
  const { token } = await json<{ token: string }>(
    await fetch(`${getApiBase()}/api/rooms/${roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey }),
    }),
  )
  return { roomId, token, encKeyBits }
}

export async function loadState(s: Session): Promise<RoomState> {
  const blob = await json<{ ciphertext: string; iv: string }>(
    await fetch(`${getApiBase()}/api/rooms/${s.roomId}/blob`, { headers: { Authorization: `Bearer ${s.token}` } }),
  )
  return open<RoomState>(s.encKeyBits, blob.ciphertext, blob.iv)
}

export async function saveState(s: Session, state: RoomState, clientId = ''): Promise<void> {
  const blob = { ...(await seal(s.encKeyBits, state)), blobVersion: 1 }
  await json(
    await fetch(`${getApiBase()}/api/rooms/${s.roomId}/blob`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${s.token}`,
        'Content-Type': 'application/json',
        // 書いた本人へ中継し返さないための識別子。中身には関与しない
        'X-Client-Id': clientId,
      },
      body: JSON.stringify(blob),
    }),
  )
}

/** 受け取った暗号文を復号する（WebSocket で届いたものを取り込むのに使う） */
export async function decryptBlob(
  s: Session,
  blob: { ciphertext: string; iv: string },
): Promise<RoomState> {
  return open<RoomState>(s.encKeyBits, blob.ciphertext, blob.iv)
}

export async function deleteRoom(roomId: string, passphrase: string): Promise<void> {
  const meta = await json<{ salt: string; iterations: number; kdfVersion: number }>(
    await fetch(`${getApiBase()}/api/rooms/${roomId}/salt`),
  )
  const { authKey } = await deriveKeys(passphrase, meta.salt, meta.iterations, meta.kdfVersion)
  await json(
    await fetch(`${getApiBase()}/api/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey }),
    }),
  )
}
