import type { Booking, RoomState } from './api.ts'

type Member = RoomState['members'][number]

/**
 * 3方向マージ。**追加はぶつからない。ぶつかるのは「同じ1件を両方が直した」時だけ。**
 *
 * 設計 §9 はこう約束している:
 *   - 追加: 衝突しない（UUID のため）。そのまま適用
 *   - 編集・削除: 対象がサーバー側で変更されていた場合、ユーザーに提示する
 *
 * 実装は長らくこれを守っておらず、**状態全体のハッシュ**を比べていた。結果、
 * 圏外で二人が【別々の記録を足しただけ】で「どちらを消すか」を突きつけていた
 * ——旅先で最も普通に起きることに、最も重い罰を与えていたことになる。
 *
 * ⚠ **土台（base）が無い時はマージしない。** 共通の祖先が分からなければ
 * 「誰が何を変えたか」は原理的に決まらない。無い時は呼び出し側が
 * 従来どおり利用者に丸ごと選ばせる。**土台を捏造しないこと。**
 *
 * ⚠ `paid` のような欄を論理和で畳まないこと。畳むと「一度外したチェックが
 * 相手の版から戻ってくる」＝利用者の操作が黙って取り消される。
 * 件単位で衝突として出せば、この問題は起きない。
 */

export type BookingConflict = { base: Booking | null; mine: Booking | null; theirs: Booking | null }

export type Merged = {
  state: RoomState
  /** 同じ1件を双方が別々に直した予約。呼び出し側が利用者に選ばせる */
  conflicts: BookingConflict[]
}

function byId<T extends { id: string }>(xs: T[]): Map<string, T> {
  return new Map(xs.map((x) => [x.id, x]))
}

/** 予約が「同じ内容か」。⚠ 参加者と支払い済みは順序に意味が無いので揃えてから比べる */
export function sameBooking(a: Booking | null, b: Booking | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // ⚠ キーの有無で比べてはいけない。`paid` は Record<string, boolean> なので
  // `{ b: false }` というキーが在りうる＝「外したチェック」をキーの存在だけで見ると
  // 「付いている」と誤判定する。**真の値を持つキーだけ**を比べる
  const keys = (o: Record<string, boolean> | undefined) =>
    Object.entries(o ?? {}).filter(([, v]) => v).map(([k]) => k).sort().join(' ')
  return (
    a.category === b.category &&
    a.description === b.description &&
    a.payer === b.payer &&
    a.amount === b.amount &&
    [...a.participants].sort().join(' ') === [...b.participants].sort().join(' ') &&
    keys(a.paid) === keys(b.paid)
  )
}

/**
 * メンバーの併合。並びは自分の版を基準にし、相手だけが足した人を後ろへ足す。
 * ⚠ 「消し」と「直し」がぶつかったら**残す側へ倒す**（消えたものは戻せないため）。
 */
function mergeMembers(base: Member[], mine: Member[], theirs: Member[]): Member[] {
  const b = byId(base)
  const t = byId(theirs)
  const out: Member[] = []
  const seen = new Set<string>()

  for (const x of mine) {
    const base0 = b.get(x.id)
    const their = t.get(x.id)
    const iChanged = base0 ? base0.name !== x.name : true

    if (!base0) {
      out.push(x) // 自分が足した人
    } else if (their) {
      out.push(!iChanged ? their : x) // 自分が触っていなければ相手の名前を採る
    } else if (iChanged) {
      out.push(x) // 相手が消したが自分が直した ⇒ 残す
    } else {
      continue // 相手が消し、自分は触っていない ⇒ 消す
    }
    seen.add(x.id)
  }

  for (const x of theirs) if (!seen.has(x.id) && !b.has(x.id)) out.push(x)
  return out
}

/** 双方が変えていたら自分の版を残す（利用者の目の前に在るのは自分の版） */
function pick<T>(base: T, mine: T, theirs: T): T {
  return base === mine ? theirs : mine
}

export function merge3(base: RoomState, mine: RoomState, theirs: RoomState): Merged {
  const bb = byId(base.bookings)
  const mb = byId(mine.bookings)
  const tb = byId(theirs.bookings)
  const ids = [...new Set([...mine.bookings.map((x) => x.id), ...theirs.bookings.map((x) => x.id)])]

  const bookings: Booking[] = []
  const conflicts: BookingConflict[] = []

  for (const id of ids) {
    const b = bb.get(id) ?? null
    const m = mb.get(id) ?? null
    const t = tb.get(id) ?? null

    if (!b) {
      // 土台に無い＝どちらかの新規追加。**これは衝突ではない**
      if (m && t) {
        if (sameBooking(m, t)) bookings.push(m)
        // 同じ UUID で別内容は本来起きない。起きたら黙って選ばず利用者に出す
        else conflicts.push({ base: null, mine: m, theirs: t })
      } else if (m ?? t) {
        bookings.push((m ?? t)!)
      }
      continue
    }

    const iChanged = !sameBooking(b, m)
    const theyChanged = !sameBooking(b, t)

    if (!iChanged && !theyChanged) {
      if (m) bookings.push(m)
    } else if (iChanged && !theyChanged) {
      if (m) bookings.push(m) // 自分だけが変えた（消しも含む）
    } else if (!iChanged && theyChanged) {
      if (t) bookings.push(t) // 相手だけが変えた
    } else if (sameBooking(m, t)) {
      if (m) bookings.push(m) // 偶然おなじ結論になった
    } else {
      conflicts.push({ base: b, mine: m, theirs: t }) // 本当の衝突
    }
  }

  return {
    state: {
      name: pick(base.name, mine.name, theirs.name),
      startDate: pick(base.startDate, mine.startDate, theirs.startDate),
      endDate: pick(base.endDate, mine.endDate, theirs.endDate),
      members: mergeMembers(base.members, mine.members, theirs.members),
      bookings,
    },
    conflicts,
  }
}
