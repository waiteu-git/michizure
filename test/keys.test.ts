import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'

const FAST = 1000 // テスト用の低い反復回数

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

describe('鍵導出', () => {
  /**
   * 🔴 既知答えテスト。値を固定するのが目的で、内容に意味は無い。
   *
   * 鍵は「合言葉 + salt + 反復回数 + アルゴリズム（PBKDF2→HKDF の info 文字列を含む）」
   * から決まる。このどれか1つでも変わると、**それ以前に作られた部屋は入室も復号も
   * できなくなる**。反復回数は部屋ごとに保存して回避したが、info 文字列や
   * ハッシュ関数の変更は保存では回避できない＝ここで固定するしかない。
   *
   * ⚠ この値が変わったら、それは「テストを直す」場面ではなく
   * 「既存の全部屋を壊す変更をしようとしている」場面である。
   */
  it('既知の入力から既知の鍵が出る（アルゴリズムを固定する）', async () => {
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA=='
    const { authKey, encKeyBits } = await deriveKeys('みちづれ', salt, 1000)
    expect(authKey).toBe('Eeinq3ssxvXetR9N0ByafyIJ9t+CASWxWcZU0Ql/Gzo=')
    expect(b64(encKeyBits)).toBe('jTAziAvFLsC89iAt8R9bU75t73c5L1g80qOwgyaUAQQ=')
  })

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

  // 設計 §13-1 の「authKey から encKey が導出できないこと」。
  // 「導出できない」ことは証明できないので、実際に成り立っている性質＝
  // 【別の info から HKDF で分岐しており、片方から他方への単純な変換が存在しない】を固定する。
  // ⚠ 単に「2つが違う」だけでは、片方が他方のハッシュでも通ってしまう
  it('encKey は authKey の単純な変換ではない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ことば', generateSalt(), FAST)
    const enc = b64(encKeyBits)
    const authBytes = Uint8Array.from(atob(authKey), (c) => c.charCodeAt(0))

    // authKey そのもの／その SHA-256／その base64 のいずれとも一致しない
    const sha = b64(await crypto.subtle.digest('SHA-256', authBytes))
    expect(enc).not.toBe(authKey)
    expect(enc).not.toBe(sha)
    expect(enc).not.toBe(btoa(authKey))
    // バイト単位でも相関が無い（一致するバイト数が偶然の範囲）
    const encBytes = new Uint8Array(encKeyBits)
    const same = authBytes.reduce((n, b, i) => n + (b === encBytes[i] ? 1 : 0), 0)
    expect(same).toBeLessThan(8) // 32バイト中、偶然の一致は期待値0.125個
  })

  it('鍵に合言葉の平文が含まれない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ひみつのことば', generateSalt(), FAST)
    expect(authKey).not.toContain('ひみつのことば')
    expect(b64(encKeyBits)).not.toContain('ひみつのことば')
  })
})
