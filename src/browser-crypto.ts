/**
 * ブラウザへ配る暗号層の入口。
 *
 * 🔴 ここは【再実装ではなく再輸出】である。Worker が使うのと同じ src/keys.ts・src/box.ts を
 * そのままブラウザへ届ける。暗号を2箇所に書くと、ズレた瞬間に
 * 「正しい合言葉なのに入室できない」「保存したのに復号できない」が起きる。
 */
export { deriveKeys, generateSalt, normalizePassphrase, toBase64, fromBase64 } from './keys.ts'
export { seal, open } from './box.ts'
