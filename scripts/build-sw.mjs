// public/sw.js を、実際にビルドされたファイル一覧から生成する。
//
// 🔴 手書きしない。chunk の名前は内容ハッシュで毎回変わるので、
// 手書きの一覧は必ず腐る（そして腐っても画面は出るため気づけない）。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')

const files = readdirSync(pub).filter((f) => f.endsWith('.js') && f !== 'sw.js')
const assets = ['/', ...files.map((f) => `/${f}`)]

// 版はビルド成果物の内容から決める。内容が変われば sw.js も変わり、
// ブラウザが更新を検出する。日時を使うと毎回変わって無駄な更新が走る
const hash = createHash('sha256')
hash.update(readFileSync(join(pub, 'index.html')))
for (const f of files.sort()) hash.update(readFileSync(join(pub, f)))
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

  // chunk は内容ハッシュ付きの名前なので、キャッシュ優先で安全
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})
`,
)
console.log(`sw.js を生成: 版 ${version} / ${assets.length}件を保存対象`)
