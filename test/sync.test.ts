import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import type { Room } from '../src/room'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 100_000 // サーバーが受け付ける最小値（MIN_ITERATIONS）

async function createRoom() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
  const blob = {
    ...(await seal(encKeyBits, { name: '初期', members: [], bookings: [] })),
    blobVersion: 1,
  }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), encKeyBits }
}

/**
 * 受信したメッセージを取りこぼさない接続。
 *
 * 計画の書き方（受信のたびに addEventListener する）だと、リスナを張る前に届いた
 * メッセージが観測されない。これは「送信者自身には update が返らない」テストが
 * 【壊れていても通る】ことを意味する＝エコーが早く届いただけで timeout になるため。
 * accept() の前にリスナを張って全件を配列に溜め、その配列を観測する。
 */
type Conn = {
  ws: WebSocket
  received: any[]
  next(timeoutMs?: number): Promise<any>
  close(): void
}

async function connect(roomId: string, token: string, clientId = ''): Promise<Conn> {
  const res = await SELF.fetch(
    `https://example.com/api/rooms/${roomId}/ws?token=${token}&client=${clientId}`,
    { headers: { Upgrade: 'websocket' } },
  )
  if (!res.webSocket) {
    throw new Error(`WebSocket upgrade に失敗: status=${res.status} body=${await res.text()}`)
  }
  const ws = res.webSocket
  const received: any[] = []
  const waiters: ((v: any) => void)[] = []
  ws.addEventListener('message', (e: MessageEvent) => {
    const parsed = JSON.parse(e.data as string)
    received.push(parsed)
    waiters.shift()?.(parsed)
  })
  ws.accept()

  let taken = 0
  return {
    ws,
    received,
    close: () => ws.close(1000, 'test done'),
    next(timeoutMs = 1000) {
      if (taken < received.length) return Promise.resolve(received[taken++])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        waiters.push((v) => {
          clearTimeout(timer)
          taken++
          resolve(v)
        })
      })
    },
  }
}

