// ネイティブのシェルを作る前に、**壊れ方が見えにくい2点**を止める。
//
// 🔴 1) API の宛先が空だと、シェルは自分自身（capacitor://localhost）へ
//       API を投げる。**アプリは起動し、画面も出る**が、部屋の作成も入室も
//       全部失敗する。気づくのはデモの最中になる。
// 🔴 2) シェルの出所が CORS の許可一覧に無いと、同じく全部落ちる。
//       こちらも画面は出る。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = []

const apiBase = (process.env.MICHIZURE_API_BASE ?? '').trim()
if (!apiBase) {
  fail.push(
    'MICHIZURE_API_BASE が空。シェルは別オリジンで動くので、API の宛先を渡すこと。\n' +
      '    例) MICHIZURE_API_BASE=https://michizure.waiteu.dev npm run build:shell',
  )
} else if (!/^https:\/\//.test(apiBase)) {
  fail.push(`MICHIZURE_API_BASE は https:// で始めること: ${apiBase}`)
}

// シェルの出所（capacitor.config.json の scheme）が許可一覧に在るか
const cfg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'))
const types = readFileSync(join(root, 'src/types.ts'), 'utf8')
const allowed = [...types.matchAll(/'([a-z]+:\/\/[^']+)'/g)].map((m) => m[1])
const origins = [
  `${cfg.server?.iosScheme ?? 'capacitor'}://localhost`,
  `${cfg.server?.androidScheme ?? 'https'}://localhost`,
]
for (const o of origins) {
  if (!allowed.includes(o)) {
    fail.push(
      `シェルの出所 ${o} が ALLOWED_SHELL_ORIGINS に無い（src/types.ts）。\n` +
        `    このままだと API 呼び出しが全部 CORS で落ちる。**画面は出るので気づきにくい。**\n` +
        `    許可されているのは: ${allowed.join(' / ')}`,
    )
  }
}

if (fail.length) {
  console.error('シェルの設定に問題があります:')
  for (const f of fail) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`シェルの設定 OK: API=${apiBase} / 出所=${origins.join(' , ')}`)
