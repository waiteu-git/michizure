// src/index.html → public/index.html。**コメントを落として配る。**
//
// 🔴 なぜ要るか: src/*.ts のコメントは esbuild が落とすが、HTML と CSS の
// コメントは【そのまま利用者へ配信される】。このリポは「なぜ」を厚く書く方針
// なので、それを守ったまま配信量を増やさないために、ここで落とす。
// 実測（2026-09-06）: コメントだけで gzip 613 B ＝初回読み込みの 4.8%。
//
// ⚠ 落とすのはコメントだけ。空白や属性の圧縮はしない＝生成物を人が読めるまま
// 残すほうが、公開リポで「配っている物」を確かめやすい（設計 §7.5 の姿勢）。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/index.html'), 'utf8')

const out = src
  // HTML コメント。⚠ 条件付きコメントは使っていないので単純除去でよい
  .replace(/<!--[\s\S]*?-->/g, '')
  // CSS コメント（<style> の中）
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // コメントを抜いた跡に残る空行を畳む（3行以上の空きを1行に）
  .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')

writeFileSync(join(root, 'public/index.html'), out)
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1)
console.log(`index.html を生成: ${kb(src)}KB → ${kb(out)}KB（コメント除去）`)
