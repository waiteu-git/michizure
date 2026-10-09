// 画面の約束事を、実物のファイルで見張る（目では気づけず、テストにも出ないもの）。
//
// 🔴 2026-10-09 に実測: `.actions { display: flex }` が `hidden` 属性に勝ち、Web 版で
// 「CSVで書き出す」「購入を復元」（ネイティブのシェルの中だけのはずの購入の導線）が出ていた。
// 押すと「購入に失敗しました」になる死んだボタンで、コードは hidden = true と正しく書いていたので
// ソースを読んでも気づけなかった。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(root, 'src/index.html'), 'utf8')
const app = readFileSync(join(root, 'src/client/app.ts'), 'utf8')
let bad = false
const fail = (m) => {
  console.error(`✘ ${m}`)
  bad = true
}

// 1) hidden 属性が、display を指定するクラスに負けない
if (!/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(html)) {
  fail('src/index.html に `[hidden] { display: none !important; }` が無い（hidden が .actions などに負けて、隠した要素が出る）')
}

// 2) Enter で送る対応表の id と、押される先のボタンが、実際に HTML にある
const map = app.match(/const ENTER_SUBMITS[^{]*\{([\s\S]*?)\n\}/)
if (!map) fail('src/client/app.ts に ENTER_SUBMITS が見つからない（この検査を直す）')
else {
  const pairs = [...map[1].matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]])
  if (!pairs.length) fail('ENTER_SUBMITS が空')
  for (const [input, button] of pairs) {
    for (const id of [input, button]) {
      if (!new RegExp(`id="${id}"`).test(html)) fail(`ENTER_SUBMITS の id「${id}」が src/index.html に無い`)
    }
  }
}
// 3) 日本語入力の変換確定の Enter を送信にしない
if (!/isComposing/.test(app) || !/keyCode === 229/.test(app)) {
  fail('Enter 送信が変換確定（isComposing / keyCode 229）を除外していない＝名前を打って確定した瞬間に送信される')
}

if (bad) process.exit(1)
console.log('画面の約束事: hidden が勝つ・Enter 送信の id が実在・変換確定の Enter を除外')
