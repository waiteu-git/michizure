// npm test の前に自動で走る（package.json の pretest）。
// wrangler.toml の privacy 上の不変条件を守る。設定は消えても誰も気づかないため、
// 「消えたらテストが落ちる」形にしておく。
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawToml = readFileSync(join(root, 'wrangler.toml'), 'utf8')

// ⚠ コメント行を落としてから判定する。落とさないと「# [observability] enabled = false」と
// コメントアウトしただけで検査を素通りしてしまう（＝ログが復活しても誰も気づかない）
const toml = rawToml
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const failures = []

// 1) Workers Logs は新規 Worker では既定で有効。明示的に false にしていないと
//    Cloudflare 側にログが残る（無料プランで3日）。設計 §7.5・§11
if (!/\[observability\][\s\S]*?enabled\s*=\s*false/.test(toml)) {
  failures.push(
    'wrangler.toml に [observability] enabled = false がない（コメントアウトも不可）。' +
      '書かないと Workers Logs は既定で有効になり、ログが Cloudflare 側に保存される',
  )
}
if (/\[observability\][\s\S]*?enabled\s*=\s*true/.test(toml)) {
  failures.push('[observability] enabled = true になっている。確認が終わったら false に戻すこと')
}

// 2) 本番のトークン署名鍵が [vars] に平文で入っていないこと。
//    [vars] の値は wrangler types の生成物にもそのまま埋め込まれる。
//    ⚠ 行頭・二重引用符に限定すると、インデントや ' での記述をすり抜ける
const devSecret = 'dev-only-secret-do-not-use-in-production'
const tokenSecret = toml.match(/\bTOKEN_SECRET\s*=\s*(?:"([^"]*)"|'([^']*)')/)
if (tokenSecret) {
  const value = tokenSecret[1] ?? tokenSecret[2]
  if (value !== devSecret) {
    failures.push(
      '[vars] の TOKEN_SECRET が開発用の既定値から変わっている。' +
        '本番の鍵は wrangler secret put TOKEN_SECRET で設定すること（wrangler.toml に書かない）',
    )
  }
} else {
  failures.push('wrangler.toml に TOKEN_SECRET の記述が見当たらない（検査が空振りしている）')
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
  // ⚠ headers の条件を選択肢の【外】に置くこと。中へ移すと new Map( 全般に掛かり、
  // ごく普通の Map までが落ちる（実際に 8171ea3 でそうなり、settle.ts が誤検知された）。
  // 誤検知するラチェットは、無いより悪い（誰かが必ず外す）
  const spreadsHeaders =
    /(new map\(|object\.fromentries\()\s*[\w.]*headers/.test(source) ||
    /\.\.\.\s*[\w.]*headers/.test(source)
  if (spreadsHeaders) {
    failures.push(`${file} が全ヘッダを展開している。IP を含むヘッダがログに出る`)
  }
  // request.cf は IP ではないが、国・市・ASN 等の位置情報を含む
  if (/\brequest\.cf\b|\breq\.cf\b/.test(source)) {
    failures.push(`${file} が request.cf を参照している。位置情報が入るので扱いを確認すること`)
  }
}

if (failures.length > 0) {
  console.error('privacy 設定の検査に失敗しました:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
