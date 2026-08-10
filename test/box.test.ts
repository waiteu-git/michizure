import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal, open } from '../src/box'

const FAST = 1000 // サーバーを介さないので低い値でよい

async function key(passphrase = 'ことば') {
  return (await deriveKeys(passphrase, generateSalt(), FAST)).encKeyBits
}

const state = {
  name: '沖縄旅行',
  members: [{ id: 'm1', name: '山田' }],
  bookings: [{ id: 'b1', amount: 12345 }],
}

describe('暗号化', () => {
  it('往復して元に戻る', async () => {
    const k = await key()
    const { ciphertext, iv } = await seal(k, state)
    expect(await open(k, ciphertext, iv)).toEqual(state)
  })

  it('IV は毎回異なる', async () => {
    const k = await key()
    const a = await seal(k, state)
    const b = await seal(k, state)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('暗号文に平文が現れない', async () => {
    const k = await key()
    const { ciphertext } = await seal(k, state)
    expect(ciphertext).not.toContain('沖縄旅行')
    expect(ciphertext).not.toContain('山田')
    expect(ciphertext).not.toContain('12345')
  })

  it('別の鍵では復号できない', async () => {
    const { ciphertext, iv } = await seal(await key('ことばA'), state)
    await expect(open(await key('ことばB'), ciphertext, iv)).rejects.toThrow()
  })

  it('改ざんされた暗号文を拒否する', async () => {
    const k = await key()
    const { ciphertext, iv } = await seal(k, state)
    const bytes = atob(ciphertext).split('')
    bytes[0] = bytes[0] === 'A' ? 'B' : 'A'
    await expect(open(k, btoa(bytes.join('')), iv)).rejects.toThrow()
  })

  // 計画には無いが追加した。base64 変換を String.fromCharCode(...bytes) で書くと
  // 引数が多すぎて RangeError になる。上限 256KB まで実際に往復することを固定する
  it('上限サイズに近い大きな状態でも往復できる', async () => {
    const k = await key()
    const big = {
      name: '大きな旅行',
      members: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `メンバー${i}` })),
      bookings: Array.from({ length: 1200 }, (_, i) => ({
        id: `b${i}`,
        category: '宿泊',
        description: `予約${i}の説明`,
        amount: i * 100,
      })),
    }
    const { ciphertext, iv } = await seal(k, big)
    expect(ciphertext.length).toBeGreaterThan(100 * 1024)
    expect(await open(k, ciphertext, iv)).toEqual(big)
  })
})
