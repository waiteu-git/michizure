// npm test の前に自動で走る。合言葉の単語リストが満たすべき条件を機械で守る。
// ⚠ テスト（vitest）は workerd の中で走りファイルを読めないので、検査はここに置く。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'wordlist/michizure-ja-1024.txt')
const failures = []

if (!existsSync(path)) {
  console.error(`単語リストがありません: ${path}（node scripts/build-wordlist.mjs で生成）`)
  process.exit(1)
}

const words = readFileSync(path, 'utf8').trim().split('\n').map((w) => w.trim())
const SMALL = 'ゃゅょぁぃぅぇぉゎ'
const mora = (w) => [...w].filter((c) => !SMALL.includes(c)).length
const stripVoicing = (w) =>
  [...w.normalize('NFD')].filter((c) => c !== '゙' && c !== '゚').join('').normalize('NFC')
const foldSmall = (w) =>
  [...w].map((c) => (SMALL.includes(c) ? String.fromCharCode(c.charCodeAt(0) + 1) : c)).join('')
const phoneticKey = (w) =>
  foldSmall(stripVoicing(w))
    .replace(/おう/g, 'おお')
    .replace(/えい/g, 'ええ')
    .replace(/ぢ/g, 'じ')
    .replace(/づ/g, 'ず')

// 🔴 語数は2のべき乗でなければならない。そうでないと乱数から語を選ぶのに
// 棄却サンプリングが要り、`% n` と書いても動いてしまって【偏りがテストに出ない】
if (!Number.isInteger(Math.log2(words.length))) {
  failures.push(
    `語数が2のべき乗でない（${words.length}語）。乱数の切り出しに偏りが入り、それはテストに出ない`,
  )
}
if (words.length !== 1024) {
  failures.push(`語数が1024でない（${words.length}語）。設計 §7.6 の裁定は 1,024語×5語`)
}

const dup = words.length - new Set(words).size
if (dup > 0) failures.push(`重複が ${dup} 語ある（エントロピーが宣言より下がる）`)

const notNfc = words.filter((w) => w !== w.normalize('NFC'))
if (notNfc.length > 0) {
  failures.push(
    `NFC でない語が ${notNfc.length} 語ある（例: ${notNfc[0]}）。IME 出力と一致せず入力できない`,
  )
}

const bad = words.filter((w) => !/^[ぁ-ゖ]+$/.test(w) || w.includes('ー'))
if (bad.length > 0) failures.push(`ひらがな以外を含む語が ${bad.length} 語ある（例: ${bad[0]}）`)

const badLen = words.filter((w) => w.length < 3 || w.length > 5 || mora(w) < 3)
if (badLen.length > 0) {
  failures.push(`長さの条件を外れる語が ${badLen.length} 語ある（例: ${badLen[0]}）`)
}

const collide = (fn, label) => {
  const seen = new Map()
  for (const w of words) {
    const k = fn(w)
    if (seen.has(k)) failures.push(`${label}: 「${seen.get(k)}」と「${w}」が衝突する`)
    else seen.set(k, w)
  }
}
collide((w) => w.slice(0, 3), '先頭3文字が同じ')
collide(stripVoicing, '濁点を取ると同型')
collide(phoneticKey, '聞き取りで潰れる')

if (failures.length > 0) {
  console.error('単語リストの検査に失敗しました:')
  for (const f of failures.slice(0, 12)) console.error(`  - ${f}`)
  if (failures.length > 12) console.error(`  … 他 ${failures.length - 12} 件`)
  process.exit(1)
}
