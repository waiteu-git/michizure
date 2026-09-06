import { describe, it, expect, beforeEach, afterAll } from 'vitest'

/**
 * 繋ぎ直しの挙動。
 *
 * live.ts はブラウザの `WebSocket`・`setTimeout`・`online`・`visibilitychange` を
 * 使う。Workers のテスト環境には同じ意味のものが無いので、**import より先に**
 * 最小限の偽物を置く（local-store.test.ts が localStorage で採っているのと同じ形）。
 *
 * 🔴 タイマーは自動で動かさない。動かすと繋ぎ直しの連鎖がテスト中に走って数が濁る。
 * 「いつ動かす予定になったか」を溜めて、その**予定表**を観測する。
 */

type Listener = () => void

class FakeWS {
  static made: FakeWS[] = []
  static CONNECTING = 0
  static OPEN = 1
  readyState = 0
  private ls = new Map<string, Listener[]>()
  constructor(public url: string) {
    FakeWS.made.push(this)
  }
  addEventListener(t: string, f: Listener) {
    this.ls.set(t, [...(this.ls.get(t) ?? []), f])
  }
  close() {
    this.readyState = 3
    this.fire('close')
  }
  fire(t: string) {
    for (const f of [...(this.ls.get(t) ?? [])]) f()
  }
  /** ⚠ ブラウザが接続に失敗した時の順序＝`error` のあとに `close` が続けて出る */
  failToConnect() {
    this.fire('error')
    this.readyState = 3
    this.fire('close')
  }
  succeed() {
    this.readyState = 1
    this.fire('open')
  }
}

const timers = new Map<number, { fn: () => void; delay: number }>()
let nextTimerId = 1
const onGlobal = new Map<string, Listener[]>()
const onDocument = new Map<string, Listener[]>()
let hidden = false

const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
;(globalThis as any).WebSocket = FakeWS
;(globalThis as any).setTimeout = ((fn: () => void, delay: number) => {
  const id = nextTimerId++
  timers.set(id, { fn, delay })
  return id
}) as unknown as typeof setTimeout
;(globalThis as any).clearTimeout = ((id: number) => void timers.delete(id)) as unknown as typeof clearTimeout
;(globalThis as any).addEventListener = (t: string, f: Listener) =>
  void onGlobal.set(t, [...(onGlobal.get(t) ?? []), f])
;(globalThis as any).document = {
  addEventListener: (t: string, f: Listener) => void onDocument.set(t, [...(onDocument.get(t) ?? []), f]),
  get hidden() {
    return hidden
  },
}

const { connectLive, disconnectLive } = await import('../src/client/live')
const { setApiBase } = await import('../src/client/config')

afterAll(() => Object.assign(globalThis, real))

// ⚠ 先に配信元を入れる。空だと wsOrigin() が location.origin を読み、Workers で落ちる
setApiBase('https://michizure.test')

const S = { roomId: 'ROOM0000000000AA', token: 'tok', encKeyBits: new ArrayBuffer(32) } as never
const noop = { onUpdate: () => {}, onStatus: () => {} }

const last = () => FakeWS.made[FakeWS.made.length - 1]
const waits = () => [...timers.values()].map((t) => t.delay)

/** 予約されている繋ぎ直しを1つ動かす */
function runPending() {
  const [id, t] = [...timers.entries()][0] ?? []
  if (!t) throw new Error('繋ぎ直しが予約されていない')
  timers.delete(id!)
  t.fn()
}

const fire = (m: Map<string, Listener[]>, t: string) => {
  for (const f of [...(m.get(t) ?? [])]) f()
}

beforeEach(() => {
  disconnectLive()
  FakeWS.made.length = 0
  timers.clear()
  hidden = false
})

describe('繋がらなかった時', () => {
  /**
   * 🔴 失敗した接続は `error` と `close` を**続けて**出す。同じ処理を素直に
   * 両方へ繋ぐと、1回の失敗で繋ぎ直しが2本予約され、待ち時間の倍々も2段ずつ進む。
   */
  it('1回の失敗で予約される繋ぎ直しは1本だけ', () => {
    connectLive(S, noop)
    expect(FakeWS.made).toHaveLength(1)
    last().failToConnect()
    expect(waits()).toEqual([1000])
  })

  it('待ち時間は倍々に伸びて30秒で頭打ちになる（叩き続けない）', () => {
    connectLive(S, noop)
    const seen: number[] = []
    for (let i = 0; i < 7; i++) {
      last().failToConnect()
      // ⚠ 「予約が1本であること」まで見る。ここを見ないと、二重予約で古い値を
      // 拾っているだけの状態でも数列が揃って**壊れたまま通る**（実際に通った）
      expect(timers.size).toBe(1)
      seen.push(waits()[0])
      runPending()
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('部屋を出たら、残っていた予約も取り消す', () => {
    connectLive(S, noop)
    last().failToConnect()
    expect(timers.size).toBe(1)
    disconnectLive()
    expect(timers.size).toBe(0)
  })
})

describe('電波が戻った時', () => {
  /**
   * 🔴 2026-09-06 に実機で踏んだ不具合。繋ぎ直しがタイマー任せだと、電波が
   * 戻っても**最大30秒待たされる**。リロードで直るのは待ち時間の積み上げが
   * 0 に戻るからで、「リロードで直る」は仕様ではなくこの欠落の症状だった。
   */
  it('待たずにすぐ繋ぎ直す', () => {
    connectLive(S, noop)
    last().failToConnect()
    const before = FakeWS.made.length
    fire(onGlobal, 'online')
    expect(FakeWS.made.length).toBe(before + 1)
  })

  it('積み上がった待ち時間を0に戻す（次に失敗しても1秒から）', () => {
    connectLive(S, noop)
    for (let i = 0; i < 5; i++) {
      last().failToConnect()
      runPending()
    }
    fire(onGlobal, 'online')
    last().failToConnect()
    expect(waits()).toEqual([1000])
  })

  it('古い予約を残さない（同じ失敗で二重に繋ぎ直さない）', () => {
    connectLive(S, noop)
    last().failToConnect()
    fire(onGlobal, 'online')
    expect(timers.size).toBe(0)
  })

  it('すでに繋がっていれば、繋ぎ直さない', () => {
    connectLive(S, noop)
    last().succeed()
    const before = FakeWS.made.length
    fire(onGlobal, 'online')
    expect(FakeWS.made).toHaveLength(before)
  })

  it('部屋を出た後は繋ぎ直さない', () => {
    connectLive(S, noop)
    last().failToConnect()
    disconnectLive()
    const before = FakeWS.made.length
    fire(onGlobal, 'online')
    expect(FakeWS.made).toHaveLength(before)
  })
})

/**
 * ⚠ 機内モードの解除は**アプリの外**（設定・コントロールセンター）で行う。
 * 端末は画面が見えていない間タイマーを止めるので、`online` だけでは
 * 戻ってきた時に動くとは限らない。
 */
describe('画面に戻った時', () => {
  it('繋がっていなければ繋ぎ直す', () => {
    connectLive(S, noop)
    last().failToConnect()
    hidden = false
    const before = FakeWS.made.length
    fire(onDocument, 'visibilitychange')
    expect(FakeWS.made.length).toBe(before + 1)
  })

  it('画面が隠れた時は何もしない', () => {
    connectLive(S, noop)
    last().failToConnect()
    hidden = true
    const before = FakeWS.made.length
    fire(onDocument, 'visibilitychange')
    expect(FakeWS.made).toHaveLength(before)
  })
})
