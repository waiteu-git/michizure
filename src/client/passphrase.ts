import { WORDS } from './wordlist-data.ts'

/** 生成する合言葉の語数（設計 §7.6・2026-08-11 裁定＝1,024語×5語 ≒ 50bit） */
export const PASSPHRASE_WORDS = 5

/**
 * 🔴 剰余を使わない。1,024 = 2^10 なので **10ビットをそのまま切り出す**。
 *
 * `% 1024` と書いても動いてしまうが、語数が2のべき乗でなくなった瞬間に
 * 静かに偏る（そして偏りはテストに出ない）。ここでビット幅を明示しておけば、
 * 語数を変えた時に検査（scripts/check-wordlist.mjs）と合わせて必ず気づく。
 */
function pickIndex(): number {
  const bits = Math.log2(WORDS.length)
  if (!Number.isInteger(bits)) {
    throw new Error(`語数が2のべき乗でない（${WORDS.length}）。この引き方は偏る`)
  }
  const buf = new Uint16Array(1)
  crypto.getRandomValues(buf)
  return buf[0] & (WORDS.length - 1)
}

/** 表示用（中黒区切り）。⚠ 鍵に通す前には正規化されるので、区切りは見た目だけの意味しかない */
export function generatePassphrase(words = PASSPHRASE_WORDS): string {
  return Array.from({ length: words }, () => WORDS[pickIndex()]).join('・')
}

/**
 * 自分で決めた合言葉の強度を、**語数ではなく推定エントロピーで**測る（設計 §7.6.1 ①）。
 * 「5語以上」のような条件は「あいうえお」×5 が通ってしまう。
 *
 * ⚠ これは目安であって証明ではない。辞書に載っている語の組み合わせは
 * ここで見積もるより弱い。**強制できるのは公式クライアント上だけ**でもある。
 */
export function estimateBits(passphrase: string): number {
  const s = passphrase.trim()
  if (s.length === 0) return 0
  // 繰り返しを畳む（「あいうえお」×5 を1回分として数える）
  const unique = new Set([...s]).size
  const charsetBits = Math.log2(Math.max(unique, 2))
  // 同じ並びの繰り返しは情報を増やさない
  const deduped = s.replace(/(.{2,})\1+/g, '$1')
  return Math.floor(charsetBits * deduped.length)
}

/** 自分で決める場合の下限。生成した5語（50bit）よりは緩めるが、桁は落とさない */
export const MIN_CUSTOM_BITS = 40

export function customPassphraseTooWeak(passphrase: string): boolean {
  return estimateBits(passphrase) < MIN_CUSTOM_BITS
}
