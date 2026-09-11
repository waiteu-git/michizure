import { describe, it, expect } from 'vitest'
import {
  encodeTicket,
  decodeTicket,
  compactState,
  expandState,
  deflate,
  inflate,
  ticketUrl,
  ticketFromHash,
  fitsFile,
} from '../src/client/ticket'
import {
  encodeEntry,
  decodeEntry,
  entryUrl,
  entryFromHash,
  entryForRoom,
  emptyRoomForEntry,
} from '../src/client/entry'
import type { RoomState } from '../src/client/api'

const uuid = () => crypto.randomUUID()

function room(bookingCount: number): RoomState {
  const members = ['わいてう', 'たなか', 'さとう', 'すずき', 'やまだ', 'たかはし'].map((name) => ({
    id: uuid(),
    name,
  }))
  return {
    name: '沖縄3泊4日',
    startDate: '2026-09-20',
    endDate: '2026-09-23',
    members,
    bookings: Array.from({ length: bookingCount }, (_, i) => ({
      id: uuid(),
      category: ['宿泊', '交通', '食費', 'その他'][i % 4],
      description: ['ホテル1泊目', 'レンタカー', '居酒屋', '高速代'][i % 4],
      payer: members[i % members.length].id,
      amount: 1000 + i * 137,
      participants: members.map((m) => m.id),
      paid: i % 3 === 0 ? { [members[1].id]: true } : {},
    })),
  }
}

describe('券の符号化', () => {
  const t = {
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    iterations: 600_000,
    kdfVersion: 2,
    iv: 'BBBBBBBBBBBBBBBB',
    ciphertext: 'abcdEFGH+/12345=',
  }

  it('往復して値が一致する', () => {
    const back = decodeTicket(encodeTicket(t))!
    expect(back.salt).toBe(t.salt)
    expect(back.iv).toBe(t.iv)
    expect(back.ciphertext).toBe(t.ciphertext)
    expect(back.iterations).toBe(t.iterations)
    expect(back.kdfVersion).toBe(t.kdfVersion)
  })

  it('URL に置けない文字を含まない', () => {
    expect(encodeTicket(t)).not.toMatch(/[+/=]/)
  })

  it('壊れた文字列は null（例外にしない）', () => {
    for (const bad of ['', 'こわれている', 'a.b.c', '1.2.3.4.5.6', 'x.600000.a.b.c']) {
      expect(decodeTicket(bad)).toBeNull()
    }
  })

  it('URL のフラグメントから取り出せる', () => {
    const url = ticketUrl('https://例.test', 'ABCD1234EFGH5678', t)
    expect(url).toContain('#t=')
    const got = ticketFromHash(new URL(url).hash)
    expect(got?.ciphertext).toBe(t.ciphertext)
  })

  it('券の無い URL からは null', () => {
    expect(ticketFromHash('')).toBeNull()
    expect(ticketFromHash('#other=1')).toBeNull()
  })
})

describe('平文の圧縮（暗号化の前に縮める）', () => {
  it('往復して完全に一致する', async () => {
    const st = room(12)
    const back = await inflate(await deflate(st))
    expect(back).toEqual(st)
  })

  /**
   * 🔴 予約の id を保つこと。作り直すと、電波が戻って合流した時に
   * **同じ記録が二重になる**（3方向マージは id で同一性を見る）。
   */
  it('予約とメンバーの id が保たれる', async () => {
    const st = room(5)
    const back = await inflate(await deflate(st))
    expect(back.bookings.map((b) => b.id)).toEqual(st.bookings.map((b) => b.id))
    expect(back.members.map((m) => m.id)).toEqual(st.members.map((m) => m.id))
  })

  it('支払い済みのチェックが保たれる', async () => {
    const st = room(6)
    const back = await inflate(await deflate(st))
    expect(back.bookings.map((b) => b.paid)).toEqual(st.bookings.map((b) => b.paid))
  })

  it('空の部屋でも壊れない', async () => {
    const st: RoomState = { name: '新しい旅', startDate: null, endDate: null, members: [], bookings: [] }
    expect(await inflate(await deflate(st))).toEqual(st)
  })

  it('索引化は素の JSON より十分小さい', () => {
    const st = room(20)
    const raw = JSON.stringify(st).length
    const small = JSON.stringify(compactState(st)).length
    expect(small).toBeLessThan(raw / 2)
    expect(expandState(compactState(st))).toEqual(st)
  })
})

