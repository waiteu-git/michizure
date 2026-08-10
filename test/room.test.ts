import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import { MAX_CIPHERTEXT_BYTES, ciphertextBytes } from '../src/types'

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
    // 500KiB 分の base64 文字 ≒ 375KiB のバイト列 ⇒ 上限 256KiB を超える
    const blob = { ciphertext: 'A'.repeat(500 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await createRoom({ blob })).status).toBe(413)
  })

  // ciphertext だけを見ていると、他のフィールドが素通りする。
  // iv は 12 バイトの base64（16文字）でしかありえない
  it('巨大な iv を拒否する', async () => {
    const blob = { ciphertext: 'Zm9v', iv: 'A'.repeat(2 * 1024 * 1024), blobVersion: 1 }
    const res = await createRoom({ blob })
    expect([400, 413]).toContain(res.status)
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

/** 復号後およそ n バイトになる（パディング無しの）base64 文字列。4文字=3バイト */
function base64OfBytes(n: number): string {
  return 'A'.repeat(Math.floor(n / 3) * 4)
}

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
    const big = { ciphertext: 'A'.repeat(500 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await putBlob(room.roomId, room.token, big)).status).toBe(413)
  })

  // 計画には無いが追加した。計画のままだと更新側の閾値だけが本文長で、
  // 「作成では 413 なのに更新では通る」穴ができる。境界を作成と揃えたことを固定する。
  //
  // 🔴 単位も一緒に固定している。ciphertext は base64 の【文字列】なので、
  // その文字数を 256KiB と比べると実際の上限が 3/4（192KiB）に縮み、
  // spec §7.4 の「暗号文のバイト数上限 256KB」と静かにズレる。
  it('作成と更新で境界が一致し、上限は復号後のバイト数で測られる', async () => {
    const room = await createAndGet()
    const atLimit = base64OfBytes(MAX_CIPHERTEXT_BYTES)
    const overLimit = base64OfBytes(MAX_CIPHERTEXT_BYTES + 3)
    expect(ciphertextBytes(atLimit)).toBeLessThanOrEqual(MAX_CIPHERTEXT_BYTES)
    expect(ciphertextBytes(overLimit)).toBeGreaterThan(MAX_CIPHERTEXT_BYTES)

    const over = { ciphertext: overLimit, iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    const at = { ciphertext: atLimit, iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }

    expect((await putBlob(room.roomId, room.token, over)).status).toBe(413)
    expect((await createRoom({ blob: over })).status).toBe(413)
    // 上限ちょうどは通る（境界の向きを固定する）
    expect((await putBlob(room.roomId, room.token, at)).status).toBe(200)
    expect((await createRoom({ blob: at })).status).toBe(200)

    // 文字数で切っていたら弾かれていたサイズ（192KiB超〜256KiB以下）が通ることを固定する
    const between = { ciphertext: 'A'.repeat(300 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect(ciphertextBytes(between.ciphertext)).toBeGreaterThan(196_608)
    expect(ciphertextBytes(between.ciphertext)).toBeLessThan(MAX_CIPHERTEXT_BYTES)
    expect((await putBlob(room.roomId, room.token, between)).status).toBe(200)
  })

  // 上限を緩めた（192KiB→256KiB）ので、ストレージが本当にその大きさを
  // 受けて読み戻せるかを推測せずに確かめる
  it('上限ちょうどの暗号文を保存して読み戻せる', async () => {
    const room = await createAndGet()
    const atLimit = base64OfBytes(MAX_CIPHERTEXT_BYTES)
    expect((await putBlob(room.roomId, room.token, {
      ciphertext: atLimit,
      iv: 'AAAAAAAAAAAAAAAA',
      blobVersion: 1,
    })).status).toBe(200)

    const got = (await (await getBlob(room.roomId, room.token)).json()) as { ciphertext: string }
    expect(got.ciphertext).toHaveLength(atLimit.length)
    expect(got.ciphertext).toBe(atLimit)
  })
})
