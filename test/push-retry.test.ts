import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

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
/** 部屋が消えた状態（GET も PUT も 404） */
let deleted = false
/**
 * トークンが断られた状態（GET も PUT も 401）。'ours' は当サービスの応答、
 * 'foreign' は当サービス以外が返した 401（負の対照）
 */
let tokenRejected: 'ours' | 'foreign' | null = null
let calls = 0
/** 次の GET に一度だけ、この古い版を返させる（送信の前に頼んだ応答が、送信の後に届いた形を作る） */
let staleGet: { ciphertext: string; iv: string; rev: number } | null = null
/** PUT の応答を返す直前に一度だけ走らせる細工（送信中に起きる出来事を作る） */
let duringPut: (() => Promise<void> | void) | null = null

const realFetch = globalThis.fetch
;(globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
  calls++
  if (deleted) return Response.json({ error: 'not_found' }, { status: 404 })
  if (tokenRejected === 'ours') return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (tokenRejected === 'foreign') {
    return new Response('<html>sign in</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })
  }
  if ((init?.method ?? 'GET') === 'GET') {
    if (staleGet) {
      const old = staleGet
      staleGet = null
      return Response.json(old)
    }
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
  const accepted = server.rev
  // ⚠ 細工は**書き込みが通った後・応答を返す前**に走らせる。前に走らせると 409 になり、
  // 検査したい「成功したのに巻き戻す」分岐を通らない（実際に一度そう書いて素通りした）
  if (duringPut) { const f = duringPut; duringPut = null; await f() }
  return Response.json({ ok: true, rev: accepted })
}

const {
  pull,
  push,
  commitLocal,
  localState,
  isDirty,
  applyRemote,
  hasUnresolvedConflict,
  resolveBookings,
  resolveKeepMine,
  resolveTakeTheirs,
  pendingConflictsOf,
} = await import('../src/client/store')
const { seal, open } = await import('../src/box')
const { RoomGoneError, TokenRejectedError } = await import('../src/client/api')
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
  duringPut = null
  deleted = false
  tokenRejected = null
  calls = 0
  staleGet = null
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

/**
 * 🔴 **衝突の選択が済むまで、端末の暫定版をサーバーへ送らない。**
 *
 * 衝突を見つけた時、端末は自分の版を暫定値として控え、土台と版番号を「今のサーバー」に進める
 * （選んだ結果をそのまま送れるようにするため）。すると次の同期（電波の復帰・画面への復帰・
 * WebSocket）は「変わっていない」と判定し、**未送信があるので暫定版を送り、受理されてしまう**。
 * パネルで何も選んでいないのに相手の編集が上書きされる（2026-09-19、監査が再現）。
 */
describe('衝突の選択が済むまで', () => {
  async function conflicted() {
    await serverHolds({ ...empty, bookings: [bk('1', '夕食')] })
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [{ ...bk('1', '夕食'), amount: 4000 }] })
    await serverHolds({ ...empty, bookings: [{ ...bk('1', '夕食'), amount: 5000 }] })
    expect(await push(s)).toBe('conflict')
    expect((await serverState()).bookings[0].amount).toBe(5000)
    expect(hasUnresolvedConflict(ROOM)).toBe(true)
  }

  it('次の取り込みと送信を続けても、相手の版を上書きしない', async () => {
    await conflicted()
    // 電波の復帰・画面への復帰で走る resync と同じ：取り込み→未送信があれば送る
    expect(await pull(s)).toBe('unchanged')
    expect(await push(s)).toBe('conflict')
    expect((await serverState()).bookings[0].amount).toBe(5000)
  })

  it('WebSocket 経路（applyRemote が ahead）の後の送信でも、上書きしない', async () => {
    await conflicted()
    const theirs = await serverState()
    expect(applyRemote(ROOM, theirs, server.rev)).toBe('ahead')
    expect(await push(s)).toBe('conflict')
    expect((await serverState()).bookings[0].amount).toBe(5000)
  })

  it('選んでいる間に足した記録は端末に残り、選び終えたら送られる（相手の版は消えない）', async () => {
    await conflicted()
    const list = pendingConflictsOf(ROOM)
    expect(list).toHaveLength(1)
    // パネルを見ている間に1件足した（端末には保存される。送信は保留のまま）
    const now = localState(ROOM)!
    commitLocal(ROOM, { ...now, bookings: [...now.bookings, bk('2', '朝食')] })
    expect(await push(s)).toBe('conflict')
    expect((await serverState()).bookings.map((b) => b.description)).toEqual(['夕食'])

    // 「他の端末を残す」を選んだ → 相手の 5000 のまま、足した朝食も届く
    const local = localState(ROOM)!
    local.bookings = local.bookings.map((b) => (b.id === '1' ? list[0].theirs! : b))
    resolveBookings(ROOM, local)
    expect(hasUnresolvedConflict(ROOM)).toBe(false)
    expect(await push(s)).toBe('synced')
    const onServer = await serverState()
    expect(onServer.bookings.find((b) => b.id === '1')!.amount).toBe(5000)
    expect(onServer.bookings.map((b) => b.id).sort()).toEqual(['1', '2'])
  })

  it('選び終えたら（どの解決方法でも）保留は解ける', async () => {
    await conflicted()
    resolveKeepMine(ROOM, localState(ROOM)!, server.rev)
    expect(hasUnresolvedConflict(ROOM)).toBe(false)
    // 「この端末を残す」を選んだ＝そこで初めて自分の版がサーバーへ届く（選択の結果）
    expect(await push(s)).toBe('synced')
    expect((await serverState()).bookings[0].amount).toBe(4000)
    await conflicted2()
    resolveTakeTheirs(ROOM, await serverState(), server.rev)
    expect(hasUnresolvedConflict(ROOM)).toBe(false)
  })

  /** 2度目の衝突を作る（1度目を解いた後の部屋で） */
  async function conflicted2() {
    const cur = localState(ROOM)!
    commitLocal(ROOM, { ...cur, bookings: cur.bookings.map((b) => ({ ...b, amount: 7000 })) })
    await serverHolds({ ...empty, bookings: [{ ...bk('1', '夕食'), amount: 8000 }] })
    expect(await push(s)).toBe('conflict')
    expect(hasUnresolvedConflict(ROOM)).toBe(true)
  }

  it('保留は相手が更に動いても解けない（相手の版を黙って上書きする形に戻らない）', async () => {
    await conflicted()
    // 相手が別の記録を足した。この時の取り込みは衝突を出さずにマージが成立しうるが、
    // 「夕食」の食い違いは選ばれていないまま
    await serverHolds({
      ...empty,
      bookings: [{ ...bk('1', '夕食'), amount: 5000 }, bk('9', '土産')],
    })
    await pull(s)
    expect(hasUnresolvedConflict(ROOM)).toBe(true)
    expect(await push(s)).toBe('conflict')
    expect((await serverState()).bookings.find((b) => b.id === '1')!.amount).toBe(5000)
  })

  /**
   * 🔴 印は端末の控えにある＝ページの読み直し・OS によるアプリの破棄・同じオリジンの別タブでも
   * 消えない（メモリだけの印だった最初の版で、独立レビューが再現した穴）。
   * 読み直しは、モジュールを作り直して同じ localStorage を読ませて表す。
   */
  it('ページを読み直した後も、暫定版を送らない（印は端末の控えにある）', async () => {
    await conflicted()
    vi.resetModules()
    const fresh = await import('../src/client/store')
    expect(fresh.hasUnresolvedConflict(ROOM)).toBe(true)
    expect(await fresh.pull(s)).toBe('unchanged')
    expect(await fresh.push(s)).toBe('conflict')
    expect((await serverState()).bookings[0].amount).toBe(5000)
  })

  it('読み直した後に相手がさらに動いても、材料が無いので丸ごと選ばせる（暫定版は送らない）', async () => {
    await conflicted()
    vi.resetModules()
    const fresh = await import('../src/client/store')
    await serverHolds({
      ...empty,
      bookings: [{ ...bk('1', '夕食'), amount: 5000 }, bk('9', '土産')],
    })
    // 件別の材料はメモリにしか無い。マージを進めると、選んでいない食い違いが黙って通る
    expect(await fresh.pull(s)).toBe('conflict')
    expect(fresh.pendingConflictsOf(ROOM)).toHaveLength(0)
    expect(await fresh.push(s)).toBe('conflict')
    const onServer = await serverState()
    expect(onServer.bookings.find((b) => b.id === '1')!.amount).toBe(5000)
    expect(onServer.bookings.map((b) => b.id).sort()).toEqual(['1', '9'])
  })

  /**
   * 🔴 選択待ちの間に、**別の1件**でも食い違った時。土台が既に相手の版へ進んでいるので、
   * 最初の食い違いは「手元だけの変更」に見えて、今回の一覧から消える。消えたまま2件目だけ
   * 選ぶと、最初の暫定版が黙って送られて相手の版が消える（独立レビューが再現）。
   */
  it('選択待ちの間に別の1件でも食い違っても、最初の食い違いは一覧に残る', async () => {
    const at = (x: number, z: number): RoomState => ({
      ...empty,
      bookings: [{ ...bk('1', '夕食'), amount: x }, { ...bk('2', '朝食'), amount: z }],
    })
    await serverHolds(at(3000, 1000))
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, at(4000, 1000)) // 夕食を4000に
    await serverHolds(at(5000, 1000)) // 相手は夕食を5000に
    expect(await push(s)).toBe('conflict')

    const cur = localState(ROOM)!
    commitLocal(ROOM, { ...cur, bookings: cur.bookings.map((b) => (b.id === '2' ? { ...b, amount: 3333 } : b)) })
    await serverHolds(at(5000, 2222)) // 相手は朝食も2222に
    expect(await pull(s)).toBe('conflict')
    const ids = pendingConflictsOf(ROOM).map((c) => (c.mine ?? c.theirs)!.id).sort()
    expect(ids).toEqual(['1', '2']) // 最初の食い違い（夕食）が消えていない

    // 2件とも「他の端末を残す」→ 相手の版のまま、送れる
    const list = pendingConflictsOf(ROOM)
    const local = localState(ROOM)!
    for (const c of list) {
      const id = (c.mine ?? c.theirs)!.id
      local.bookings = local.bookings.map((b) => (b.id === id ? c.theirs! : b))
    }
    resolveBookings(ROOM, local)
    expect(await push(s)).toBe('synced')
    const onServer = await serverState()
    expect(onServer.bookings.find((b) => b.id === '1')!.amount).toBe(5000)
    expect(onServer.bookings.find((b) => b.id === '2')!.amount).toBe(2222)
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


/**
 * 🔴 **送っている間に取り込んだ「自分の応答より新しい版」を巻き戻さないこと。**
 *
 * 巻き戻すと土台（base）が実際に見た版より古くなり、次のマージで
 * **消したはずの記録が復活する**（2026-09-07 のレビューで実測された壊れ方）。
 */
describe('送信中に相手の版が届いた時', () => {
  const withB = (bs: Booking[]): RoomState => ({ ...empty, bookings: bs })

  it('土台と版を巻き戻さない（消した記録が復活しない）', async () => {
    await serverHolds(withB([bk('X', '宿')]))
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, withB([bk('X', '宿'), bk('M', '自分の記録')]))

    // 送信中に、相手がさらに書いた版が WebSocket で届く
    duringPut = async () => {
      await serverHolds(withB([bk('X', '宿'), bk('M', '自分の記録'), bk('T', '相手の記録')]))
      applyRemote(ROOM, withB([bk('X', '宿'), bk('M', '自分の記録'), bk('T', '相手の記録')]), server.rev)
    }
    await push(s)

    const localRev = JSON.parse(mem.get('michizure.state.' + ROOM)!).rev
    const base = JSON.parse(mem.get('michizure.state.' + ROOM)!).base.bookings.map((b: Booking) => b.id)
    expect(localRev).toBe(server.rev)      // 巻き戻っていない
    expect(base.sort()).toEqual(['M', 'T', 'X'])  // 土台は「実際に見た版」

    // ここで相手の記録を消して送ると、土台が正しければ消えたまま送れる
    commitLocal(ROOM, withB([bk('X', '宿'), bk('M', '自分の記録')]))
    await push(s)
    expect((await serverState()).bookings.map((b) => b.id).sort()).toEqual(['M', 'X'])
  })
})


/**
 * 🔴 **部屋が消えていたことを、通信の失敗と区別する。**
 * 以前は 404 を「繋がらない」と同じに扱い、削除済みの部屋を開いた端末は「未同期」のまま
 * 送り続けていた＝以後足した記録はどこにも届かず、削除も知らされなかった（2026-09-10 の監査）。
 */
describe('部屋がサーバーから消えていた時', () => {
  it('送信は gone を返す（pending や offline にしない）', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    deleted = true
    expect(await push(s)).toBe('gone')
  })

  it('取り込みは RoomGoneError を投げる', async () => {
    deleted = true
    await expect(pull(s)).rejects.toBeInstanceOf(RoomGoneError)
  })

  it('消えていても、端末の控えは消さない（本人が決めるまで残す）', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    deleted = true
    await push(s)
    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['居酒屋'])
  })
})

