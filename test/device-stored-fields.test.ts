import { describe, it, expect, beforeEach } from 'vitest'

// store.ts と session-store.ts は localStorage を使う。Workers のテスト環境には無いので、
// import より先に最小限の実装を置く（local-store.test.ts と同じ形）
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

const store = await import('../src/client/store')
const sessions = await import('../src/client/session-store')
const { DEVICE_STORED } = await import('../src/client/device-stored-fields')
import type { RoomState, Session } from '../src/client/api'

/**
 * 🔴 **端末に保存するものを、宣言（src/client/device-stored-fields.ts）と突き合わせる。**
 * PP §2.1 の消費元。9/6〜9/7 に base・rev・entry を足した時、PP は載せないままだった
 * （2026-09-10 の監査で指摘）。人が PP を洗い忘れても、ここが止める。
 * ⚠ 一通りの経路（作成・入室の控え・圏外で記録・相手と合流）を通してから吐き出す。
 */
const ROOM = 'ROOM0000000000DV'
const s: Session = { roomId: ROOM, token: 'tok', encKeyBits: new ArrayBuffer(32) }
const room = (names: string[]): RoomState => ({
  name: '旅', startDate: null, endDate: null, members: [{ id: 'a', name: 'わ' }],
  bookings: names.map((d, i) => ({ id: String(i), category: '食費', description: d, payer: 'a', amount: 1, participants: ['a'], paid: {} })),
})

function exercise() {
  // 部屋を覚える（入口の材料つき）
  sessions.remember(s, '旅', { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: 600_000, kdfVersion: 2 })
  // 取ってきた版を土台に据える → 圏外で記録を足す → 相手の版が届いて合流する
  store.adoptRemote(ROOM, room([]), 1)
  store.commitLocal(ROOM, room(['居酒屋']))
  store.applyRemote(ROOM, { ...room(['タクシー']), bookings: [{ ...room(['タクシー']).bookings[0], id: 'T' }] }, 2)
}

beforeEach(() => mem.clear())

describe('端末に保存するもの', () => {
  it('キーの形は宣言どおり（知らないキーが増えていない）', () => {
    exercise()
    for (const k of mem.keys()) {
      const known = k === DEVICE_STORED.rooms.key || k.startsWith(DEVICE_STORED.state.keyPrefix)
      expect(known, `宣言に無いキー: ${k}`).toBe(true)
    }
  })

  it('部屋の一覧の欄は宣言どおり', () => {
    exercise()
    const list = JSON.parse(mem.get(DEVICE_STORED.rooms.key)!) as Record<string, unknown>[]
    expect(Object.keys(list[0]).sort()).toEqual([...DEVICE_STORED.rooms.fields].sort())
    expect(Object.keys(list[0].entry as object).sort()).toEqual([...DEVICE_STORED.rooms.entryFields].sort())
  })

  it('部屋の控えの欄は宣言どおり', () => {
    exercise()
    const local = JSON.parse(mem.get(DEVICE_STORED.state.keyPrefix + ROOM)!) as Record<string, unknown>
    expect(Object.keys(local).sort()).toEqual([...DEVICE_STORED.state.fields].sort())
  })

  /**
   * 🔴 衝突の選択待ちの間だけ、控えに `conflict` が付く（それ以外の時は付かない）。
   * 付く欄は**宣言した任意の欄だけ**＝ここを通らずに知らない欄が増えるのを止める。
   */
  it('衝突の選択待ちの間だけ、宣言した任意の欄（conflict）が付く', () => {
    const bk = (amount: number) => ({ id: 'Y', category: '食費', description: '夕食', payer: 'a', amount, participants: ['a'], paid: {} })
    const withY = (amount: number): RoomState => ({ ...room([]), bookings: [bk(amount)] })
    store.adoptRemote(ROOM, withY(3000), 1)
    store.commitLocal(ROOM, withY(4000))
    const key = DEVICE_STORED.state.keyPrefix + ROOM
    expect(JSON.parse(mem.get(key)!).conflict).toBeUndefined() // 衝突前は付かない
    expect(store.applyRemote(ROOM, withY(5000), 2)).toBe('conflict')
    const during = JSON.parse(mem.get(key)!) as Record<string, unknown>
    expect(during.conflict).toBe(true)
    expect(Object.keys(during).sort()).toEqual([...DEVICE_STORED.state.fields, ...DEVICE_STORED.state.optionalFields].sort())
    // 選び終えたら外れる
    store.resolveKeepMine(ROOM, withY(4000), 2)
    expect(JSON.parse(mem.get(key)!).conflict).toBeUndefined()
  })

  /**
   * ⚠ PP に書くべき事実を、ここで固定する＝**消した記録が、次の同期成功まで端末に平文で残る**。
   * 仕様として直せない（base は3方向マージの真の共通祖先でなければならない）ので、開示で扱う。
   */
  it('消した記録は、同期に成功するまで土台（平文）に残る', () => {
    store.adoptRemote(ROOM, room(['消す前の記録']), 1)
    store.commitLocal(ROOM, room([])) // 利用者が消した
    const raw = mem.get(DEVICE_STORED.state.keyPrefix + ROOM)!
    expect(JSON.parse(raw).state.bookings).toHaveLength(0) // 画面には出ない
    expect(raw).toContain('消す前の記録') // だが端末には平文で残っている
  })
})
