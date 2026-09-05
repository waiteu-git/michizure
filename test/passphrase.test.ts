import { describe, it, expect } from 'vitest'
import {
  PASSPHRASE_WORDS,
  generatePassphrase,
  estimateBits,
  customPassphraseTooWeak,
  MIN_CUSTOM_BITS,
} from '../src/client/passphrase'
import { WORDS } from '../src/client/wordlist-data'

/**
 * 🔴 このファイルは 2026-09-05 まで **テストが1つも無かった**。
 * 監査はそれを指摘したが、反証役3人全員が「test/ に passphrase の語がある」を
 * 根拠に棄却した——実体は `deriveKeys(passphrase, ...)` という**引数名**のヒットで、
 * このモジュールを import しているテストは1つも無かった。
 * ⇒ **grep のヒットは意味の証拠にならない。** 参照の有無は import で数える。
 */
describe('合言葉の生成', () => {
  it('語数と語彙は設計どおり', () => {
    expect(PASSPHRASE_WORDS).toBe(5)
    expect(WORDS.length).toBe(1024)
    expect(Math.log2(WORDS.length)).toBe(10) // 2のべき乗＝剰余の偏りが出ない
  })

  it('生成した合言葉は5語で、すべて語彙の中にある', () => {
    for (let i = 0; i < 50; i++) {
      const words = generatePassphrase().split('・')
      expect(words).toHaveLength(5)
      for (const w of words) expect(WORDS).toContain(w)
    }
  })

  it('語彙全体が引かれる（先頭に偏らない）', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 4000; i++) for (const w of generatePassphrase().split('・')) seen.add(w)
    // 20,000回引いて1,024語のうち大半が出ないなら、引き方が偏っている
    expect(seen.size).toBeGreaterThan(900)
  })

  it('生成した合言葉は下限を余裕で超える', () => {
    for (let i = 0; i < 20; i++) {
      expect(estimateBits(generatePassphrase())).toBeGreaterThan(MIN_CUSTOM_BITS)
    }
  })
})

describe('自分で決めた合言葉の強度', () => {
  /**
   * 🔴 区切りは鍵に入らない。**入るのは正規化した後の文字列だけ。**
   * ここが生の入力を測っていたため、区切りを打つだけで約2倍に水増しされていた。
   */
  it('区切りで水増しされない', () => {
    expect(estimateBits('あ・い・う・え・お・か・き・く')).toBe(estimateBits('あいうえおかきく'))
    expect(estimateBits('ね こ い ぬ と り う し')).toBe(estimateBits('ねこいぬとりうし'))
    expect(estimateBits('a-b-c-d-e-f-g-h')).toBe(estimateBits('abcdefgh'))
  })

  it('区切りだけで下限を通過できない', () => {
    expect(customPassphraseTooWeak('あ・い・う・え・お・か・き・く')).toBe(true)
  })

  it('同じ並びの繰り返しは情報として数えない', () => {
    expect(customPassphraseTooWeak('あいうえお'.repeat(5))).toBe(true)
  })

  it('カタカナで打っても評価は同じ（正規化を通すため）', () => {
    expect(estimateBits('ヒカンジダイ')).toBe(estimateBits('ひかんじだい'))
  })

  it('絵文字はコードポイントで数える（UTF-16で倍に数えない）', () => {
    // 8個の異なる絵文字＝異なり8・長さ8 ⇒ log2(8)*8 = 24
    expect(estimateBits('😀😁😂😃😄😅😆😇')).toBe(24)
  })

  it('空・空白だけは 0', () => {
    expect(estimateBits('')).toBe(0)
    expect(estimateBits('   ')).toBe(0)
    expect(estimateBits('・・・')).toBe(0)
  })
})
