// ネイティブのシェル（Android / iOS）のアイコンとスプラッシュの【唯一の生成元】。
//
// 出所の記録:
// - 意匠は public/icons/michizure.svg の「裂けた券」（自前の意匠・選定の根拠は commit fef4ef7）。
//   このファイルはそこから全サイズを描き起こすだけで、新しい図形は持たない。
// - 画像検索の最終関門（Google レンズ＋TinEye・色付きとシルエットの2枚）を 2026-09-25 に実施した。
//   ストアのアプリアイコン・企業の標章との一致は無し（TinEye のシルエットは「単純すぎる」で検索不可＝未検索）。
//   ただし「切り欠きのある券の2片」というモチーフ自体は汎用的で、識別力は強くない。
//   Apple の App Store のアイコンはレンズにほとんど出ない＝その範囲は確認できていない。意匠を変えたらやり直すこと。
// - 🔴 2026-09-06〜09-25 のあいだ、ここの成果物は `cap add` が置いていく Capacitor の雛形
//   （白地に水色のグリッドと青い×印）が【そのまま】入っていた。コードのライセンス（MIT）は
//   ロゴを含まず、雛形の同梱物を製品の顔に流用してはいけない。統合ハブの目視点検で発見された
//   （grep には出ない）。⇒ 雛形の実体は scripts/check-icons.mjs が sha256 で見張っている。
//   ⚠ `npx cap add` を再実行するとこの成果物は雛形へ戻る＝その後は必ずこれを走らせる。
//
// 使い方: node scripts/build-native-assets.mjs
//   `npm run build:shell` が cap sync の前に呼ぶ。出力は決定的（同じ sharp なら同じバイト列）＝
//   走らせても差分が出なければ、コミット済みの成果物は生成元どおり。
//
// ⚠ sharp は miniflare（vitest-pool-workers）経由の【推移的】依存。無ければ `npm ci` をやり直す。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let sharp
try {
  ;({ default: sharp } = await import('sharp'))
} catch {
  console.error('✘ sharp を読み込めない。`npm ci` をやり直すこと（miniflare 経由で入る）')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'public/icons/michizure.svg'), 'utf8')

const BG_RE = /<rect width="100" height="100" fill="(#[0-9a-fA-F]{6})"\/>/
const bgMatch = svg.match(BG_RE)
if (!bgMatch) {
  console.error('✘ public/icons/michizure.svg の背景 rect が想定と違う（この生成器は 100x100 の rect 1枚の地を前提にする）')
  process.exit(1)
}
const BG = bgMatch[1]
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const MARK = inner.replace(BG_RE, '')

/** 100x100 の図面（中心 50,50）を w×h の面の中央へ、係数 k で置く。bg が null なら透明 */
function compose(w, h, k, bg) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : '') +
      `<g transform="translate(${w / 2} ${h / 2}) scale(${k}) translate(-50 -50)">${MARK}</g></svg>`,
  )
}

// 意匠の実寸（100 の図面の単位）。透明な面に描いて、不透明な画素だけを数える
const PROBE = 1000
const { data: probe } = await sharp(compose(PROBE, PROBE, PROBE / 100, null)).raw().toBuffer({ resolveWithObject: true })
let minX = PROBE, maxX = 0, minY = PROBE, maxY = 0, farthest2 = 0
for (let y = 0; y < PROBE; y++) {
  for (let x = 0; x < PROBE; x++) {
    if (probe[(y * PROBE + x) * 4 + 3] > 8) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const d2 = (x - PROBE / 2) ** 2 + (y - PROBE / 2) ** 2
      if (d2 > farthest2) farthest2 = d2
    }
  }
}
const unit = PROBE / 100
const MARK_H = (maxY - minY + 1) / unit // 意匠の高さ
const MARK_R = Math.sqrt(farthest2) / unit // 中心から最も遠い画素までの距離

const png = { compressionLevel: 9, effort: 10, palette: false }
const write = async (rel, pipeline) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, await pipeline.png(png).toBuffer())
}
const dim = async (rel) => {
  const m = await sharp(join(root, rel)).metadata()
  return [m.width, m.height]
}

let count = 0

// ── Android ──────────────────────────────────────────────
const RES = 'android/app/src/main/res'
// レガシー（API 25 以前）は全面の地つき。角丸の四角と円
const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
// アダプティブの前景は 108dp の面。実際に見える保証があるのは中心の直径 66dp の円の内側だけ
const foreground = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }
for (const d of Object.keys(legacy)) {
  const s = legacy[d]
  const full = () => sharp(compose(s, s, s / 100, BG))
  const mask = (rx) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect width="${s}" height="${s}" rx="${rx}"/></svg>`)
  await write(`${RES}/mipmap-${d}/ic_launcher.png`, full().composite([{ input: mask(s * 0.16), blend: 'dest-in' }]))
  await write(`${RES}/mipmap-${d}/ic_launcher_round.png`, full().composite([{ input: mask(s / 2), blend: 'dest-in' }]))
  const f = foreground[d]
  await write(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, sharp(compose(f, f, (f * (33 / 108)) / MARK_R, null)))
  count += 3
}
// アダプティブの地（前景の後ろ）は色1つ
writeFileSync(
  join(root, `${RES}/values/ic_launcher_background.xml`),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`,
)

// スプラッシュ: 既存ファイルの寸法を踏襲する（Capacitor の起動テーマがこの名前・この寸法を前提にする）
const splashK = (w, h) => (0.22 * Math.min(w, h)) / MARK_H
const splashFiles = [
  `${RES}/drawable/splash.png`,
  ...['land', 'port'].flatMap((o) => ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].map((d) => `${RES}/drawable-${o}-${d}/splash.png`)),
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png',
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png',
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png',
]
for (const rel of splashFiles) {
  if (!existsSync(join(root, rel))) {
    console.error(`✘ 想定のスプラッシュが無い: ${rel}（寸法の踏襲元。cap add をやり直したか、構成が変わった）`)
    process.exit(1)
  }
  const [w, h] = await dim(rel)
  await write(rel, sharp(compose(w, h, splashK(w, h), BG)).removeAlpha())
  count++
}

// ── iOS ──────────────────────────────────────────────────
// 1024 の1枚だけ（Contents.json は universal 1024）。App Store は透過を許さない＝地つきで不透明
await write('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', sharp(compose(1024, 1024, 10.24, BG)).removeAlpha())
count++

console.log(`ネイティブのアイコン・スプラッシュ: ${count} 枚を public/icons/michizure.svg から描き直した（意匠の高さ ${MARK_H.toFixed(1)}・中心からの最遠 ${MARK_R.toFixed(1)}／100）`)
