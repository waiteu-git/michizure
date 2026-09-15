import { describe, it, expect } from 'vitest'
import { roomToCsv } from '../src/client/csv'
import type { RoomState } from '../src/client/api'

const uuid = () => crypto.randomUUID()

function room(): RoomState {
  const [taro, hanako] = [
    { id: uuid(), name: 'たろう' },
    { id: uuid(), name: 'はなこ' },
  ]
  return {
    name: '沖縄旅行',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    members: [taro, hanako],
    bookings: [
      {
        id: uuid(),
        category: '食費',
        description: '夕食',
        payer: taro.id,
        amount: 1000,
        participants: [taro.id, hanako.id],
        paid: { [hanako.id]: true },
      },
    ],
  }
}

describe('roomToCsv', () => {
  it('ヘッダー・旅行名・メンバー名・記録が1つのCSVに入る', () => {
    const csv = roomToCsv(room())
    expect(csv).toContain('沖縄旅行')
    expect(csv).toContain('たろう')
    expect(csv).toContain('はなこ')
    expect(csv).toContain('食費')
    expect(csv).toContain('夕食')
    expect(csv).toContain('1000')
  })

  it('名前ではなくIDを保存していても、CSVには名前が出る（IDが漏れない）', () => {
    const s = room()
    const csv = roomToCsv(s)
    for (const m of s.members) {
      expect(csv).not.toContain(m.id)
    }
  })

  it('カンマ・改行・ダブルクォートを含む名前は正しくエスケープされる', () => {
    const s = room()
    s.name = '沖縄, 3泊"4日"\n旅行'
    const csv = roomToCsv(s)
    // ダブルクォートで囲まれ、中のダブルクォートは2重化される
    expect(csv).toContain('"沖縄, 3泊""4日""\n旅行"')
  })

  it('支払い済みの有無が読める形で出る', () => {
    const s = room()
    const csv = roomToCsv(s)
    const lines = csv.split('\r\n')
    const row = lines.find((l) => l.includes('夕食'))!
    expect(row).toContain('済')
  })

  it('記録が0件でも壊れない（ヘッダーだけになる）', () => {
    const s = room()
    s.bookings = []
    const csv = roomToCsv(s)
    expect(csv).toContain('沖縄旅行')
    expect(() => roomToCsv(s)).not.toThrow()
  })

  it('精算結果（誰が誰にいくら払うか）も含まれる', () => {
    const csv = roomToCsv(room())
    // たろうが1000円立て替え、はなこは払い済み＝送金は無い
    expect(csv).toContain('精算')
  })

  it('未精算の送金があれば金額と宛先が出る', () => {
    const s = room()
    // 支払い済みを外す＝はなこがたろうへ500円払う必要がある
    s.bookings[0].paid = {}
    const csv = roomToCsv(s)
    expect(csv).toContain('はなこ')
    expect(csv).toContain('たろう')
    expect(csv).toContain('500')
  })
})
