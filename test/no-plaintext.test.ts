import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'

const FAST = 100_000 // サーバーが受け付ける最小値（MIN_ITERATIONS）
const SECRET_NAME = 'ヒミツノリョコウメイ'
const SECRET_MEMBER = 'ヤマダタロウ'
const SECRET_AMOUNT = 987654
const PASSPHRASE = 'ヒミツノアイコトバ'

async function createRoomWithSecrets() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(PASSPHRASE, salt, FAST)
  const blob = {
    ...(await seal(encKeyBits, {
      name: SECRET_NAME,
      members: [{ id: 'm1', name: SECRET_MEMBER }],
      bookings: [{ id: 'b1', amount: SECRET_AMOUNT }],
    })),
    blobVersion: 1,
  }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, iterations: FAST }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), authKey }
}

describe('サーバーは平文を持たない', () => {
  it('作成レスポンスに平文が現れない', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys(PASSPHRASE, salt, FAST)
    const blob = { ...(await seal(encKeyBits, { name: SECRET_NAME })), blobVersion: 1 }
    const res = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt, authKey, blob, iterations: FAST }),
    })
    const text = await res.text()
    expect(text).not.toContain(SECRET_NAME)
    expect(text).not.toContain(PASSPHRASE)
  })

  it('DO のストレージに平文も合言葉も authKey も残らない', async () => {
    const room = await createRoomWithSecrets()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))

    const dump = await runInDurableObject(stub, async (instance: Room) => {
      return instance.dumpForTest()
    })

    expect(dump).not.toContain(SECRET_NAME)
    expect(dump).not.toContain(SECRET_MEMBER)
    expect(dump).not.toContain(String(SECRET_AMOUNT))
    expect(dump).not.toContain(PASSPHRASE)
    // authKey そのものではなくハッシュが保存されている
    expect(dump).not.toContain(room.authKey)
  })

  it('blob 取得レスポンスにも平文が現れない', async () => {
    const room = await createRoomWithSecrets()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    const text = await res.text()
    expect(text).not.toContain(SECRET_NAME)
    expect(text).not.toContain(SECRET_MEMBER)
  })
})
