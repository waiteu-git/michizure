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
    const share = sharesOf(b.amount, pl, b.id)
    for (const id of pl) {
      if (id === b.payer) continue
      if (b.paid?.[id]) continue
      const s = share.get(id)!
      remaining.set(b.payer, (remaining.get(b.payer) ?? 0) + s)
      remaining.set(id, (remaining.get(id) ?? 0) - s)
    }
  }
  return remaining
}

/** 文字列から安定した数を作る（端末や再読み込みで変わらないことだけが要件） */
function stableHash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 🔴 金額を参加者へ **円単位の整数** で配る。**合計は必ず金額に一致する。**
 *
 * 円は割り切れない。100円を3人なら 33.333…で、これを小数のまま持ち回ると
 * **表示と送金がそれぞれ独立に四捨五入され、食い違う**。
 * 実際そうなっていた（2026-09-05 の監査で発見）＝集計は 67/−33/−33 と出るのに
 * 送金は 33+33=66 で、**指示どおり払っても1円足りない**。
 * ⇒ 端数は最初にここで配り切る。以降どこにも小数が出ないので、四捨五入も起きない。
 *
 * ⚠ 端数を負う人は **予約ごとにずらす**（予約IDから決める）。
 * 常に先頭の人に寄せると、同じ人が毎回1円多く払う。
 * 予約IDは端末間で同じなので、**誰の画面でも同じ配り方**になる（同期の前提を壊さない）。
 */
export function sharesOf(amount: number, participants: string[], bookingId: string): Map<string, number> {
  const n = participants.length
  const out = new Map(participants.map((id) => [id, 0]))
  if (n === 0) return out
  // 円未満は扱わない。入力欄は整数を想定しているが、過去データに小数があっても壊さない
  const total = Math.round(amount)
  const base = Math.trunc(total / n)
  const rest = total - base * n // 符号は total と同じ。|rest| < n
  for (const id of participants) out.set(id, base)
  const step = rest > 0 ? 1 : -1
  const start = stableHash(bookingId) % n
  for (let k = 0; k < Math.abs(rest); k++) {
    const id = participants[(start + k) % n]
    out.set(id, out.get(id)! + step)
  }
  return out
}

/**
 * 端数を誰が負うかを、表示のために取り出す。
 *
 * ⚠ 「1円多い人」を**旅を通して集計してはいけない**。担い手は予約IDから決まる
 * 疑似乱数なので、3件続けて同じ人に当たることが普通に起きる。集計を出すと
 * 「+3円 / −1円」のような表になり、**公平に配っているのに不公平に見える**。
 * 出してよいのは1件ごとの事実だけ。
 */
export function shareSummary(
  amount: number,
  participants: string[],
  bookingId: string,
): { base: number; delta: number; bearers: string[] } {
  const n = participants.length
  if (n === 0) return { base: 0, delta: 0, bearers: [] }
  const shares = sharesOf(amount, participants, bookingId)
  // ⚠ 基準は sharesOf と同じ計算で出す。「最頻値」にしてはいけない＝
  // 余りが人数の半分を超えた瞬間に多数派と少数派が入れ替わり、
  // 101円を3人（34/34/33）で「基準34・1円**少ない**人」と反転する（テストで捕まえた）。
  // 利用者にとって意味があるのは常に「端数を**負う**人」なので、切り捨てを基準に固定する。
  const base = Math.trunc(Math.round(amount) / n)
  const bearers = [...shares].filter(([, v]) => v !== base).map(([id]) => id)
  const delta = bearers.length ? (shares.get(bearers[0]) ?? base) - base : 0
  return { base, delta, bearers }
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
  // ⚠ 0.5 にすること。1 だと **ちょうど1円の送金が落ちる**（`a > eps` が偽になる）。
  // 残高は整数になったので、ここで落ちてよいのは「小数の残りかす」だけ
  const eps = 0.5
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
