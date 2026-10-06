// src/room.ts が保存へ書くキーが、src/server-stored-fields.ts の宣言に全部あるかを見る。
//
// 🔴 なぜ要るか: 2026-09-07 に `rev` を足した時、公開予定のプライバシーポリシー §2 が
// 「更新の回数は持っていない」と書いたまま嘘になった（過少申告）。人が PP を洗い忘れても、
// ここが止める。⚠ 書く経路を問わず拾うので、テストが通らない稀な経路で書くキーも捕まえる。
// 欄（JSON の中身）までの照合は test/stored-fields.test.ts が実際に使って確かめる。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { SERVER_STORED, SERVER_STORED_LIMITER } = await import(join(root, 'src/server-stored-fields.ts'))
// ⚠ コメントを除いてから数える。除かないと、説明文に書いた `ctx.storage.put()` を
// 書き込みと数えて誤検出する（2026-09-10 に実際にそれで落ちた）
const src = readFileSync(join(root, 'src/room.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const written = [...new Set([...src.matchAll(/this\.put\('([^']+)'/g)].map((m) => m[1]))].sort()
const declared = Object.keys(SERVER_STORED.room).sort()
const kvWrites = [...src.matchAll(/ctx\.storage\.put\(/g)].length

const missing = written.filter((k) => !declared.includes(k))
const stale = declared.filter((k) => !written.includes(k))
let bad = false
if (missing.length) {
  console.error(
    `✘ サーバーが保存するのに宣言に無いキー: ${missing.join(', ')}\n` +
      `  ⇒ src/server-stored-fields.ts へ足し、**プライバシーポリシー §2 もビジネスハブと合わせて直すこと**。\n` +
      `     宣言を足すだけで PP を直さないと、公開される PP が「持っていない」と嘘をつく。`,
  )
  bad = true
}
if (stale.length) {
  console.error(`✘ 宣言にあるのに実装が書かないキー: ${stale.join(', ')}（消したなら宣言と PP §2 からも消す）`)
  bad = true
}
if (kvWrites && !SERVER_STORED.kv.length) {
  console.error(`✘ ctx.storage.put() が ${kvWrites} 箇所あるのに、KV への保存が宣言されていない`)
  bad = true
}
// ── 部屋の作成の速度制限（CreateLimiter）の保存キー ──
const limiterSrc = readFileSync(join(root, 'src/create-limiter.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const limiterWritten = [...new Set([...limiterSrc.matchAll(/\bkv\.put\('([^']+)'/g)].map((m) => m[1]))].sort()
const limiterDeclared = Object.keys(SERVER_STORED_LIMITER).sort()
const limiterMissing = limiterWritten.filter((k) => !limiterDeclared.includes(k))
const limiterStale = limiterDeclared.filter((k) => !limiterWritten.includes(k))
if (limiterMissing.length) {
  console.error(
    `✘ 速度制限のカウンタ（src/create-limiter.ts）が保存するのに宣言に無いキー: ${limiterMissing.join(', ')}\n` +
      `  ⇒ src/server-stored-fields.ts の SERVER_STORED_LIMITER へ足し、**PP §2 もビジネスハブと合わせて直すこと**`,
  )
  bad = true
}
if (limiterStale.length) {
  console.error(`✘ SERVER_STORED_LIMITER にあるのに実装が書かないキー: ${limiterStale.join(', ')}`)
  bad = true
}
if (/ctx\.storage\.put\(/.test(limiterSrc)) {
  console.error('✘ src/create-limiter.ts が ctx.storage.put() を使っている（宣言は kv.put のキーだけ見ている）')
  bad = true
}
if (bad) process.exit(1)
console.log(
  `サーバーの保存項目: ${declared.length} 件（${declared.join(' / ')}）が実装の書き込みと一致・KV は未使用` +
    ` ／ 速度制限のカウンタ: ${limiterDeclared.join(' / ')}（${limiterDeclared.length} 件）が宣言と一致`,
)
