import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'

const FAST = 1000

async function createRoom(passphrase = 'けす') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name: '削除テスト' })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
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
    expect(JSON.parse(dump)).toEqual([])
  })
})

describe('自動削除', () => {
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
