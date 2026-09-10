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

const { commitLocal, applyRemote, localState, isDirty, adoptRemote, takePendingConflicts, markForgotten, revive } =
  await import('../src/client/store')
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


/**
 * 🔴 衝突した時に、**解けた分まで捨てない**こと。
 *
 * 以前は merge3 の併合結果ごと捨てて何も書かずに返していた。すると相手が別に足した
 * 記録がローカルに入らないまま、解決画面が「今サーバーで見た版」を名乗って送るので、
 * **サーバーからも相手の記録が消えた**（2026-09-07 のレビューで実測）。
 */
describe('衝突した時に残る物', () => {
  beforeEach(() => { mem.clear(); rev = 0 })

  const bk = (id: string, amount: number) => ({
    id, category: '食費', description: '夕食', payer: 'a', amount,
    participants: ['a'], paid: {},
  })
  const room = (bs: ReturnType<typeof bk>[]): RoomState => ({
    name: '旅', startDate: null, endDate: null, members: [{ id: 'a', name: 'わ' }], bookings: bs,
  })

  it('相手が別に足した記録は、衝突していないので残る', () => {
    adoptRemote(ROOM, room([bk('Y', 3000)]), 1)
    commitLocal(ROOM, room([bk('Y', 4000)]))                       // 自分が直した
    expect(applyRemote(ROOM, room([bk('Y', 5000), bk('Z', 800)]), 2)).toBe('conflict')

    const got = localState(ROOM)!.bookings
    // Z（相手の別の追加）が入っていること。ここが空だと、解決時に消える
    expect(got.map((b) => b.id).sort()).toEqual(['Y', 'Z'])
    // 解けなかった Y は暫定的に自分の版（画面から消さない）
    expect(got.find((b) => b.id === 'Y')!.amount).toBe(4000)
  })

  it('見た版を控えるので、解決した結果を送れる', () => {
    adoptRemote(ROOM, room([bk('Y', 3000)]), 1)
    commitLocal(ROOM, room([bk('Y', 4000)]))
    applyRemote(ROOM, room([bk('Y', 5000)]), 2)
    // 控えていないと、次の送信が永久に 409 になって詰む
    expect(JSON.parse(mem.get('michizure.state.' + ROOM)!).rev).toBe(2)
  })

  it('解けなかった予約は1件だけ渡される', () => {
    adoptRemote(ROOM, room([bk('Y', 3000)]), 1)
    commitLocal(ROOM, room([bk('Y', 4000)]))
    applyRemote(ROOM, room([bk('Y', 5000), bk('Z', 800)]), 2)
    const list = takePendingConflicts(ROOM)
    expect(list).toHaveLength(1)
    expect(list[0].mine?.amount).toBe(4000)
    expect(list[0].theirs?.amount).toBe(5000)
  })
})

/**
 * ⚠ 取ったら消すこと。消さないと**別の部屋を開いた時に前の部屋の予約が解決パネルへ出る**。
 */
describe('解けなかった予約の受け渡し', () => {
  beforeEach(() => { mem.clear(); rev = 0 })
  const bk = (id: string, amount: number) => ({
    id, category: '食費', description: '', payer: 'a', amount, participants: ['a'], paid: {},
  })
  const room = (bs: ReturnType<typeof bk>[]): RoomState => ({
    name: '旅', startDate: null, endDate: null, members: [{ id: 'a', name: 'わ' }], bookings: bs,
  })
  const stage = () => {
    adoptRemote(ROOM, room([bk('Y', 3000)]), 1)
    commitLocal(ROOM, room([bk('Y', 4000)]))
    applyRemote(ROOM, room([bk('Y', 5000)]), 2)
  }

  it('二度目は空（取ったら消える）', () => {
    stage()
    expect(takePendingConflicts(ROOM)).toHaveLength(1)
    expect(takePendingConflicts(ROOM)).toHaveLength(0)
  })

  it('別の部屋には渡さない', () => {
    stage()
    expect(takePendingConflicts('ROOM0000000000BB')).toHaveLength(0)
  })
})


/**
 * 🔴 **「この端末から消す」を押した部屋へ、遅れて届いた応答で書き戻さない。**
 * 以前は通信中の取り込みが返ると平文の控えを書き戻し、入口の一覧に載らない孤児ができた
 * （＝もう「この端末から消す」では消せない。2026-09-10 の監査で指摘）。
 */
describe('この端末から消した部屋', () => {
  const GONE = 'ROOM0000000000GG'
  beforeEach(() => { mem.clear(); revive(GONE) })

  it('印を付けた後は、遅れて届いた応答でも書き戻さない', () => {
    markForgotten(GONE)
    applyRemote(GONE, withMember('遅れて届いた'), nextRev())
    adoptRemote(GONE, withMember('遅れて届いた'), nextRev())
    commitLocal(GONE, withMember('遅れて届いた'))
    expect(localState(GONE)).toBeNull()
    expect(mem.has('michizure.state.' + GONE)).toBe(false)
  })

  it('本人が入り直せば（revive）、また書ける', () => {
    markForgotten(GONE)
    revive(GONE)
    adoptRemote(GONE, withMember('入り直した'), nextRev())
    expect(localState(GONE)?.members[0].name).toBe('入り直した')
  })

  it('印は部屋ごと（別の部屋は止めない）', () => {
    markForgotten(GONE)
    adoptRemote(ROOM, withMember('別の部屋'), nextRev())
    expect(localState(ROOM)?.members[0].name).toBe('別の部屋')
  })
})