/**
 * 🔴 **トークンが断られたら、通信の失敗と区別して知らせる。送り直しを続けない。**
 *
 * 以前は 401 を「繋がらない」と同じに扱っていた。だから最後に合言葉で入ってから30日経った端末は
 * 「未同期」のまま黙って止まり、合言葉を聞き直す経路も無かった＝以後足した記録はどこにも届かず、
 * 本人は理由を知らされない（2026-09-11 に発見。設計は「30日で再認証」を意図している）。
 */
describe('接続用のトークンが断られた時（30日の期限切れなど）', () => {
  it('送信は expired を返す（pending にしない）', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    tokenRejected = 'ours'
    expect(await push(s)).toBe('expired')
  })

  it('断られた送信は1回きりで、送り直さない', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    tokenRejected = 'ours'
    calls = 0
    await push(s)
    expect(calls).toBe(1)
  })

  it('取り込みは TokenRejectedError を投げる', async () => {
    tokenRejected = 'ours'
    await expect(pull(s)).rejects.toBeInstanceOf(TokenRejectedError)
  })

  it('断られても、未送信の記録は端末に残し未送信のまま（入り直した後の合流で送る）', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    tokenRejected = 'ours'
    await push(s)
    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['居酒屋'])
    expect(isDirty(ROOM)).toBe(true)
  })

  it('当サービス以外が返した 401 は、トークンの失効と見なさない（負の対照）', async () => {
    expect(await pull(s)).toBe('adopted')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    tokenRejected = 'foreign'
    expect(await push(s)).toBe('pending')
  })
})

