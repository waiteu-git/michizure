import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal, open } from '../src/box'

const FAST = 100_000 // サーバーが受け付ける最小値（MIN_ITERATIONS）

async function createRoom(passphrase: string, name: string) {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), encKeyBits, salt, authKey }
}

describe('部屋の分離', () => {
  it('別の部屋のデータが混ざらない', async () => {
    const a = await createRoom('aaa', '部屋Aの旅行')
    await createRoom('bbb', '部屋Bの旅行')

    const resA = await SELF.fetch(`https://example.com/api/rooms/${a.roomId}/blob`, {
      headers: { Authorization: `Bearer ${a.token}` },
    })
    const blobA = (await resA.json()) as { ciphertext: string; iv: string }
    expect(await open<{ name: string }>(a.encKeyBits, blobA.ciphertext, blobA.iv)).toEqual({
      name: '部屋Aの旅行',
    })
  })

  it('部屋Aのトークンでは部屋Bを読めない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/blob`, {
      headers: { Authorization: `Bearer ${a.token}` },
    })
    expect(res.status).toBe(401)
  })

  it('部屋Aの鍵では部屋Bの暗号文を復号できない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/blob`, {
      headers: { Authorization: `Bearer ${b.token}` },
    })
    const blobB = (await res.json()) as { ciphertext: string; iv: string }
    // トークンで取得できても、鍵が違えば中身は読めない（二重の防御）
    await expect(open(a.encKeyBits, blobB.ciphertext, blobB.iv)).rejects.toThrow()
  })

  it('部屋Aの authKey では部屋Bに入れない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: a.authKey }),
    })
    expect(res.status).toBe(401)
  })
})
