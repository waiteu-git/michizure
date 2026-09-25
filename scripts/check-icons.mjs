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

// ── ネイティブのシェル（android/・ios/）─────────────────────────
// 🔴 `cap add` が置いていく Capacitor の雛形のアイコン・スプラッシュ（白地に水色のグリッドと青い×印）が、
// 2026-09-06〜09-25 のあいだ【そのまま】製品の顔になっていた。コードのライセンス（MIT）はロゴを含まない。
// 目視でしか見つからず、grep には出ない（統合ハブの点検で発見）＝ここで実体のバイト列を見張る。
// 生成元は scripts/build-native-assets.mjs（`npm run build:shell` が呼ぶ）。
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'

// @capacitor/cli 8.5.1 の assets（ios-spm・ios-pods・android の各テンプレート）にある
// ic_launcher*.png・splash*.png・AppIcon*.png の sha256（27種）。雛形が版で変わっても、
// 手元の android/・ios/ は生成時のものが残るので、この版のものを見張れば足りる。
const SCAFFOLD_SHA256 = new Set([
  '0166fc333074c373fbd0ce6b5defd71552166165ac778121ca9c9dff6b83f0fc',
  '07fa579e1c83e04ba7f9cbcbfcf41b68e15fe3638f2c44a04e58b809103e6b69',
  '08cc34ad7713fe7ed58bceaa37b2387b670c53cd60264b4bd6442db3098e75dc',
  '0c7f1212f25b7b90e9a6e1d320013e4ff3d3e03e634cbb07b7b7981cac51627f',
  '1b5002b74a5500e697298ced06ca2811ac33f2771f236f3c720ff23243890530',
  '1ee4cd9ff371dcb2e3938097e434f6fb8731688ed7165e61fc63693ad5b2f455',
  '22f87e1e3bc89aa01a7dbc39c9a4db058cd0bf4ad3fe9f55712bf69eb997f4bf',
  '27ed3603010ebc278f64f8645741ab132ff517abb5308eb9df6c8e42a48956b2',
  '29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b',
  '32baa10d2632a4417454a579f992bd640e0a3cec79321423559b2c9940de58a9',
  '3db071a03b2f8ffe0dfd4170fc59842d53cd15bba5e88af59401d58efabf7827',
  '40911a00922868686854a4804b93fd6e56b503664696de03f450bff690affb6d',
  '42aa26392546fcdee1b8d3ac6d4b41bfcceb41dc6a4f3a3c30c24a8a8f4db862',
  '4a82bc1e9923576275869998925ce0ae021a79aa18b24a0dd87ad6b61ca85053',
  '58e78a618778926b1f6d9472a6468de878de8530970934e94aab5ba4ba08cc00',
  '5cf98b4451bd99b20df26f9e608a46946118be6b0ae90762f9ca1786a30c76ff',
  '60393ce8636fd263e4e1fea3fd4ab2de948c6295e898fda9b50ac4e5283be809',
  '6f88083b8166cc559102f7044688de7525287632ebe09ac45d001ac8bf4b3eae',
  '72b71c3581ca3b5a23b1c168d69b9d855b3f184fa079902a01f088eb4f0607d5',
  '87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761',
  'ab93096331e7cd8ec379f73f1e9adcaaa9ee1115c9f4ff10411a811fb9700174',
  'b73049cb37fe76d6c11b87a796766bf6af0c85483b31eb6a921657b0d764a4b9',
  'bd24fd383253bf8d43f0a81f11c071d76d1d555114376dd647cd9fb38fa0a9da',
  'bfcc1b0fa931b14bb241372c76ab4f04374b67d02363c98d9cb12edfdacdf5f3',
  'c5015f4ba3628392b538386c5e210f0b94f352a3160adab934fd0311972137ca',
  'd35dbfff175b83c13ef59cf924abfc810f7b6a158595d7417c5498ea8c7c7ed1',
  'ed346eb1e3f0280f15709393705899b3ff55c20b88f4e0308006b3c33cf5fe14',
])

