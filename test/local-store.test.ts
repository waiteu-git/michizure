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

// サーバーが数える版。書き込みのたびに1つ増える（戻り値の判定には効かないが、
// 実物と同じ形で渡しておく＝控えそこないがあれば別のテストで露見する）
let rev = 0
const nextRev = () => ++rev

describe('外から届いた状態の取り込み', () => {
  beforeEach(() => { mem.clear(); rev = 0 })

  it('未送信の変更が無ければ取り込む', () => {
    expect(applyRemote(ROOM, withMember('a'), nextRev())).toBe('adopted')
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
    expect(applyRemote(ROOM, withMember('a'), nextRev())).toBe('adopted')
    expect(isDirty(ROOM)).toBe(false) // 送信済みとして扱う
    expect(localState(ROOM)?.members).toHaveLength(1)
  })

  it('相手が動いていないなら衝突ではない（こちらが先行しているだけ）', () => {
    applyRemote(ROOM, base, nextRev()) // baseStamp が base になる
    commitLocal(ROOM, withMember('a')) // ローカルだけ進む
    expect(applyRemote(ROOM, base, nextRev())).toBe('ahead')
    // ⚠ ローカルの変更を捨てない
    expect(localState(ROOM)?.members).toHaveLength(1)
    expect(isDirty(ROOM)).toBe(true)
  })

  /**
   * 🔴 2026-09-06 に契約が変わった。**別々に足しただけなら衝突しない。**
   * 以前はここで 'conflict' を返し、利用者に「どちらを消すか」を聞いていた。
   * 設計 §9 は最初から「追加は衝突しない（UUID のため）」と約束している。
   */
  it('双方が別々に足しただけならマージされ、両方残る', () => {
    applyRemote(ROOM, base, nextRev())
    commitLocal(ROOM, withMember('a'))
    expect(applyRemote(ROOM, withMember('b'), nextRev())).toBe('merged')
    const after = localState(ROOM)
    expect(after?.members.map((m) => m.name).sort()).toEqual(['a', 'b'])
    expect(isDirty(ROOM)).toBe(true) // マージ結果はまだ送っていない
  })

  it('土台が無ければマージせず、丸ごと選ばせる（捏造しない）', () => {
    // pull/applyRemote を通していない＝base が無い状態を作る
    commitLocal(ROOM, withMember('a'))
    expect(applyRemote(ROOM, withMember('b'), nextRev())).toBe('conflict')
    expect(localState(ROOM)?.members[0].name).toBe('a') // 何も上書きしない
  })
})

/**
 * 🔴 電波が戻ると、サーバーの版は**2つの経路から届く**——WebSocket の `init` と、
 * HTTP の `pull`。どちらが先かは決まっていない。同じ版を二度マージすると、
 * 「相手の記録と合わせました」が二度出る（2026-09-06、繋ぎ直しを直した時に発生）。
 */
describe('同じ版が二度届いた時', () => {
  beforeEach(() => { mem.clear(); rev = 0 })

  it('二度目はマージし直さない', () => {
    // 土台＝双方が一致していた版
    expect(applyRemote(ROOM, base, nextRev())).toBe('adopted')
    // 圏外で自分が1件足した
    commitLocal(ROOM, withMember('わたし'))
    const theirs: RoomState = { ...base, members: [{ id: 'あいて', name: 'あいて' }] }

    expect(applyRemote(ROOM, theirs, nextRev())).toBe('merged')
    expect(localState(ROOM)?.members).toHaveLength(2)

    // 同じ版がもう一方の経路から届く
    expect(applyRemote(ROOM, theirs, nextRev())).toBe('ahead')
    expect(localState(ROOM)?.members).toHaveLength(2)
  })
})
