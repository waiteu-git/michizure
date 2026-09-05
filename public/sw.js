// 自動生成（npm run build:client）。直接編集しない。出所: scripts/build-sw.mjs
const VERSION = 'c753f7d30de3'
const CACHE = 'michizure-' + VERSION
const PRECACHE = ["/","/app.js","/chunk-77QWZGPU.js","/chunk-D6G4NXAB.js","/chunk-HDPD55FW.js","/chunk-QOX4SSVO.js","/chunk-UKA2UTKE.js"]

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
