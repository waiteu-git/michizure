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

async function getBlob(roomId: string, token: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function putBlob(roomId: string, token: string, blob: unknown) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(blob),
  })
}

describe('暗号文', () => {
  it('保存した暗号文を読み戻して復号できる', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
    const first = {
      ...(await seal(encKeyBits, { name: '初期', members: [], bookings: [] })),
      blobVersion: 1,
    }
    const created = (await (
      await SELF.fetch('https://example.com/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt, authKey, blob: first }),
      })
    ).json()) as { roomId: string; token: string }

    const updated = {
      ...(await seal(encKeyBits, {
        name: '更新後',
        members: [{ id: 'm1', name: 'A' }],
        bookings: [],
      })),
      blobVersion: 1,
    }
    expect((await putBlob(created.roomId, created.token, updated)).status).toBe(200)

    const got = (await (await getBlob(created.roomId, created.token)).json()) as {
      ciphertext: string
      iv: string
    }
    const { open } = await import('../src/box')
    expect(await open<{ name: string }>(encKeyBits, got.ciphertext, got.iv)).toMatchObject({
      name: '更新後',
    })
  })

  it('トークンなしを拒否する', async () => {
    const room = await createAndGet()
    expect((await getBlob(room.roomId, '')).status).toBe(401)
  })

  it('大きすぎる暗号文を拒否する', async () => {
    const room = await createAndGet()
    const big = { ciphertext: 'A'.repeat(300 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await putBlob(room.roomId, room.token, big)).status).toBe(413)
  })

  // 計画には無いが追加した。計画のままだと更新側の閾値だけが MAX_BLOB_BYTES*2 で、
  // 「作成では 413 なのに更新では通る」穴ができる。境界を作成と揃えたことを固定する
  it('作成で拒否されるサイズは更新でも拒否される', async () => {
    const room = await createAndGet()
    const justOver = {
      ciphertext: 'A'.repeat(256 * 1024 + 1),
      iv: 'AAAAAAAAAAAAAAAA',
      blobVersion: 1,
    }
    const justUnder = { ...justOver, ciphertext: 'A'.repeat(256 * 1024) }

    expect((await putBlob(room.roomId, room.token, justOver)).status).toBe(413)
    expect((await createRoom({ blob: justOver })).status).toBe(413)
    // 上限ちょうどは通る（境界の向きを固定する）
    expect((await putBlob(room.roomId, room.token, justUnder)).status).toBe(200)
    expect((await createRoom({ blob: justUnder })).status).toBe(200)
  })
})
