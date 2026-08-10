import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'

const FAST = 1000 // テスト用の低い反復回数

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

describe('鍵導出', () => {
  it('ソルトは毎回異なる', () => {
    const salts = new Set(Array.from({ length: 50 }, () => generateSalt()))
    expect(salts.size).toBe(50)
  })

  it('同じ合言葉とソルトから同じ鍵が出る', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('たびのあいことば', salt, FAST)
    const b = await deriveKeys('たびのあいことば', salt, FAST)
    expect(b.authKey).toBe(a.authKey)
    expect(b64(b.encKeyBits)).toBe(b64(a.encKeyBits))
  })

  it('合言葉が違えば鍵も違う', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('ことばA', salt, FAST)
    const b = await deriveKeys('ことばB', salt, FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('ソルトが違えば鍵も違う', async () => {
    const a = await deriveKeys('おなじ', generateSalt(), FAST)
    const b = await deriveKeys('おなじ', generateSalt(), FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('authKey と encKey は別物である', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ことば', generateSalt(), FAST)
    expect(authKey).not.toBe(b64(encKeyBits))
  })

  it('鍵に合言葉の平文が含まれない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ひみつのことば', generateSalt(), FAST)
    expect(authKey).not.toContain('ひみつのことば')
    expect(b64(encKeyBits)).not.toContain('ひみつのことば')
  })
})
