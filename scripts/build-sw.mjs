// public/sw.js を、実際にビルドされたファイル一覧から生成する。
//
// 🔴 手書きしない。chunk の名前は内容ハッシュで毎回変わるので、
// 手書きの一覧は必ず腐る（そして腐っても画面は出るため気づけない）。
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')

// 🔴 **最初に読む物だけを保存する。遅延 chunk を入れてはいけない。**
//
// 以前はここで public/*.js を全部並べていた。そうすると「遅延読み込みにした」
// はずのものが**インストール時に必ず落ちてくる**＝軽さの差別化が、画面は
// 動いたまま静かに死ぬ（2026-09-06 の設計レビューが指摘）。
// ⇒ app.js が【静的に】import している物だけを保存し、残りは使われた時に
//    fetch のハンドラが結果を蓄える（runtime caching）。
// 🔴 **esbuild の構成表から決める。app.js の本文を正規表現で読まない。**
// 正規表現版は「app.js が直接 import している物」しか見えず、**その先の静的 import を
// 辿らない**（たまたま揃っていただけ）。構成表なら推移的に辿れるし、どの chunk に
// どの原簿が入ったかも分かる（2026-09-07 のレビューで両方を指摘された）。
const metaPath = join(root, '.build-meta.json')
let meta
try {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'))
} catch {
  throw new Error(
    '.build-meta.json が無い。esbuild に --metafile=.build-meta.json を付けて実行すること',
  )
}
const outs = Object.fromEntries(
  Object.entries(meta.outputs).map(([k, v]) => [k.replace(/^public\//, ''), v]),
)

/** 静的 import だけを推移的に辿る（動的 import は遅延のまま＝初回に運ばない） */
function staticClosure(entry) {
  const seen = new Set()
  const walk = (f) => {
    if (seen.has(f) || !outs[f]) return
    seen.add(f)
    for (const im of outs[f].imports ?? []) {
      if (im.kind === 'import-statement') walk(im.path.replace(/^public\//, ''))
    }
  }
  walk(entry)
  return [...seen]
}

/**
 * 🔴 **圏外で最初に要る物は、使われる前に蓄えておく。**
 *
 * Service Worker は遅延 chunk を「使われた時」にしか蓄えない。QR を描くコードは
 * 遅延なので、**一度も QR を出していない端末は圏外で人を招けない**。
 * とりわけ圏外入室した端末は、定義から電波が無いので寄せ集めが走らない
 * （2026-09-07 のレビューで発見。「圏外でも招ける」と直したつもりの穴）。
 * ⇒ 初回読み込みには足さず（静的 import にしない）、**インストール時に蓄える**。
 */
const OFFLINE_CRITICAL = ['src/client/qr.ts']
const criticalChunks = OFFLINE_CRITICAL.map((src) => {
  const hit = Object.entries(outs).find(([, v]) => v.inputs && src in v.inputs)
  if (!hit) throw new Error(`${src} を含む chunk が構成表に無い（先読みを決められない）`)
  return hit[0]
})

const files = [...new Set([...staticClosure('app.js'), ...criticalChunks])]
// JS 以外で圏外に要る物。⚠ アイコンは入れない＝端末に入れた時点で OS が持つし、
// 512px の PNG を毎回のインストールで運ぶ理由が無い（使われれば fetch 側が蓄える）
const STATIC_EXTRA = ['/manifest.webmanifest']

const assets = ['/', ...files.map((f) => `/${f}`), ...STATIC_EXTRA]

// ⚠ 「一覧に足した」と「一覧に載った」は別。載ったことまで確かめてから書き出す
for (const c of criticalChunks) {
  if (!assets.includes(`/${c}`)) throw new Error(`圏外で要る ${c} が先読み一覧に入っていない`)
}

const lazy = readdirSync(pub).filter((f) => f.endsWith('.js') && f !== 'sw.js' && !files.includes(f))
rmSync(metaPath, { force: true })

// 版はビルド成果物の内容から決める。内容が変われば sw.js も変わり、
// ブラウザが更新を検出する。日時を使うと毎回変わって無駄な更新が走る
const hash = createHash('sha256')
hash.update(readFileSync(join(pub, 'index.html')))
for (const f of [...files, ...lazy].sort()) hash.update(readFileSync(join(pub, f)))
const version = hash.digest('hex').slice(0, 12)

writeFileSync(
  join(pub, 'sw.js'),
  `// 自動生成（npm run build:client）。直接編集しない。出所: scripts/build-sw.mjs
const VERSION = '${version}'
const CACHE = 'michizure-' + VERSION
const PRECACHE = ${JSON.stringify(assets)}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return

  // 🔴 /api/* は絶対にキャッシュしない。
  // 古い暗号文や失効したトークンを返すと、同期の判断そのものが壊れる
  if (url.pathname.startsWith('/api/')) return

  // 画面の遷移・リロードは【通信を先に試す】。繋がらない時だけ保存した殻を返す。
  // 逆にすると、更新したのに古い画面が出続ける
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/').then((r) => r || Response.error())))
    return
  }

  // chunk は内容ハッシュ付きの名前なので、キャッシュ優先で安全。
  // ⚠ 先に保存していない物（遅延 chunk）は、**使われた時に蓄える**。
  // こうしないと「一度使った機能が次は圏外で動かない」ことになる
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()))
          return res
        }),
    ),
  )
})
`,
)
console.log(`sw.js を生成: 版 ${version} / 先読み ${assets.length}件 / 遅延 ${lazy.length}件（使われた時に蓄える）`)
