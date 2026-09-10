import { deriveKeys, toBase64 } from '../keys.ts'
import { seal, open } from '../box.ts'
import { KDF_VERSION } from '../types.ts'
import { getApiBase } from './config.ts'
import type { Entry } from './entry.ts'
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
): Promise<Session & { salt: string; rev: number }> {
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
  const { roomId, token, rev } = await json<{ roomId: string; token: string; rev: number }>(res)
  return { roomId, token, encKeyBits, salt, rev }
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

/**
 * ⚠ 入口の材料（`entry`）も返す。**呼び出し側はこれを端末に控える。**
 * 控えないと、後から人を招く時に毎回サーバーへ取りに行くことになり、
 * **圏外では招けない**——圏外入室券の意味が半分無くなる（設計 §9.1）。
 */
export async function enterRoom(
  roomId: string,
  passphrase: string,
): Promise<{ session: Session; entry: Entry }> {
  const meta = await json<Entry>(await fetch(`${getApiBase()}/api/rooms/${roomId}/salt`))
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
  return { session: { roomId, token, encKeyBits }, entry: meta }
}

/**
 * 🔴 **部屋がサーバーから消えている。通信の失敗とは別物。**
 *
 * 以前は 404 も「繋がらない」と同じに扱っていたので、削除済みの部屋を開いた端末は
 * 「未同期」のまま繋ぎ直しを続け、**以後足した記録はどこにも届かなかった**。しかも本人は
 * 削除されたことを一度も知らされず、「この端末から消す」を押すきっかけが来なかった
 * （2026-09-10 の PP×実装の監査で指摘。PP の「削除済みは見つかりませんと出る」とも食い違っていた）。
 * ⚠ 正しいトークンで叩いた /blob が 404 なら、それは部屋が無いということ（トークンが違えば 401）。
 */
export class RoomGoneError extends Error {
  constructor() {
    super('room_gone')
    this.name = 'RoomGoneError'
  }
}

/**
 * 🔴 **接続用のトークンが断られた。通信の失敗とは別物。**
 *
 * 主な原因は30日の期限切れ（`TOKEN_TTL_MS`）。署名の鍵を入れ替えた時も同じ形になる。
 * どちらも**送り直しても直らない**。直すには合言葉で入り直すしかない（`authKey` は端末に
 * 保存しない設計＝設計 §9 の「30日で再認証」）。
 * 以前は 401 も「繋がらない」と同じに扱っていたので、30日経った端末は「未同期」のまま
 * 黙って止まり、以後足した記録はどこにも届かなかった（2026-09-11 に発見）。
 */
export class TokenRejectedError extends Error {
  constructor() {
    super('token_rejected')
    this.name = 'TokenRejectedError'
  }
}

/**
 * ⚠ **当サービスが断ったと分かる 401 だけ**をトークンの失効と見なす（本文の error まで見る）。
 * 途中の何か（ログイン画面を挟む網など）が返した 401 まで失効扱いすると、
 * 直せない理由で入り直しを求めることになる。
 */
async function tokenRejected(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  const body = (await res.clone().json().catch(() => null)) as { error?: string } | null
  return body?.error === 'unauthorized'
}

/** サーバーから取ってきた中身と、その版 */
export type Loaded = { state: RoomState; rev: number }

/**
 * 🔴 サーバーが先に進んでいた＝**上書きしてはいけない**。
 * 呼び出し側は取り込み直して（3方向マージして）から送り直す。
 */
export class StaleError extends Error {
  constructor(readonly rev: number) {
    super('stale')
    this.name = 'StaleError'
  }
}

export async function loadState(s: Session): Promise<Loaded> {
  const res = await fetch(`${getApiBase()}/api/rooms/${s.roomId}/blob`, {
    headers: { Authorization: `Bearer ${s.token}` },
  })
  if (res.status === 404) throw new RoomGoneError()
  if (await tokenRejected(res)) throw new TokenRejectedError()
  const blob = await json<{ ciphertext: string; iv: string; rev: number }>(res)
  return { state: await open<RoomState>(s.encKeyBits, blob.ciphertext, blob.iv), rev: blob.rev }
}

/**
 * サーバーへ書く。**基にした版（baseRev）を必ず添える。**
 *
 * ⚠ 添えないと、あるいは古い版を添えると、サーバーは 409 で断る。それが正しい
 * ——断られずに通ると、同時に電波が戻った相手の記録を黙って消す。
 */
export async function saveState(
  s: Session,
  state: RoomState,
  clientId = '',
  baseRev = 0,
): Promise<number> {
  const blob = { ...(await seal(s.encKeyBits, state)), blobVersion: 1, baseRev }
  const res = await fetch(`${getApiBase()}/api/rooms/${s.roomId}/blob`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${s.token}`,
      'Content-Type': 'application/json',
      // 書いた本人へ中継し返さないための識別子。中身には関与しない
      'X-Client-Id': clientId,
    },
    body: JSON.stringify(blob),
  })
  if (res.status === 409) {
    const body = (await res.json()) as { rev?: number }
    throw new StaleError(body.rev ?? 0)
  }
  if (res.status === 404) throw new RoomGoneError()
  if (await tokenRejected(res)) throw new TokenRejectedError()
  return (await json<{ rev: number }>(res)).rev
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
