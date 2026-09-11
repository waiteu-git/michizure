// npm test の前に自動で走る（package.json の pretest）。
// wrangler.toml の privacy 上の不変条件を守る。設定は消えても誰も気づかないため、
// 「消えたらテストが落ちる」形にしておく。
import { readFileSync, globSync, existsSync } from 'node:fs'
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
//    🔴 **[observability] の節の中だけを見る。** 以前は全文に対して
//    `/\[observability\][\s\S]*?enabled\s*=\s*false/` を当てていたため、
//    節から enabled を消しても、**後ろの別の節にある enabled = false を拾って通っていた**
//    （2026-09-05 の監査が偽陰性・偽陽性の両方を実測）。
//    節は「次の [ で始まる行」までとして切り出す。
const obsMatch = toml.match(/^\s*\[observability\]\s*$([\s\S]*?)(?=^\s*\[|\Z)/m)
if (!obsMatch) {
  failures.push(
    'wrangler.toml に [observability] の節がない（コメントアウトも不可）。' +
      '書かないと Workers Logs は既定で有効になり、ログが Cloudflare 側に保存される',
  )
} else {
  const section = obsMatch[1]
  if (!/^\s*enabled\s*=\s*false\s*$/m.test(section)) {
    failures.push(
      '[observability] の節に enabled = false がない。' +
        '書かないと Workers Logs は既定で有効になり、ログが Cloudflare 側に保存される',
    )
  }
  if (/^\s*enabled\s*=\s*true\s*$/m.test(section)) {
    failures.push('[observability] enabled = true になっている。確認が終わったら false に戻すこと')
  }
}

// 2) トークン署名鍵の置き場所。**2つを別々に検査する。**
//
//    🔴 (2-a) wrangler.toml に TOKEN_SECRET が【無い】こと。
//    [vars] に書くと deploy 時に同名のリモートシークレットを置き換えるため、
//    `wrangler secret put` で入れた本番鍵が開発用の値で上書きされる
//    （wrangler 4.120.0 の checkRemoteSecretsOverride で実測。2026-09-05）。
//    ⚠ 以前ここは「wrangler.toml に在ること」を要求していた＝この事故を強制していた。
const devSecret = 'dev-only-secret-do-not-use-in-production'
const tomlSecret = toml.match(/\bTOKEN_SECRET\s*=\s*(?:"([^"]*)"|'([^']*)')/)
if (tomlSecret) {
  failures.push(
    'wrangler.toml に TOKEN_SECRET が書かれている。deploy 時に本番のシークレットを' +
      '置き換えてしまう（誰でもトークンを偽造できる状態になる）。値は .dev.vars へ移すこと',
  )
}

//    (2-b) .dev.vars の TOKEN_SECRET が開発用の既定値のままであること。
//    ここに本番の鍵を書くと、コミットされて履歴に残る。
const devVarsPath = join(root, '.dev.vars')
if (!existsSync(devVarsPath)) {
  failures.push('.dev.vars が無い（開発・テスト用の TOKEN_SECRET の置き場所。検査が空振りしている）')
} else {
  const devVars = readFileSync(devVarsPath, 'utf8')
  const m = devVars.match(/^\s*TOKEN_SECRET\s*=\s*(.*)$/m)
  if (!m) {
    failures.push('.dev.vars に TOKEN_SECRET が無い（検査が空振りしている）')
  } else if (m[1].trim().replace(/^["']|["']$/g, '') !== devSecret) {
    failures.push(
      '.dev.vars の TOKEN_SECRET が開発用の既定値から変わっている。' +
        '本番の鍵は wrangler secret put TOKEN_SECRET で設定すること（ファイルに書かない）',
    )
  }
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
  // 全ヘッダを列挙するイディオム（2026-09-11 の多観点照合で、展開だけ見ていて列挙を拾わないと指摘）。
  // ⚠ `headers: request.headers` のような**そのままの受け渡し**は拾わない。WebSocket の経路は
  // Upgrade のために DO へ渡しており、読んではいない＝拾うと正当なコードを落とす（誤検知は無いより悪い）
  const enumeratesHeaders =
    /\bfor\s*\([^)]*\bof\s+[\w.]*headers\b/.test(source) ||
    /headers\.(foreach|entries|keys|values)\(/.test(source) ||
    /array\.from\(\s*[\w.]*headers/.test(source)
  if (enumeratesHeaders) {
    failures.push(`${file} が全ヘッダを列挙している。IP を含むヘッダが読まれる`)
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
