// manifest とアイコンの整合を、実物のファイルで確かめる。
//
// 🔴 「書いた」と「合っている」は別。宣言したサイズと PNG の実寸がズレていても
// 画面は普通に出るので、目でも grep でも気づけない。ここで落とす。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const fail = (m) => {
  console.error(`✘ ${m}`)
  process.exitCode = 1
}

const mfPath = join(pub, 'manifest.webmanifest')
if (!existsSync(mfPath)) {
  fail('public/manifest.webmanifest が無い')
  process.exit(1)
}

let mf
try {
  mf = JSON.parse(readFileSync(mfPath, 'utf8'))
} catch (e) {
  fail(`manifest が JSON として読めない: ${e.message}`)
  process.exit(1)
}

for (const k of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
  if (!(k in mf)) fail(`manifest に ${k} が無い`)
}
if (mf.display !== 'standalone') fail(`display が standalone でない: ${mf.display}`)

/** PNG の実寸は IHDR から読む（宣言を信じない） */
function pngSize(path) {
  const b = readFileSync(path)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

let maskable512 = 0
let any512 = 0
for (const icon of mf.icons ?? []) {
  if (!icon.src.startsWith('/')) {
    // ⚠ 相対だと /r/<部屋ID> で開かれた時に `/r/icons/…` を見に行って全部 404 になる
    fail(`アイコンのパスが絶対でない: ${icon.src}`)
    continue
  }
  const p = join(pub, icon.src.slice(1))
  if (!existsSync(p)) {
    fail(`アイコンの実体が無い: ${icon.src}`)
    continue
  }
  if (icon.type === 'image/png') {
    const got = pngSize(p)
    if (!got) fail(`PNG として読めない: ${icon.src}`)
    else if (`${got[0]}x${got[1]}` !== icon.sizes) {
      fail(`宣言と実寸が違う: ${icon.src} は ${icon.sizes} と書かれているが ${got[0]}x${got[1]}`)
    } else if (icon.sizes === '512x512') {
      if (icon.purpose === 'maskable') maskable512++
      else any512++
    }
  }
}
// ⚠ maskable が無いと Android は中央80%の外を切る前提でアイコンを扱わず、
// 白い枠の中に縮めて置く（意図した見た目にならない）
if (!maskable512) fail('512px の maskable アイコンが無い')
if (!any512) fail('512px の通常アイコンが無い')

const html = readFileSync(join(root, 'src/index.html'), 'utf8')
if (!html.includes('rel="manifest"')) fail('src/index.html が manifest を参照していない')
const apple = html.match(/rel="apple-touch-icon"\s+href="([^"]+)"/)
if (!apple) fail('src/index.html に apple-touch-icon が無い（iOS はこれを見る）')
else if (!existsSync(join(pub, apple[1].slice(1)))) fail(`apple-touch-icon の実体が無い: ${apple[1]}`)

if (!process.exitCode) {
  console.log(
    `アイコンと manifest: ${mf.icons.length} 件を実体・実寸まで照合 / maskable ${maskable512} 件`,
  )
}
