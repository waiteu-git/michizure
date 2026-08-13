import { KDF_VERSION } from './types.ts'
// 本番の反復回数。ローエンド端末で実測して調整すること（設計 §16 の未決事項）
export const PBKDF2_ITERATIONS = 600_000

const enc = new TextEncoder()

// String.fromCharCode(...bytes) は引数の個数がそのままスタックに積まれるため、
// 数万バイトの暗号文を渡すと RangeError になる。分割して積む
const CHUNK = 0x8000

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function generateSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

/**
 * 合言葉のうち「区切り」として扱う文字。⚠ `ー`（長音）と `。` は入れない。
 * 長音は「コーヒー」のように**単語の一部**であり、落とすと別の語になる。
 */
const SEPARATORS = /[\s・、,／/｜|\-‐–—_]+/g

/**
 * 🔴 合言葉は必ず正規化してから鍵に通す。ここは【鍵導出の契約の一部】である。
 *
 * 正規化しないと、見た目が同じでも端末や入力方法の差で鍵が変わり、
 * **「正しい合言葉なのに入室できない」**が起きる。症状から原因が全く見えない。
 *
 * 順序も契約に含まれる（順序が変われば結果が変わる）:
 *   1. NFKC        … 濁点の合成/分解・全角半角・半角カタカナを揃える
 *   2. カタカナ→ひらがな … IME の状態でカタカナ確定してしまう事故を吸収する
 *   3. 区切りと空白を除去 … 区切り方の違いで弾かれないようにする
 *
 * ⚠ NFC ではなく NFKC を選んでいる。パスワードの国際化を扱う PRECIS（RFC 8265）は
 * エントロピー保持のため NFC を規定しており、**これは意図的な逸脱**である。
 * 理由＝日本語IMEでは全角英数や**半角カタカナ**が意図せず混入するほうが、
 * 全角半角を使い分けて強度を作る利用者より圧倒的に多い（`ｱ` は NFC では畳まれず、
 * 手順2のカタカナ範囲にも入らないので、NFC のままだと半角カタカナ入力が必ず弾かれる）。
 *
 * ⚠ **この規則を変えると、それ以前に作られた部屋が開けなくなる。**
 * だから `kdfVersion` を部屋ごとに保存し、部屋が作られた時の規則で導出する。
 */
export function normalizePassphrase(passphrase: string, kdfVersion = KDF_VERSION): string {
  if (kdfVersion !== 1) {
    throw new Error(`未知の kdfVersion: ${kdfVersion}（この版では導出できない）`)
  }
  const nfkc = passphrase.normalize('NFKC')
  const hiragana = [...nfkc]
    .map((c) => {
      const n = c.codePointAt(0)!
      // カタカナ（ァ〜ヶ）だけを畳む。`ー`(U+30FC) は範囲外なので残る
      return n >= 0x30a1 && n <= 0x30f6 ? String.fromCodePoint(n - 0x60) : c
    })
    .join('')
  return hiragana.replace(SEPARATORS, '')
}

/**
 * 合言葉から authKey（サーバーへ送る）と encKey（送らない）を導出する。
 * 別々の info から HKDF で分岐させるため、authKey が漏れても encKey は導出できない。
 */
export async function deriveKeys(
  passphrase: string,
  salt: string,
  iterations: number,
  kdfVersion = KDF_VERSION,
): Promise<{ authKey: string; encKeyBits: ArrayBuffer }> {
  const pwKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalizePassphrase(passphrase, kdfVersion)),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
    pwKey,
    256,
  )
  const master = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits'])

  const derive = (info: string) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
      master,
      256,
    )

  const [authBits, encKeyBits] = await Promise.all([
    derive('michizure-auth-v1'),
    derive('michizure-enc-v1'),
  ])
  return { authKey: toBase64(new Uint8Array(authBits)), encKeyBits }
}
