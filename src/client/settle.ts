import type { Booking, RoomState } from './api.ts'

/**
 * 前身アプリ（travel-calculation）で実データ6人・23件により検証済みのロジックを移植した。
 *
 * ⚠ 唯一の変更点＝**メンバーの識別を名前から id へ**（設計 §6）。
 * 前身は名前を識別子にしていたため、改名すると payer / participants / paid を
 * 全部書き換える必要があった。金額の計算そのものは変えていない。
 */

/** 割り勘の対象者。未設定や不正な値のときは全員へフォールバックする（前身と同じ） */
export function parts(b: Booking, memberIds: string[]): string[] {
  const listed = Array.isArray(b.participants)
    ? b.participants.filter((id) => memberIds.includes(id))
    : []
  return listed.length ? listed : [...memberIds]
}

/** 支払者以外の対象者が全員「支払い済み」なら完了 */
export function isDone(b: Booking, memberIds: string[]): boolean {
  return parts(b, memberIds)
    .filter((id) => id !== b.payer)
    .every((id) => b.paid?.[id])
}

/**
 * 各メンバーの未精算残高。
 * ⚠ **チェックの入っていない未払い分だけ**を数える（済んだ分は残高に入れない）。
 */
export function balances(state: RoomState): Map<string, number> {
  const ids = state.members.map((m) => m.id)
  const remaining = new Map(ids.map((id) => [id, 0]))
  for (const b of state.bookings) {
    const pl = parts(b, ids)
    const share = b.amount / pl.length
    for (const id of pl) {
      if (id === b.payer) continue
      if (b.paid?.[id]) continue
      remaining.set(b.payer, (remaining.get(b.payer) ?? 0) + share)
      remaining.set(id, (remaining.get(id) ?? 0) - share)
    }
  }
  return remaining
}

/** 各メンバーの立替合計（支払った総額） */
export function advanced(state: RoomState): Map<string, number> {
  const totals = new Map(state.members.map((m) => [m.id, 0]))
  for (const b of state.bookings) {
    totals.set(b.payer, (totals.get(b.payer) ?? 0) + b.amount)
  }
  return totals
}

export type Transfer = { from: string; to: string; amount: number }

/**
 * 残高を打ち消す送金の並びを作る（貪欲法）。
 * eps=1 は「1円未満は無視する」の意味。前身と同じ値。
 */
export function settle(bals: Map<string, number>): Transfer[] {
  const eps = 1
  const pays = [...bals].filter(([, v]) => v < -eps).map(([id, v]) => ({ id, bal: v }))
  const rcvs = [...bals].filter(([, v]) => v > eps).map(([id, v]) => ({ id, bal: v }))
  const out: Transfer[] = []
  let p = 0
  let q = 0
  while (p < pays.length && q < rcvs.length) {
    const a = Math.min(-pays[p].bal, rcvs[q].bal)
    if (a > eps) out.push({ from: pays[p].id, to: rcvs[q].id, amount: Math.round(a) })
    pays[p].bal += a
    rcvs[q].bal -= a
    if (Math.abs(pays[p].bal) < eps) p++
    if (Math.abs(rcvs[q].bal) < eps) q++
  }
  return out
}
