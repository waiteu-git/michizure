import { describe, it, expect, beforeEach } from 'vitest'

// store.ts は端末の localStorage を使う。Workers のテスト環境には無いので、
// import より先に最小限の実装を置く（挙動の検査が目的で、実装の忠実さは要らない）
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

const { commitLocal, applyRemote, localState, isDirty } = await import('../src/client/store')
import type { RoomState } from '../src/client/api'

const base: RoomState = { name: '旅', startDate: null, endDate: null, members: [], bookings: [] }
const withMember = (n: string): RoomState => ({
  ...base,
  members: [{ id: n, name: n }],
})

const ROOM = 'ROOM0000000000AA'

describe('外から届いた状態の取り込み', () => {
  beforeEach(() => mem.clear())

  it('未送信の変更が無ければ取り込む', () => {
    expect(applyRemote(ROOM, withMember('a'))).toBe('adopted')
    expect(localState(ROOM)?.members).toHaveLength(1)
  })

  /**
   * 🔴 これが 2026-09-05 まで壊れていた分岐。
   * 「未送信の変更がある」だけで衝突にしていたため、**自分が送ったものが
   * 中継されて返ってきただけで衝突パネルが出た**（部屋を作った直後に必ず起きる）。
   */
  it('中身が同じなら衝突ではない（自分の push が返ってきただけ）', () => {
    commitLocal(ROOM, withMember('a'))
    expect(isDirty(ROOM)).toBe(true)
    expect(applyRemote(ROOM, withMember('a'))).toBe('adopted')
    expect(isDirty(ROOM)).toBe(false) // 送信済みとして扱う
    expect(localState(ROOM)?.members).toHaveLength(1)
  })

  it('相手が動いていないなら衝突ではない（こちらが先行しているだけ）', () => {
    applyRemote(ROOM, base) // baseStamp が base になる
    commitLocal(ROOM, withMember('a')) // ローカルだけ進む
    expect(applyRemote(ROOM, base)).toBe('ahead')
    // ⚠ ローカルの変更を捨てない
    expect(localState(ROOM)?.members).toHaveLength(1)
    expect(isDirty(ROOM)).toBe(true)
  })

  it('双方が別々に動いたときだけ衝突', () => {
    applyRemote(ROOM, base)
    commitLocal(ROOM, withMember('a'))
    expect(applyRemote(ROOM, withMember('b'))).toBe('conflict')
    // 衝突では何も上書きしない
    expect(localState(ROOM)?.members[0].name).toBe('a')
    expect(isDirty(ROOM)).toBe(true)
  })
})
