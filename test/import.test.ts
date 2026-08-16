import { describe, it, expect } from 'vitest'
import { convertLegacy, ImportError } from '../src/client/import'
import { balances, settle } from '../src/client/settle'

// 前身アプリ（travel-calculation）が実際に書き出す形
const legacy = {
  state: {
    members: ['山田', '鈴木', '佐藤'],
    bookings: [
      {
        id: 1,
        category: '航空券',
        description: '往復',
        payer: '山田',
        amount: 30000,
        participants: ['山田', '鈴木', '佐藤'],
        paid: { 鈴木: true },
      },
      {
        id: 2,
        category: '食費',
        description: '夕食',
        payer: '鈴木',
        amount: 6000,
        participants: ['鈴木', '佐藤'],
        paid: {},
      },
    ],
  },
  nextId: 3,
}

describe('前身アプリからの取り込み', () => {
  it('メンバーを id 付きに変換する', () => {
    const { state } = convertLegacy(legacy, '沖縄旅行')
    expect(state.name).toBe('沖縄旅行')
    expect(state.members.map((m) => m.name)).toEqual(['山田', '鈴木', '佐藤'])
    expect(new Set(state.members.map((m) => m.id)).size).toBe(3)
  })

  // 🔴 前身は payer / participants / paid のキーに【名前】を使っていた。
  // ここを取り違えると金額の割り当てが静かにずれる
  it('立替者・対象者・支払い済みが id に対応づけられる', () => {
    const { state } = convertLegacy(legacy, 'T')
    const id = (name: string) => state.members.find((m) => m.name === name)!.id
    const [b1, b2] = state.bookings

    expect(b1.payer).toBe(id('山田'))
    expect(b1.participants).toEqual([id('山田'), id('鈴木'), id('佐藤')])
    expect(b1.paid).toEqual({ [id('鈴木')]: true })

    expect(b2.payer).toBe(id('鈴木'))
    expect(b2.participants).toEqual([id('鈴木'), id('佐藤')])
  })

  // 取り込みの正しさは「金額が同じになること」でしか確かめられない
  it('取り込んだ後の精算が、元データの計算と一致する', () => {
    const { state } = convertLegacy(legacy, 'T')
    const id = (name: string) => state.members.find((m) => m.name === name)!.id
    const bal = balances(state)

    // 航空券30000を3人＝1人10000。鈴木は支払い済みなので、佐藤の分だけ残る
    // 食費6000を2人＝1人3000。佐藤が鈴木へ3000
    expect(Math.round(bal.get(id('山田'))!)).toBe(10000)
    expect(Math.round(bal.get(id('鈴木'))!)).toBe(3000)
    expect(Math.round(bal.get(id('佐藤'))!)).toBe(-13000)

    const txns = settle(bal)
    expect(txns.reduce((n, t) => n + t.amount, 0)).toBe(13000)
  })

  it('連番の id は引き継がず UUID にする（オフラインで衝突するため）', () => {
    const { state } = convertLegacy(legacy, 'T')
    expect(state.bookings.map((b) => b.id)).not.toContain(1)
    expect(state.bookings[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('壊れた入力', () => {
  it('前身のファイルでなければ断る', () => {
    expect(() => convertLegacy({ foo: 1 }, 'T')).toThrow(ImportError)
    expect(() => convertLegacy(null, 'T')).toThrow(ImportError)
  })

  it('中身が空なら断る', () => {
    expect(() => convertLegacy({ state: { members: [], bookings: [] } }, 'T')).toThrow(ImportError)
  })

  // 🔴 立替が消えると、他の人の負担が静かに増える。捨てずに足す
  it('メンバー一覧に無い立替者は、捨てずにメンバーへ足す', () => {
    const { state, notes } = convertLegacy(
      {
        state: {
          members: ['山田'],
          bookings: [{ payer: '田中', amount: 1000, participants: ['山田', '田中'], paid: {} }],
        },
      },
      'T',
    )
    expect(state.members.map((m) => m.name)).toEqual(['山田', '田中'])
    expect(notes.join()).toContain('田中')
  })

  it('金額が読めない記録はとばし、とばしたことを伝える', () => {
    const { state, notes } = convertLegacy(
      {
        state: {
          members: ['山田'],
          bookings: [
            { payer: '山田', amount: 'たくさん', participants: [], paid: {} },
            { payer: '山田', amount: -500, participants: [], paid: {} },
            { payer: '山田', amount: 800, participants: [], paid: {} },
          ],
        },
      },
      'T',
    )
    expect(state.bookings).toHaveLength(1)
    expect(notes.join()).toContain('2 件')
  })

  // 対象者に居ない人の「支払い済み」を残すと、精算から抜け落ちる
  it('対象者に居ない人の支払い済みは引き継がない', () => {
    const { state } = convertLegacy(
      {
        state: {
          members: ['山田', '鈴木'],
          bookings: [
            { payer: '山田', amount: 1000, participants: ['山田', '鈴木'], paid: { 誰か: true } },
          ],
        },
      },
      'T',
    )
    expect(state.bookings[0].paid).toEqual({})
  })
})
