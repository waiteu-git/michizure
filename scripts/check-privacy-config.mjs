// npm test の前に自動で走る（package.json の pretest）。
// wrangler.toml の privacy 上の不変条件を守る。設定は消えても誰も気づかないため、
// 「消えたらテストが落ちる」形にしておく。
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8')

const failures = []

// 1) Workers Logs は新規 Worker では既定で有効。明示的に false にしていないと
//    Cloudflare 側にログが残る（無料プランで3日）。設計 §7.5・§11
if (!/\[observability\][\s\S]*?enabled\s*=\s*false/.test(toml)) {
  failures.push(
    'wrangler.toml に [observability] enabled = false がない。' +
      '書かないと Workers Logs は既定で有効になり、ログが Cloudflare 側に保存される',
  )
}

// 2) 本番のトークン署名鍵が [vars] に平文で入っていないこと。
//    [vars] の値は wrangler types の生成物にもそのまま埋め込まれる
const devSecret = 'dev-only-secret-do-not-use-in-production'
const tokenSecret = toml.match(/^TOKEN_SECRET\s*=\s*"([^"]*)"/m)
if (tokenSecret && tokenSecret[1] !== devSecret) {
  failures.push(
    '[vars] の TOKEN_SECRET が開発用の既定値から変わっている。' +
      '本番の鍵は wrangler secret put TOKEN_SECRET で設定すること（wrangler.toml に書かない）',
  )
}

// 3) IP を含むヘッダを読むコードが入り込んでいないこと。
//    読まなければ DO のストレージにもログにも入らない（設計 §7.5）
const ipHeaders = [
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'x-forwarded-for',
  'cf-pseudo-ipv4',
  'true-client-ip',
]
for (const file of globSync('src/**/*.ts', { cwd: root })) {
  const source = readFileSync(join(root, file), 'utf8').toLowerCase()
  for (const header of ipHeaders) {
    if (source.includes(header)) {
      failures.push(`${file} が ${header} を参照している。IP は取得しない方針（設計 §7.5）`)
    }
  }
  // 全ヘッダを展開するイディオム。cf-connecting-ip がログに出る
  if (/(new map\(|object\.fromentries\()\s*\w*\.?headers/.test(source)) {
    failures.push(`${file} が全ヘッダを展開している。IP を含むヘッダがログに出る`)
  }
}

if (failures.length > 0) {
  console.error('privacy 設定の検査に失敗しました:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