describe('ファイル渡しの上限', () => {
  const mkTicket = (n: number) => ({
    salt: 'A'.repeat(24), iterations: 600_000, kdfVersion: 2,
    iv: 'B'.repeat(16), ciphertext: 'C'.repeat(n),
  })
  it('普通の部屋は収まる', () => expect(fitsFile(mkTicket(50_000))).toBe(true))
  it('サーバー上限を超える大きさは弾く', () => expect(fitsFile(mkTicket(300_000))).toBe(false))
})

/**
 * 🔴 QR の主経路。**中身を載せない**ので小さく、実機で読める。
 * 入った人の土台は「空の部屋」＝真の共通祖先なので、3方向マージが正しく効く。
 */
describe('入口だけの券', () => {
  const e = { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: 600_000, kdfVersion: 2 }

  it('往復して一致する', () => {
    const back = decodeEntry(encodeEntry(e))!
    expect(back).toEqual(e)
  })

  it('中身（暗号文）を含まない', () => {
    expect(encodeEntry(e).split('.')).toHaveLength(3)
    expect(encodeEntry(e)).not.toContain('=')
  })

  it('URL のフラグメントから取り出せる', () => {
    const url = entryUrl('https://michizure.example', 'ABCD1234EFGH5678', e)
    expect(url).toContain('#k=')
    expect(entryFromHash(new URL(url).hash)).toEqual(e)
  })

  it('QR に載せても十分小さい（実測の目安 81 B 前後）', () => {
    const url = entryUrl('https://michizure.waiteu.dev', 'ABCD1234EFGH5678', e)
    expect(new TextEncoder().encode(url).length).toBeLessThan(120)
  })

  it('壊れた文字列は null', () => {
    for (const bad of ['', 'a.b', 'x.600000.abc', '2.600000']) expect(decodeEntry(bad)).toBeNull()
  })

  it('入った直後の土台は空の部屋', () => {
    expect(emptyRoomForEntry()).toEqual({ name: '', startDate: null, endDate: null, members: [], bookings: [] })
  })
})

/**
 * 🔴 **入口券は、URL の部屋にだけ使う。**
 *
 * アプリは URL を書き換えないので、部屋Aの招待QRで開いたタブには `#k=`（Aの入口）が残り続ける。
 * そのタブで入口の一覧から部屋Bを開き、入り直しが通信の失敗で落ちると、以前は **Aの入口で
 * Bに圏外入室し、Bの控えを空の部屋で上書きしていた**（2026-09-11 の多観点照合で発見）。
 */
describe('入口券を使ってよい部屋', () => {
  const e = { kdfVersion: 2, iterations: 600_000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }
  const A = 'AAAAAAAAAAAAAAAA'
  const B = 'BBBBBBBBBBBBBBBB'
  const url = new URL(entryUrl('https://michizure.example', A, e))

  it('URL の部屋なら券を返す', () => {
    expect(entryForRoom(url.pathname, url.hash, A)).toEqual(e)
  })

  it('別の部屋には使わない（Aの券でBに入らない）', () => {
    expect(entryForRoom(url.pathname, url.hash, B)).toBeNull()
  })

  it('部屋の URL でなければ使わない（入口の一覧から開いた時）', () => {
    expect(entryForRoom('/', url.hash, A)).toBeNull()
  })

  it('券が無ければ null（負の対照）', () => {
    expect(entryForRoom(url.pathname, '', A)).toBeNull()
  })
})
