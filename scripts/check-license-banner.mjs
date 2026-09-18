// 配信物（public/*.js）に、再配布している第三者ライブラリの許諾表示が
// 実際に運ばれているかを実物で確かめる。
//
// 🔴 2026-09-18 の監査で発見：THIRD-PARTY-NOTICES.md はリポジトリに置いてあるだけで、
// 利用者へ配る JavaScript には表示が同梱されていなかった（qrcode-generator・
// @revenuecat/purchases-capacitor の2本は著作権表示が丸ごと欠落）。MIT が求めるのは
// 「複製に同行すること」なので、リポジトリに置くだけでは配信経路に対して未達。
// esbuild の --banner:js（build:client）で全出力ファイルの先頭に焼き込む方針にした。
// ここではその焼き込みが実際に効いているかを、既にビルド済みの public/ で確認する
// （書いたのに古いビルドを配ってしまう再発を防ぐ＝pretest はデプロイより前に走る）。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const fail = (m) => {
  console.error(`✘ ${m}`)
  process.exitCode = 1
}

// THIRD-PARTY-NOTICES.md が「再配布物」として挙げている著作権者。
// ここが増えたら、この配列と build:client の --banner:js を両方直す。
const REQUIRED_NOTICES = ['Kazuhiko Arase', 'RevenueCat, Inc']

if (!existsSync(pub)) {
  fail('public/ が無い（先に npm run build:client を実行すること）')
  process.exit(1)
}

// esbuild が生成するファイルだけを見る。sw.js は build-sw.mjs が別に作る
// 独立した生成物で --banner:js の対象外＝ここに含めると誤検出になる
const jsFiles = readdirSync(pub).filter((f) => f === 'app.js' || f.startsWith('chunk-'))
if (jsFiles.length === 0) {
  fail('public/ に app.js / chunk-*.js が1つも無い（ビルドが古いか壊れている）')
  process.exit(1)
}

for (const file of jsFiles) {
  const content = readFileSync(join(pub, file), 'utf8')
  for (const notice of REQUIRED_NOTICES) {
    if (!content.includes(notice)) fail(`${file} に第三者許諾表示が無い: "${notice}" を含まない`)
  }
}

if (!process.exitCode) {
  console.log(`第三者許諾表示: public/ の${jsFiles.length}ファイル全てに${REQUIRED_NOTICES.length}件とも同梱を確認`)
}
