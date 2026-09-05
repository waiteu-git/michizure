import { describe, it, expect } from 'vitest'
import { merge3, sameBooking } from '../src/client/merge'
import type { Booking, RoomState } from '../src/client/api'

const M = [
  { id: 'a', name: '山田' },
  { id: 'b', name: '鈴木' },
]

function bk(over: Partial<Booking> & { id: string }): Booking {
  return {
    category: '食費',
    description: '',
    payer: 'a',
    amount: 1000,
    participants: ['a', 'b'],
    paid: {},
    ...over,
  }
}

function st(bookings: Booking[], over: Partial<RoomState> = {}): RoomState {
  return { name: '旅', startDate: null, endDate: null, members: M, bookings, ...over }
}

const ids = (s: RoomState) => s.bookings.map((b) => b.id).sort()

describe('3方向マージ', () => {
  /**
   * 🔴 設計 §9 の約束そのもの。ここが通らないと、圏外で二人が
   * 別々の記録を足しただけで「どちらを消すか」を聞かれる。
   */
  it('別々の記録を足しただけなら、両方残って衝突しない', () => {
    const base = st([bk({ id: '1' })])
    const mine = st([bk({ id: '1' }), bk({ id: '2', description: '居酒屋' })])
    const theirs = st([bk({ id: '1' }), bk({ id: '3', description: 'タクシー' })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(ids(r.state)).toEqual(['1', '2', '3'])
  })

  it('土台が空でも、両方の追加が並ぶ', () => {
    const base = st([])
    const r = merge3(base, st([bk({ id: '1' })]), st([bk({ id: '2' })]))
    expect(r.conflicts).toHaveLength(0)
    expect(ids(r.state)).toEqual(['1', '2'])
  })

  it('相手だけが直した記録は、相手の版になる', () => {
    const base = st([bk({ id: '1', amount: 1000 })])
    const mine = st([bk({ id: '1', amount: 1000 })])
    const theirs = st([bk({ id: '1', amount: 2000 })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(r.state.bookings[0].amount).toBe(2000)
  })

  it('自分だけが直した記録は、自分の版のまま', () => {
    const base = st([bk({ id: '1', amount: 1000 })])
    const mine = st([bk({ id: '1', amount: 3000 })])
    const theirs = st([bk({ id: '1', amount: 1000 })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(r.state.bookings[0].amount).toBe(3000)
  })

  it('同じ1件を双方が別々に直したときだけ衝突する', () => {
    const base = st([bk({ id: '1', amount: 1000 })])
    const mine = st([bk({ id: '1', amount: 3000 })])
    const theirs = st([bk({ id: '1', amount: 2000 })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].mine?.amount).toBe(3000)
    expect(r.conflicts[0].theirs?.amount).toBe(2000)
    // 衝突した1件はマージ結果に入れない（利用者が選ぶまで決めない）
    expect(ids(r.state)).toEqual([])
  })

  it('偶然おなじ内容に直していたら衝突しない', () => {
    const base = st([bk({ id: '1', amount: 1000 })])
    const mine = st([bk({ id: '1', amount: 2000 })])
    const theirs = st([bk({ id: '1', amount: 2000 })])
    expect(merge3(base, mine, theirs).conflicts).toHaveLength(0)
  })

  it('相手が消し、自分が触っていなければ消える', () => {
    const base = st([bk({ id: '1' }), bk({ id: '2' })])
    const mine = st([bk({ id: '1' }), bk({ id: '2' })])
    const theirs = st([bk({ id: '1' })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(ids(r.state)).toEqual(['1'])
  })

  it('相手が消し、自分が直していたら衝突として出す（黙って消さない）', () => {
    const base = st([bk({ id: '1', amount: 1000 })])
    const mine = st([bk({ id: '1', amount: 5000 })])
    const theirs = st([])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].theirs).toBeNull()
  })

  /**
   * ⚠ ここが「論理和で畳まない」の実効。
   * 片方が外したチェックが、もう片方の版から黙って戻ってこないこと。
   */
  it('自分が外した支払い済みチェックが、相手の版から戻ってこない', () => {
    const base = st([bk({ id: '1', paid: { b: true } })])
    const mine = st([bk({ id: '1', paid: {} })]) // 自分が外した
    const theirs = st([bk({ id: '1', paid: { b: true } })]) // 相手は触っていない
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(r.state.bookings[0].paid).toEqual({})
  })

  it('参加者の並びが違うだけなら「変えた」と見なさない', () => {
    const base = st([bk({ id: '1', participants: ['a', 'b'] })])
    const mine = st([bk({ id: '1', participants: ['b', 'a'] })])
    const theirs = st([bk({ id: '1', amount: 9999 })])
    const r = merge3(base, mine, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(r.state.bookings[0].amount).toBe(9999)
  })
})

describe('メンバーの併合', () => {
  it('別々に足したメンバーが両方残る', () => {
    const base = st([], { members: [M[0]] })
    const mine = st([], { members: [M[0], { id: 'x', name: '佐藤' }] })
    const theirs = st([], { members: [M[0], { id: 'y', name: '高橋' }] })
    const r = merge3(base, mine, theirs)
    expect(r.state.members.map((m) => m.id)).toEqual(['a', 'x', 'y'])
  })

  it('相手だけが名前を直したら相手の版になる', () => {
    const base = st([], { members: [{ id: 'a', name: '山田' }] })
    const mine = st([], { members: [{ id: 'a', name: '山田' }] })
    const theirs = st([], { members: [{ id: 'a', name: 'やまだ' }] })
    expect(merge3(base, mine, theirs).state.members[0].name).toBe('やまだ')
  })

  it('相手が消したが自分が直したメンバーは残す（消えたものは戻せない）', () => {
    const base = st([], { members: [{ id: 'a', name: '山田' }] })
    const mine = st([], { members: [{ id: 'a', name: '山田太郎' }] })
    const theirs = st([], { members: [] })
    expect(merge3(base, mine, theirs).state.members.map((m) => m.id)).toEqual(['a'])
  })
})

describe('内容の同一判定', () => {
  it('参加者と支払い済みは順序を無視する', () => {
    expect(sameBooking(bk({ id: '1', participants: ['a', 'b'], paid: { a: true, b: true } }), bk({ id: '1', participants: ['b', 'a'], paid: { b: true, a: true } }))).toBe(true)
  })
  it('金額が違えば別物', () => {
    expect(sameBooking(bk({ id: '1', amount: 1 }), bk({ id: '1', amount: 2 }))).toBe(false)
  })
  it('片方が無ければ別物', () => {
    expect(sameBooking(bk({ id: '1' }), null)).toBe(false)
  })
})
