import type { RoomState } from './api.ts'

/**
 * 🔴 **圏外入室券の「入口」だけを扱う。ここは必ず静的 import にすること。**
 *
 * 2026-09-06、実機に近い形で試して分かった: この処理を遅延 chunk に置くと、
 * **圏外で券つきURLを開いた瞬間に読み込めない**（キャッシュに無い）。
 * 圏外入室に要るコードが、それ自体を圏外で読めないという鶏と卵になる。
 * ⇒ 中身の圧縮やファイル渡し（ticket.ts）は遅延でよいが、**ここは先読みに乗せる**。
 *
 * ⚠ Service Worker の版が上がると activate が旧キャッシュを消すので、
 * 遅延で蓄えた分は更新のたびに失われる。先読みに在ることがいっそう重要。
 */

/** URL に置ける base64。`+/=` はフラグメントで扱いが揺れるので避ける */
export function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromUrlSafe(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return b64 + '='.repeat((4 - (b64.length % 4)) % 4)
}

/** 入口券。**中身（暗号文）は含まない**＝QR が小さく、実機で読める（設計 §9.1） */
export type Entry = { salt: string; iterations: number; kdfVersion: number }

export function encodeEntry(e: Entry): string {
  return [String(e.kdfVersion), String(e.iterations), toUrlSafe(e.salt)].join('.')
}

export function decodeEntry(s: string): Entry | null {
  const parts = s.split('.')
  if (parts.length !== 3) return null
  const [v, iter, salt] = parts
  const kdfVersion = Number(v)
  const iterations = Number(iter)
  if (!Number.isInteger(kdfVersion) || !Number.isInteger(iterations) || !salt) return null
  return { kdfVersion, iterations, salt: fromUrlSafe(salt) }
}

/** ⚠ フラグメント（`#`）に置く。サーバーへ送られないため */
export function entryUrl(origin: string, roomId: string, e: Entry): string {
  return `${origin}/r/${roomId}#k=${encodeEntry(e)}`
}

export function entryFromHash(hash: string): Entry | null {
  const m = hash.match(/[#&]k=([^&]+)/)
  return m ? decodeEntry(m[1]) : null
}

/**
 * 圏外入室した直後の状態。**土台は空**（＝入った人は何も持っていなかった）。
 * これは便宜ではなく実際に真の共通祖先なので、3方向マージが正しく効く。
 */
export function emptyRoomForEntry(): RoomState {
  return { name: '', startDate: null, endDate: null, members: [], bookings: [] }
}