describe('WebSocket 中継', () => {
  it('接続時に init を受け取る', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const msg = await a.next()
    expect(msg.type).toBe('init')
    expect(msg.blob.ciphertext).toBeTruthy()
    a.close()
  })

  it('他の接続へ update が届く', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const b = await connect(room.roomId, room.token)
    const init = await a.next()
    await b.next()

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    // ⚠ 見た版を添える。添えないとサーバーが断る（同時書き込みで記録が消えないため）
    a.ws.send(JSON.stringify({ type: 'update', blob, baseRev: init.rev }))
    const received = await b.next()
    expect(received.type).toBe('update')
    expect(received.blob.ciphertext).toBe(blob.ciphertext)
    a.close()
    b.close()
  })

  // このテストは削除・簡略化してはならない。
  // 前身プロジェクトで、送信者除外が効いているつもりで実際には
  // 他端末の更新を握り潰していた不具合を、検証がなく見逃した。
  it('送信者自身には update が返らない', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const b = await connect(room.roomId, room.token)
    const init = await a.next()
    expect(init.type).toBe('init')
    expect((await b.next()).type).toBe('init')

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    a.ws.send(JSON.stringify({ type: 'update', blob, baseRev: init.rev }))

    // b が受け取ったことをもって「中継は完了した」と確定させてから a を見る。
    // 単に待つだけだと、中継が遅いのか除外が効いたのかを区別できない
    expect((await b.next()).type).toBe('update')
    await new Promise((r) => setTimeout(r, 200))

    // a は init 1件だけを受け取っているはず（update のエコーが無い）
    expect(a.received.map((m) => m.type)).toEqual(['init'])
    a.close()
    b.close()
  })

  it('update された暗号文が永続化される', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const init = await a.next()
    const blob = { ...(await seal(room.encKeyBits, { name: '永続化' })), blobVersion: 1 }
    a.ws.send(JSON.stringify({ type: 'update', blob, baseRev: init.rev }))
    await new Promise((r) => setTimeout(r, 200))
    a.close()

    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(((await res.json()) as { ciphertext: string }).ciphertext).toBe(blob.ciphertext)
  })

  // 🔴 書き込み経路は create / PUT / WS の3つある。形の検査を2つにだけ入れて
  // WS を忘れると、iv の無い update 1通で部屋の唯一の暗号文と iv が同時に消える。
  // サーバーは鍵も履歴も持たないので復旧手段が無い
  it('iv の無い update では保存済みの暗号文が壊れない', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const before = await a.next()
    expect(before.type).toBe('init')

    a.ws.send(JSON.stringify({ type: 'update', blob: { ciphertext: 'QUJDRA==' } }))
    await new Promise((r) => setTimeout(r, 200))

    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    const stored = (await res.json()) as { ciphertext: string; iv: string }
    expect(stored.ciphertext).toBe(before.blob.ciphertext)
    expect(stored.iv).toBe(before.blob.iv)
    a.close()
  })

  it('巨大な iv の update も拒否する', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const before = await a.next()

    a.ws.send(
      JSON.stringify({
        type: 'update',
        blob: { ciphertext: 'QUJDRA==', iv: 'A'.repeat(100 * 1024), blobVersion: 1 },
      }),
    )
    await new Promise((r) => setTimeout(r, 200))

    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(((await res.json()) as { iv: string }).iv).toBe(before.blob.iv)
    a.close()
  })

  // Upgrade を確認せずに WebSocketPair を作ると、使われない接続が DO に溜まり続ける
  // （Hibernation なので生き残る）。ブロードキャストの相手も増える
  it('Upgrade ヘッダのないリクエストでは WebSocket を作らない', async () => {
    const room = await createRoom()
    const res = await SELF.fetch(
      `https://example.com/api/rooms/${room.roomId}/ws?token=${room.token}`,
    )
    expect(res.webSocket).toBeFalsy()
    expect(res.status).toBe(400)

    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    const count = await runInDurableObject(stub, async (_i: Room, state: DurableObjectState) =>
      state.getWebSockets().length,
    )
    expect(count).toBe(0)
  })

  // 🔴 PUT でも中継しないと、同じ部屋を開いている人に届かない。
  // 届かないとクライアントが WS でも書くことになり、書き込み経路が増える
  it('PUT の更新が、開いている他の接続へ届く', async () => {
    const room = await createRoom()
    const b = await connect(room.roomId, room.token, 'other-device')
    const init = await b.next()
    expect(init.type).toBe('init')

    const blob = { ...(await seal(room.encKeyBits, { name: 'PUTから' })), blobVersion: 1 }
    await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        'X-Client-Id': 'writer',
      },
      body: JSON.stringify({ ...blob, baseRev: init.rev }),
    })

    const msg = await b.next()
    expect(msg.type).toBe('update')
    expect(msg.blob.ciphertext).toBe(blob.ciphertext)
    b.close()
  })

  // 前身で「除外が効いているつもりで実際には他端末の更新を握り潰していた」不具合があった。
  // 経路が増えたので、こちらの経路でも除外が効くことを固定する
  it('PUT した本人の接続には返さない', async () => {
    const room = await createRoom()
    const me = await connect(room.roomId, room.token, 'me')
    const other = await connect(room.roomId, room.token, 'other')
    const init = await me.next()
    expect(init.type).toBe('init')
    expect((await other.next()).type).toBe('init')

    const blob = { ...(await seal(room.encKeyBits, { name: '自分が書いた' })), blobVersion: 1 }
    await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        'X-Client-Id': 'me',
      },
      body: JSON.stringify({ ...blob, baseRev: init.rev }),
    })

    // 相手が受け取ったことで「中継は完了した」と確定させてから自分を見る。
    // 単に待つだけでは、中継が遅いのか除外が効いたのかを区別できない
    expect((await other.next()).type).toBe('update')
    await new Promise((r) => setTimeout(r, 200))
    expect(me.received.map((m) => m.type)).toEqual(['init'])
    me.close()
    other.close()
  })

  it('トークンなしの接続を拒否する', async () => {
    const room = await createRoom()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/ws?token=bogus`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
  })
})

/**
 * 🔴 **同時に書かれた時に、片方を黙って消さない。**
 *
 * サーバーは中身を読めないので、届いた暗号文が「今持っている版から育ったもの」か
 * を中身では判定できない。版の番号で照合し、**今の版を見ていない書き込みを断る**。
 * 断らずに通していたため、2台が同時に電波を取り戻すと後の1本が前の記録を
 * 丸ごと上書きしていた（2026-09-06、2タブの実測で再現）。
 */
describe('版の照合', () => {
  const blobOf = async (encKeyBits: ArrayBuffer, name: string) => ({
    ...(await seal(encKeyBits, { name, members: [], bookings: [] })),
    blobVersion: 1,
  })
  const put = (roomId: string, token: string, body: unknown) =>
    SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = async (roomId: string, token: string) =>
    (await (
      await SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { ciphertext: string; rev: number }

  it('読み出しに版が付いてくる', async () => {
    const room = await createRoom()
    expect((await get(room.roomId, room.token)).rev).toBeGreaterThan(0)
  })

  /**
   * 🔴 作成の応答にも版を載せること。載せないと**作った本人が今の版を知る手段が無く**、
   * 最初の書き込みが必ず 409 になり、土台も無いのでマージもできず永久に詰む
   * （2026-09-07 のレビューで3つの観点が独立に指した欠陥）。
   */
  it('作成の応答に版が入っていて、その版でそのまま書ける', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
    const blob = { ...(await seal(encKeyBits, { name: '初期', members: [], bookings: [] })), blobVersion: 1 }
    const res = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
    })
    const created = (await res.json()) as { roomId: string; token: string; rev: number }
    expect(created.rev).toBeGreaterThan(0)
    expect(created.rev).toBe((await get(created.roomId, created.token)).rev)

    // 返ってきた版をそのまま使えば、最初の書き込みが通る
    const next = await blobOf(encKeyBits, '作った直後の編集')
    expect((await put(created.roomId, created.token, { ...next, baseRev: created.rev })).status).toBe(200)
  })

  it('古い版に基づく書き込みは断られ、保存済みは変わらない', async () => {
    const room = await createRoom()
    const before = await get(room.roomId, room.token)

    // 相手が先に書いた
    const theirs = await blobOf(room.encKeyBits, '相手が書いた')
    expect((await put(room.roomId, room.token, { ...theirs, baseRev: before.rev })).status).toBe(200)

    // こちらは古い版のまま書こうとする
    const mine = await blobOf(room.encKeyBits, 'こちらが書いた')
    const res = await put(room.roomId, room.token, { ...mine, baseRev: before.rev })
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'stale' })

    // 🔴 相手の記録が消えていない
    expect((await get(room.roomId, room.token)).ciphertext).toBe(theirs.ciphertext)
  })

  it('版を添えない書き込みは断る（添え忘れを黙って通さない）', async () => {
    const room = await createRoom()
    const blob = await blobOf(room.encKeyBits, '版なし')
    expect((await put(room.roomId, room.token, blob)).status).toBe(409)
  })

  it('断られた側は、取り直した版で送れば通る', async () => {
    const room = await createRoom()
    const first = await get(room.roomId, room.token)
    await put(room.roomId, room.token, {
      ...(await blobOf(room.encKeyBits, '一度目')),
      baseRev: first.rev,
    })
    const again = await get(room.roomId, room.token)
    expect(again.rev).toBe(first.rev + 1)

    const mine = await blobOf(room.encKeyBits, '二度目')
    expect((await put(room.roomId, room.token, { ...mine, baseRev: again.rev })).status).toBe(200)
    expect((await get(room.roomId, room.token)).ciphertext).toBe(mine.ciphertext)
  })

  /**
   * ⚠ 書き込み経路は create / PUT / WS の3つ。**片面だけ守ると、
   * そちらを通るだけで上書きが復活する。**
   */
  it('WebSocket からの書き込みにも同じ照合が効く', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const init = await a.next()

    // 先に PUT で版を進めておく＝WS が握っている版はもう古い
    const theirs = await blobOf(room.encKeyBits, 'PUT が先に書いた')
    expect((await put(room.roomId, room.token, { ...theirs, baseRev: init.rev })).status).toBe(200)

    a.ws.send(
      JSON.stringify({
        type: 'update',
        blob: await blobOf(room.encKeyBits, 'WS が古い版で書く'),
        baseRev: init.rev,
      }),
    )
    await new Promise((r) => setTimeout(r, 200))

    expect((await get(room.roomId, room.token)).ciphertext).toBe(theirs.ciphertext)
    a.close()
  })
})
