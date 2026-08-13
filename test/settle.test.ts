import { describe, it, expect } from 'vitest'
import { parts, isDone, balances, advanced, settle } from '../src/client/settle'
import type { RoomState, Booking } from '../src/client/api'

// 金額の計算は間違えると実害が出る。前身アプリの挙動をそのまま固定する
const members = [
  { id: 'a', name: '山田' },
  { id: 'b', name: '鈴木' },
  { id: 'c', name: '佐藤' },
]
const ids = members.map((m) => m.id)

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: 'x',
    category: '食費',
    description: '',
    payer: 'a',
    amount: 3000,
    participants: ['a', 'b', 'c'],
    paid: {},
    ...over,
  }
}

function state(bookings: Booking[]): RoomState {
  return { name: 'T', startDate: null, endDate: null, members, bookings }
}

describe('割り勘の対象者', () => {
  it('指定があればそれを使う', () => {
    expect(parts(booking({ participants: ['a', 'b'] }), ids)).toEqual(['a', 'b'])
  })

  // 前身と同じフォールバック。ここを変えると過去データの金額が変わる
  it('未設定・不正なら全員へフォールバックする', () => {
    expect(parts(booking({ participants: [] }), ids)).toEqual(ids)
    expect(parts(booking({ participants: ['存在しない'] }), ids)).toEqual(ids)
    expect(parts(booking({ participants: undefined as never }), ids)).toEqual(ids)
  })
})

describe('完了判定', () => {
  it('支払者以外が全員チェック済みなら完了', () => {
    expect(isDone(booking({ paid: { b: true, c: true } }), ids)).toBe(true)
  })

  it('1人でも未チェックなら未完了', () => {
    expect(isDone(booking({ paid: { b: true } }), ids)).toBe(false)
  })

  // 支払者自身のチェックは要らない（自分に払わない）
  it('支払者のチェックは判定に要らない', () => {
    expect(isDone(booking({ payer: 'a', paid: { b: true, c: true } }), ids)).toBe(true)
  })
})

describe('残高', () => {
  it('未払い分だけを数える', () => {
    // 3000円を3人で割る＝1人1000円。b は支払い済みなので残るのは c の分だけ
    const b = balances(state([booking({ paid: { b: true } })]))
    expect(b.get('a')).toBe(1000)
    expect(b.get('c')).toBe(-1000)
    expect(b.get('b')).toBe(0)
  })

  it('全員支払い済みなら残高はゼロ', () => {
    const b = balances(state([booking({ paid: { b: true, c: true } })]))
    expect([...b.values()]).toEqual([0, 0, 0])
  })

  it('立替合計は支払い状況と無関係に総額を数える', () => {
    const t = advanced(state([booking({ paid: { b: true, c: true } })]))
    expect(t.get('a')).toBe(3000)
    expect(t.get('b')).toBe(0)
  })
})

describe('送金の割り出し', () => {
  it('単純な貸し借りを1本にまとめる', () => {
    const t = settle(new Map([['a', 2000], ['b', -1000], ['c', -1000]]))
    expect(t).toEqual([
      { from: 'b', to: 'a', amount: 1000 },
      { from: 'c', to: 'a', amount: 1000 },
    ])
  })

  it('1円未満の端数は無視する', () => {
    expect(settle(new Map([['a', 0.4], ['b', -0.4]]))).toEqual([])
  })

  it('残高がゼロなら送金は無い', () => {
    expect(settle(new Map([['a', 0], ['b', 0]]))).toEqual([])
  })

  // 送金の合計は、支払う側の残高の合計と一致しなければならない（お金が湧かない/消えない）
  it('送金の合計が残高と釣り合う', () => {
    const bals = new Map([['a', 4500], ['b', -1500], ['c', -3000]])
    const total = settle(bals).reduce((n, t) => n + t.amount, 0)
    expect(total).toBe(4500)
  })
})
