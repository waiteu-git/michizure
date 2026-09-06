import { describe, it, expect, beforeEach, afterAll } from 'vitest'

/**
 * 🔴 **同時に電波が戻った2台で、片方の記録が消えないこと。**
 *
 * 2026-09-06、2タブの実測で消えた。サーバーが版を照合せず PUT を素通しするため、
 * 後から届いた1本が先に届いた記録を丸ごと上書きしていた（`PUT … 200 OK` が2本
 * 並び、消えたことは誰にも見えない＝サーバーは中身を読めず、復旧手段も無い）。
 *
 * ここでは**本物のクライアント経路**（store.ts → api.ts → fetch）を、
 * 版を数える偽のサーバーに向けて走らせる。crypto は本物を使う。
 */

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
;(globalThis as any).navigator = { onLine: true }

/** 版を数える最小のサーバー。**今の版を見ていない書き込みは断る** */
const server = { ciphertext: '', iv: '', rev: 0 }
let puts = 0
let rejected = 0

const realFetch = globalThis.fetch
;(globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
  if ((init?.method ?? 'GET') === 'GET') {
    return Response.json({ ciphertext: server.ciphertext, iv: server.iv, rev: server.rev })
  }
  puts++
  const body = JSON.parse(String(init!.body)) as {
    ciphertext: string
    iv: string
    baseRev: number
  }
  if (body.baseRev !== server.rev) {
    rejected++
    return Response.json({ error: 'stale', rev: server.rev }, { status: 409 })
  }
  server.ciphertext = body.ciphertext
  server.iv = body.iv
  server.rev++
  return Response.json({ ok: true, rev: server.rev })
}

const { pull, push, commitLocal, localState, isDirty } = await import('../src/client/store')
const { seal, open } = await import('../src/box')
const { deriveKeys } = await import('../src/keys')
import type { RoomState, Session, Booking } from '../src/client/api'

afterAll(() => {
  ;(globalThis as any).fetch = realFetch
})

const ROOM = 'ROOM0000000000AA'
const { encKeyBits } = await deriveKeys('あいことば', 'AAAAAAAAAAAAAAAAAAAAAA==', 100_000, 2)
const s: Session = { roomId: ROOM, token: 'tok', encKeyBits }

const bk = (id: string, description: string): Booking => ({
  id,
  category: '食費',
  description,
  payer: 'a',
  amount: 1000,
  participants: ['a'],
  paid: {},
})

const empty: RoomState = {
  name: '旅',
  startDate: null,
  endDate: null,
  members: [{ id: 'a', name: 'わたし' }],
  bookings: [],
}

/** サーバーの中身を（本物の鍵で）置き換える＝「相手が書いた」を作る */
async function serverHolds(st: RoomState) {
  const sealed = await seal(encKeyBits, st)
  server.ciphertext = sealed.ciphertext
  server.iv = sealed.iv
  server.rev++
}

async function serverState(): Promise<RoomState> {
  return open<RoomState>(encKeyBits, server.ciphertext, server.iv)
}

beforeEach(async () => {
  mem.clear()
  server.rev = 0
  puts = 0
  rejected = 0
  await serverHolds(empty)
})

describe('送っている最中に相手が書いていた時', () => {
  /**
   * 🔴 これが 2026-09-06 に実機で記録を消した形。
   * 「圏外で足す」→「同時に電波が戻る」→「双方が送る」。
   */
  it('相手の記録を消さず、両方が残る', async () => {
    // 1台目：サーバーを取り込んでから、圏外で1件足す
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })

    // 送る直前に、相手（2台目）が別の記録を書いていた
    await serverHolds({ ...empty, bookings: [bk('2', 'タクシー')] })

    expect(await push(s)).toBe('synced')

    // サーバーにも端末にも**両方**が残っている
    const onServer = (await serverState()).bookings.map((b) => b.description).sort()
    expect(onServer).toEqual(['タクシー', '居酒屋'])
    expect(localState(ROOM)?.bookings.map((b) => b.description).sort()).toEqual([
      'タクシー',
      '居酒屋',
    ])
    expect(isDirty(ROOM)).toBe(false)
  })

  it('一度は断られてから、取り込み直して送り直している', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    await serverHolds({ ...empty, bookings: [bk('2', 'タクシー')] })
    await push(s)
    expect(rejected).toBe(1) // 押し通していない
    expect(puts).toBe(2) // 断られ → 取り込み直し → 送り直し
  })

  /**
   * ⚠ 同じ1件を双方が直していた時は、黙って決めない。
   * 送り直しの中でマージが解けなかったら、利用者に選ばせる状態で止まる。
   */
  it('同じ1件を双方が直していたら、押し通さずに衝突として返す', async () => {
    await serverHolds({ ...empty, bookings: [bk('1', '夕食')] })
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [{ ...bk('1', '夕食'), amount: 3000 }] })
    await serverHolds({ ...empty, bookings: [{ ...bk('1', '夕食'), amount: 5000 }] })

    expect(await push(s)).toBe('conflict')
    // サーバーは相手の版のまま＝上書きしていない
    expect((await serverState()).bookings[0].amount).toBe(5000)
    expect(isDirty(ROOM)).toBe(true) // 端末の変更も捨てていない
  })
})

describe('送っている間に自分が足した記録', () => {
  /**
   * 🔴 送信前の控えを丸ごと書き戻すと、**通信中に入力した分が消える**。
   * サーバーは受け取っているので、消えたことに気づく手がかりが無い。
   */
  it('巻き戻されない', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })

    const sending = push(s)
    // 送っている最中に、利用者がもう1件足した
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋'), bk('2', '朝食')] })
    expect(await sending).toBe('pending') // まだ送れていない分がある

    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['居酒屋', '朝食'])
    expect(isDirty(ROOM)).toBe(true)

    expect(await push(s)).toBe('synced')
    expect((await serverState()).bookings.map((b) => b.description)).toEqual(['居酒屋', '朝食'])
  })
})
