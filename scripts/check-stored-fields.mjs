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
const { SERVER_STORED } = await import(join(root, 'src/server-stored-fields.ts'))
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
if (bad) process.exit(1)
console.log(`サーバーの保存項目: ${declared.length} 件（${declared.join(' / ')}）が実装の書き込みと一致・KV は未使用`)
