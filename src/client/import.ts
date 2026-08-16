import type { Booking, RoomState } from './api.ts'

/**
 * 前身アプリ（travel-calculation）が書き出した JSON を Michizure の形へ変換する。
 *
 * ⚠ **前身アプリには一切触れない。** 読むのは「利用者が自分でエクスポートしたファイル」だけ。
 *
 * 🔴 唯一にして最大の変換＝**メンバーの識別が「名前」から「id」へ変わる**（設計 §6）。
 * 前身は payer / participants / paid のキーに**名前そのもの**を使っていた。
 * ここを取り違えると、金額の割り当てが静かにずれる。
 *
 * ⚠ 入力は利用者のファイル＝**壊れていることを前提に読む**。
 * 落とすときは黙って落とさず、何を落としたか呼び出し側へ返す。
 */

/** 前身が書き出す形（`{state, nextId}`）。全ての項目が欠けうる前提で受ける */
type LegacyFile = {
  state?: {
    members?: unknown
    bookings?: unknown
  }
}

export type ImportResult = {
  state: RoomState
  /** 利用者に見せる注記。**黙って捨てない**ための記録 */
  notes: string[]
}

const uuid = () => crypto.randomUUID()

export class ImportError extends Error {}

/** 前身のファイル1つを RoomState に変換する。壊れていれば ImportError を投げる */
export function convertLegacy(raw: unknown, tripName: string): ImportResult {
  const file = raw as LegacyFile
  const legacy = file?.state
  if (!legacy || typeof legacy !== 'object') {
    throw new ImportError('前のアプリのファイルではないようです（state がありません）')
  }

  const notes: string[] = []

  // --- メンバー: 名前 → id ---
  const idOf = new Map<string, string>()
  const members: { id: string; name: string }[] = []
  const addMember = (name: string): string => {
    const key = name.trim()
    if (!key) return ''
    const hit = idOf.get(key)
    if (hit) return hit
    const id = uuid()
    idOf.set(key, id)
    members.push({ id, name: key })
    return id
  }

  const rawMembers = Array.isArray(legacy.members) ? legacy.members : []
  for (const m of rawMembers) {
    if (typeof m === 'string') addMember(m)
  }
  if (rawMembers.length !== members.length) {
    notes.push(`メンバー一覧のうち ${rawMembers.length - members.length} 件は名前として読めませんでした`)
  }

  // --- 記録 ---
  const rawBookings = Array.isArray(legacy.bookings) ? legacy.bookings : []
  const bookings: Booking[] = []
  let skipped = 0
  const addedByBooking = new Set<string>()

  for (const b of rawBookings) {
    const rec = b as Record<string, unknown>
    if (!rec || typeof rec !== 'object') {
      skipped++
      continue
    }
    const amount = Number(rec.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      skipped++
      continue
    }
    const payerName = typeof rec.payer === 'string' ? rec.payer.trim() : ''
    if (!payerName) {
      skipped++
      continue
    }
    // ⚠ メンバー一覧に無い名前でも**捨てずに足す**。
    // 捨てると立替が消えて、他の人の負担が静かに増える
    if (!idOf.has(payerName)) addedByBooking.add(payerName)
    const payer = addMember(payerName)

    const rawParts = Array.isArray(rec.participants) ? rec.participants : []
    const participants: string[] = []
    for (const p of rawParts) {
      if (typeof p !== 'string' || !p.trim()) continue
      if (!idOf.has(p.trim())) addedByBooking.add(p.trim())
      participants.push(addMember(p))
    }

    const paid: Record<string, boolean> = {}
    const rawPaid = rec.paid
    if (rawPaid && typeof rawPaid === 'object' && !Array.isArray(rawPaid)) {
      for (const [name, on] of Object.entries(rawPaid as Record<string, unknown>)) {
        const id = idOf.get(name.trim())
        // 支払い済みの印は、対象者として残っている人の分だけ引き継ぐ。
        // 対象に居ない人の印を残すと「もう払った人」として精算から抜け落ちる
        if (id && on) paid[id] = true
      }
    }

    bookings.push({
      // 前身は連番。オフラインで採番すると必ず衝突するので UUID にする（設計 §6）
      id: uuid(),
      category: typeof rec.category === 'string' ? rec.category : 'その他',
      description: typeof rec.description === 'string' ? rec.description : '',
      payer,
      amount,
      // 空なら「全員」を意味する（前身と同じ扱い。settle 側でも全員へフォールバックする）
      participants,
      paid,
    })
  }

  if (skipped > 0) notes.push(`金額や立替者が読めない記録を ${skipped} 件とばしました`)
  if (addedByBooking.size > 0) {
    notes.push(
      `メンバー一覧に無かった ${addedByBooking.size} 人を追加しました（${[...addedByBooking].join('・')}）`,
    )
  }
  if (bookings.length === 0 && members.length === 0) {
    throw new ImportError('読み込めるデータがありませんでした')
  }

  return {
    state: { name: tripName, startDate: null, endDate: null, members, bookings },
    notes,
  }
}
