import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 1000

async function makeRoomPayload(passphrase = 'あいことば', name = '沖縄旅行') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name, members: [], bookings: [] })), blobVersion: 1 }
  return { salt, authKey, blob, encKeyBits }
}

async function createRoom(overrides: Record<string, unknown> = {}) {
  const { salt, authKey, blob } = await makeRoomPayload()
  return SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, ...overrides }),
  })
}

describe('部屋の作成', () => {
  it('roomId とトークンを返す', async () => {
    const res = await createRoom()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { roomId: string; token: string }
    expect(json.roomId).toHaveLength(16)
    expect(json.token).toBeTruthy()
  })

  it('毎回異なる roomId になる', async () => {
    const a = (await (await createRoom()).json()) as { roomId: string }
    const b = (await (await createRoom()).json()) as { roomId: string }
    expect(a.roomId).not.toBe(b.roomId)
  })

  it('authKey がなければ拒否する', async () => {
    expect((await createRoom({ authKey: '' })).status).toBe(400)
  })

  it('salt がなければ拒否する', async () => {
    expect((await createRoom({ salt: '' })).status).toBe(400)
  })

  it('大きすぎる暗号文を拒否する', async () => {
    const blob = { ciphertext: 'A'.repeat(300 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await createRoom({ blob })).status).toBe(413)
  })
})

async function createAndGet(passphrase = 'せいかい') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = {
    ...(await seal(encKeyBits, { name: 'X', members: [], bookings: [] })),
    blobVersion: 1,
  }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  const json = (await res.json()) as { roomId: string; token: string }
  return { ...json, salt, authKey }
}

async function enter(roomId: string, authKey: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey }),
  })
}

describe('入室', () => {
  it('ソルトを認証前に取得できる', async () => {
    const room = await createAndGet()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/salt`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { salt: string }).salt).toBe(room.salt)
  })

  it('正しい authKey でトークンを得る', async () => {
    const room = await createAndGet()
    const res = await enter(room.roomId, room.authKey)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { token: string }).token).toBeTruthy()
  })

  it('誤った authKey を拒否する', async () => {
    const room = await createAndGet('せいかい')
    const wrong = (await deriveKeys('まちがい', room.salt, FAST)).authKey
    expect((await enter(room.roomId, wrong)).status).toBe(401)
  })

  it('存在しない部屋は404を返す', async () => {
    expect((await enter('ZZZZZZZZZZZZZZZZ', 'anything')).status).toBe(404)
  })

  it('連続failで429になり、その後は正解でも弾かれる', async () => {
    const room = await createAndGet('せいかい')
    const wrong = (await deriveKeys('まちがい', room.salt, FAST)).authKey
    for (let i = 0; i < 5; i++) await enter(room.roomId, wrong)
    expect((await enter(room.roomId, room.authKey)).status).toBe(429)
  })
})
