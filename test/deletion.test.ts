import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'

const FAST = 100_000 // サーバーが受け付ける最小値（MIN_ITERATIONS）

async function createRoom(passphrase = 'けす') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name: '削除テスト' })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), salt, authKey }
}

async function del(roomId: string, authKey: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey }),
  })
}

async function blobStatus(roomId: string, token: string) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.status
}

describe('部屋の削除', () => {
  it('正しい authKey で削除できる', async () => {
    const room = await createRoom()
    expect((await del(room.roomId, room.authKey)).status).toBe(200)
    expect(await blobStatus(room.roomId, room.token)).toBe(404)
  })

  it('誤った authKey では削除できない', async () => {
    const room = await createRoom('けす')
    const wrong = (await deriveKeys('ちがう', room.salt, FAST)).authKey
    expect((await del(room.roomId, wrong)).status).toBe(401)
    expect(await blobStatus(room.roomId, room.token)).toBe(200)
  })

  // 計画には無いが追加した。削除は「消えたつもりで消えていない」が最悪の壊れ方であり、
  // blob の 404 だけでは auth や meta が残っていても気づけない
  it('削除するとストレージに何も残らない', async () => {
    const room = await createRoom()
    await del(room.roomId, room.authKey)
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    const dump = await runInDurableObject(stub, async (instance: Room) => instance.dumpForTest())
    expect(JSON.parse(dump)).toEqual({ _storage_kv: {} })
  })
})

describe('削除の抜け道', () => {
  // 削除したのにデータが戻るのは、privacy 上いちばん悪い壊れ方
  it('削除後に、生きている WebSocket から書き戻せない', async () => {
    const room = await createRoom()
    const res = await SELF.fetch(
      `https://example.com/api/rooms/${room.roomId}/ws?token=${room.token}`,
      { headers: { Upgrade: 'websocket' } },
    )
    const ws = res.webSocket!
    ws.accept()
    await new Promise((r) => setTimeout(r, 100))

    expect((await del(room.roomId, room.authKey)).status).toBe(200)

    // 削除を知らない（あるいは知っていて悪意のある）クライアントが更新を送る。
    // サーバーが接続を閉じていれば send 自体が例外になる。どちらでも
    // 確かめたい不変条件は同じ＝【部屋が復活しないこと】
    try {
      ws.send(
        JSON.stringify({
          type: 'update',
          blob: { ciphertext: 'Zm9v', iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 },
        }),
      )
    } catch {
      // 接続が閉じられている＝期待どおり
    }
    await new Promise((r) => setTimeout(r, 200))

    expect(await blobStatus(room.roomId, room.token)).toBe(404)
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    const dump = await runInDurableObject(stub, async (instance: Room) => instance.dumpForTest())
    expect(JSON.parse(dump)).toEqual({ _storage_kv: {} })
  })

  // enter だけをバックオフしても、同じ authKey を試せる経路が他にあれば意味がない
  it('DELETE の連続失敗にもバックオフが効く', async () => {
    const room = await createRoom('けす')
    const wrong = (await deriveKeys('ちがう', room.salt, FAST)).authKey
    for (let i = 0; i < 5; i++) await del(room.roomId, wrong)
    expect((await del(room.roomId, room.authKey)).status).toBe(429)
    // ブロック中に削除が実行されてしまっていないこと
    expect(await blobStatus(room.roomId, room.token)).toBe(200)
  })
})

describe('認証の関門', () => {
  it('入室に成功すると失敗回数がリセットされる', async () => {
    const room = await createRoom('けす')
    const wrong = (await deriveKeys('ちがう', room.salt, FAST)).authKey
    const enter = (key: string) =>
      SELF.fetch(`https://example.com/api/rooms/${room.roomId}/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authKey: key }),
      })

    for (let i = 0; i < 4; i++) expect((await enter(wrong)).status).toBe(401)
    expect((await enter(room.authKey)).status).toBe(200) // ここでリセット
    // リセットされていれば、また4回外しても 429 にはならない
    for (let i = 0; i < 4; i++) expect((await enter(wrong)).status).toBe(401)
    expect((await enter(room.authKey)).status).toBe(200)
  })

  // 減衰が無いと「先月打ち間違えた5回」が永久に効き、次の1回でいきなり長時間ロックされる
  it('古い失敗は時間で減衰する', async () => {
    const room = await createRoom('けす')
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (i: Room) =>
      i.setGateForTest({
        failures: 20,
        blockedUntil: Date.now() + 60 * 60 * 1000,
        lastFailureAt: Date.now() - 25 * 60 * 60 * 1000, // 25時間前
      }),
    )
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: room.authKey }),
    })
    expect(res.status).toBe(200)
  })

  it('新しい失敗は減衰しない', async () => {
    const room = await createRoom('けす')
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (i: Room) =>
      i.setGateForTest({
        failures: 20,
        blockedUntil: Date.now() + 60 * 60 * 1000,
        lastFailureAt: Date.now() - 60 * 1000, // 1分前
      }),
    )
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: room.authKey }),
    })
    expect(res.status).toBe(429)
  })
})

describe('自動削除', () => {
  // alarm が仕掛かっていなければ「1年で自動削除」は無言で起きない
  it('部屋を作ると1年後の alarm が仕掛かる', async () => {
    const room = await createRoom()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    const at = await runInDurableObject(stub, async (_i: Room, state: DurableObjectState) =>
      state.storage.getAlarm(),
    )
    expect(at).not.toBeNull()
    const year = 365 * 24 * 60 * 60 * 1000
    expect(at! - Date.now()).toBeGreaterThan(year - 60_000)
    expect(at! - Date.now()).toBeLessThanOrEqual(year)
  })

  it('1年経過していれば alarm でデータが消える', async () => {
    const room = await createRoom()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (instance: Room) => {
      await instance.setLastAccessForTest(Date.now() - 400 * 24 * 60 * 60 * 1000)
      await instance.alarm()
    })
    expect(await blobStatus(room.roomId, room.token)).toBe(404)
  })

  it('1年経過していなければ alarm でも消えない', async () => {
    const room = await createRoom()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (instance: Room) => {
      await instance.setLastAccessForTest(Date.now() - 24 * 60 * 60 * 1000)
      await instance.alarm()
    })
    expect(await blobStatus(room.roomId, room.token)).toBe(200)
  })
})