const RES = join(root, 'android/app/src/main/res')
const XCA = join(root, 'ios/App/App/Assets.xcassets')
const nativePngs = []
if (!existsSync(RES) || !existsSync(XCA)) {
  fail('android/app/src/main/res か ios/App/App/Assets.xcassets が無い（ネイティブのシェルの構成が変わった）')
} else {
  for (const d of readdirSync(RES)) {
    if (!/^(mipmap|drawable)/.test(d)) continue
    for (const f of readdirSync(join(RES, d))) if (f.endsWith('.png')) nativePngs.push(join(RES, d, f))
  }
  for (const set of ['AppIcon.appiconset', 'Splash.imageset']) {
    for (const f of readdirSync(join(XCA, set))) if (f.endsWith('.png')) nativePngs.push(join(XCA, set, f))
  }
  const scaffold = nativePngs.filter((p) => SCAFFOLD_SHA256.has(createHash('sha256').update(readFileSync(p)).digest('hex')))
  for (const p of scaffold) {
    fail(`Capacitor の雛形のアイコン/スプラッシュがそのまま入っている: ${p.slice(root.length + 1)}（node scripts/build-native-assets.mjs で描き直す）`)
  }

  // 実寸（Android のアダプティブ前景は 108dp・レガシーは 48dp）と、iOS のアイコンが不透明な 1024 であること
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, scale] of Object.entries(dens)) {
    for (const [name, dp] of [['ic_launcher', 48], ['ic_launcher_round', 48], ['ic_launcher_foreground', 108]]) {
      const p = join(RES, `mipmap-${d}`, `${name}.png`)
      if (!existsSync(p)) {
        fail(`Android のアイコンが無い: mipmap-${d}/${name}.png`)
        continue
      }
      const want = dp * scale
      const got = pngSize(p)
      if (!got || got[0] !== want || got[1] !== want) fail(`Android のアイコンの実寸が違う: mipmap-${d}/${name}.png は ${want}x${want} のはずが ${got?.join('x')}`)
    }
  }
  const iosIcon = join(XCA, 'AppIcon.appiconset/AppIcon-512@2x.png')
  const iosGot = existsSync(iosIcon) ? pngSize(iosIcon) : null
  if (!iosGot || iosGot[0] !== 1024 || iosGot[1] !== 1024) fail(`iOS のアイコンが 1024x1024 でない: ${iosGot?.join('x')}`)
  else if ([4, 6].includes(readFileSync(iosIcon)[25])) fail('iOS のアイコンに透過（アルファ）がある＝App Store は透過のアイコンを受け付けない')

  // アダプティブの地の色は、意匠（public/icons/michizure.svg）の地と同じであること
  const svgBg = readFileSync(join(pub, 'icons/michizure.svg'), 'utf8').match(/<rect width="100" height="100" fill="(#[0-9a-fA-F]{6})"\/>/)?.[1]
  const xmlBg = readFileSync(join(RES, 'values/ic_launcher_background.xml'), 'utf8').match(/name="ic_launcher_background">(#[0-9a-fA-F]{6})</)?.[1]
  if (!svgBg || svgBg.toLowerCase() !== xmlBg?.toLowerCase()) fail(`アダプティブの地の色が意匠と違う: ${xmlBg} / ${svgBg}`)

  // Android Studio の既定ベクタ（緑のグリッド）は参照されないまま残さない
  for (const rel of ['drawable/ic_launcher_background.xml', 'drawable-v24/ic_launcher_foreground.xml']) {
    if (existsSync(join(RES, rel))) fail(`雛形の既定ベクタが残っている: android/app/src/main/res/${rel}`)
  }
}

if (!process.exitCode) {
  console.log(
    `アイコンと manifest: ${mf.icons.length} 件を実体・実寸まで照合 / maskable ${maskable512} 件 / ` +
      `ネイティブ ${nativePngs.length} 枚が Capacitor の雛形（27種）と一致しないことを確認`,
  )
}