/**
 * 🔴 **送り終えた後に、送る前の古い版が届いても巻き戻さない。**
 *
 * 2026-09-11、実ブラウザで踏んだ。入り直した直後は「WebSocket を繋ぐ」と「未送信を送る」が
 * 同時に走る。WebSocket が繋いだ瞬間に送ってくる版（送信前＝古い）の復号が、送信の完了より
 * 後になると、「未送信なし」の端末はそれを黙って採用していた＝**送ったばかりの記録が画面から
 * 消え、しかも「保存済み」と出る**（サーバーには届いている。次の同期で戻るので失われはしない）。
 * 圏外入室 → 正式入室（設計 §9.1）も同じ形。版の番号は減らないので、手元より古い版は捨ててよい。
 */
describe('送り終えた後に、送る前の古い版が届いた時', () => {
  it('WebSocket で届いた古い版で、送り終えた中身を巻き戻さない', async () => {
    expect(await pull(s)).toBe('adopted')
    const old = { ciphertext: server.ciphertext, iv: server.iv, rev: server.rev }
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    expect(await push(s)).toBe('synced')
    applyRemote(ROOM, await open<RoomState>(encKeyBits, old.ciphertext, old.iv), old.rev)
    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['居酒屋'])
    expect(isDirty(ROOM)).toBe(false)
  })

  it('取り込み（GET）の応答が古い版でも、巻き戻さない', async () => {
    expect(await pull(s)).toBe('adopted')
    const old = { ciphertext: server.ciphertext, iv: server.iv, rev: server.rev }
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    expect(await push(s)).toBe('synced')
    staleGet = old
    await pull(s)
    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['居酒屋'])
  })

  /**
   * 🔴 **版が本当に戻った時（運営者が時点復元＝PITR をした時）に、同期が永久に止まらないこと。**
   * 「手元より古い版は捨てる」を素直に書くと、戻ったサーバーの版を全て捨て、送れば 409・
   * 取り込めば捨てる、を繰り返して二度と送れなくなる（2026-09-11 の自己レビューで発見）。
   * ⇒ 古い応答は一度だけ取り直す。取り直しても古いなら、それが今のサーバー。
   */
  it('サーバーの版が本当に戻った時は、取り込んで送れる（時点復元）', async () => {
    expect(await pull(s)).toBe('adopted')
    const restored = { ciphertext: server.ciphertext, iv: server.iv, rev: server.rev }
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋')] })
    expect(await push(s)).toBe('synced')
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋'), bk('2', '宿')] })
    expect(await push(s)).toBe('synced')
    // 運営者が2回前の時点へ戻した
    server.ciphertext = restored.ciphertext
    server.iv = restored.iv
    server.rev = restored.rev
    commitLocal(ROOM, { ...empty, bookings: [bk('1', '居酒屋'), bk('2', '宿'), bk('3', '朝食')] })
    // ⚠ 見るのは「止まらない」と「未送信の記録が届く」まで。戻された分（居酒屋・宿）をどう扱うか
    //   （戻しを受け入れて消えたとみなすか、端末から戻し直すか）は、ここでは決めていない
    //   ＝今の3方向マージは「相手が消した」と読む。時点復元の運用を決める時に決めること
    expect(await push(s)).toBe('synced')
    expect((await serverState()).bookings.map((b) => b.description)).toContain('朝食')
  })

  it('新しい版は今までどおり取り込む（負の対照）', async () => {
    expect(await pull(s)).toBe('adopted')
    await serverHolds({ ...empty, bookings: [bk('2', '相手の記録')] })
    applyRemote(ROOM, await serverState(), server.rev)
    expect(localState(ROOM)?.bookings.map((b) => b.description)).toEqual(['相手の記録'])
  })
})
