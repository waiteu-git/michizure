import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 1000

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
    body: JSON.stringify({ salt, authKey, blob }),
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

async function connect(roomId: string, token: string): Promise<Conn> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/ws?token=${token}`, {
    headers: { Upgrade: 'websocket' },
  })
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
    await a.next()
    await b.next()

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    a.ws.send(JSON.stringify({ type: 'update', blob }))
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
    expect((await a.next()).type).toBe('init')
    expect((await b.next()).type).toBe('init')

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    a.ws.send(JSON.stringify({ type: 'update', blob }))

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
    await a.next()
    const blob = { ...(await seal(room.encKeyBits, { name: '永続化' })), blobVersion: 1 }
    a.ws.send(JSON.stringify({ type: 'update', blob }))
    await new Promise((r) => setTimeout(r, 200))
    a.close()

    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(((await res.json()) as { ciphertext: string }).ciphertext).toBe(blob.ciphertext)
  })

  it('トークンなしの接続を拒否する', async () => {
    const room = await createRoom()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/ws?token=bogus`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
  })
})
