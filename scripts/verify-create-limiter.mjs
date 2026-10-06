// 部屋作成の速度制限（CreateLimiter）が、指定した環境で実際に効いているかを、実 HTTP で確かめる。
//
// 使い方: MICHIZURE_BASE=https://<デプロイ先> node scripts/verify-create-limiter.mjs
//   （本番を指す時は必ず明示する。既定値は無い＝うっかり本番を叩かない）
//
// 🔴 なぜ要るか: 前身の Workers Rate Limiting binding は、コードもテストも通ったまま、本番で約195回連続でも
//    429 を一度も返さなかった（2026-09-18）。「入れた」と「効いている」は別なので、デプロイ後に実測する。
// 🔴 この確認は本番に一時的な部屋を作る。そのとき 195 個のダミー部屋を IDの記録なしに残した過去の失敗を
//    繰り返さないため、**作った部屋は作った瞬間に台帳（os.tmpdir）へ書き**、終了時に必ず全部消す。
//    消せなかったものは ID を大きく出して台帳に残す。
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSalt, deriveKeys } from '../src/keys.ts'
import { seal } from '../src/box.ts'

const BASE = process.env.MICHIZURE_BASE
if (!BASE) {
  console.error('MICHIZURE_BASE が空。例) MICHIZURE_BASE=https://michizure.example.workers.dev node scripts/verify-create-limiter.mjs')
  process.exit(2)
}
const CAPACITY = 20 // src/create-limiter.ts の CREATE_LIMIT.capacity
const ATTEMPTS = CAPACITY + 5
const LEDGER = join(tmpdir(), 'michizure-verify-create-limiter.ledger.jsonl')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// 前回の掃除漏れがあれば先に片づける（台帳が残っている＝消せなかった部屋がある）
if (existsSync(LEDGER) && readFileSync(LEDGER, 'utf8').trim()) {
  console.log(`前回の台帳が残っている: ${LEDGER} — 先に掃除する`)
}

const rooms = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

async function cleanup() {
  const left = []
  for (const r of rooms()) {
    const res = await fetch(`${BASE}/api/rooms/${r.roomId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: r.authKey }),
    }).catch(() => null)
    if (res && (res.status === 200 || res.status === 404)) continue
    left.push(r)
  }
  if (left.length) {
    writeFileSync(LEDGER, left.map((r) => JSON.stringify(r)).join('\n') + '\n')
    console.error(`\n🔴🔴 消せなかった部屋が ${left.length} 個ある（台帳: ${LEDGER}）:`)
    for (const r of left) console.error(`   ${r.roomId}`)
    failures++
  } else if (existsSync(LEDGER)) {
    unlinkSync(LEDGER)
  }
}

const salt = generateSalt()
const { authKey, encKeyBits } = await deriveKeys('あいことばのけんしょう', salt, 100_000)
const blob = { ...(await seal(encKeyBits, { name: '制限の確認', members: [], bookings: [] })), blobVersion: 1 }
const payload = JSON.stringify({ salt, authKey, blob, iterations: 100_000, kdfVersion: 1 })

async function create() {
  const res = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
  if (res.status === 200) {
    const { roomId } = await res.json()
    // ⚠ 作った瞬間に台帳へ。次の行へ進む前に書く（途中で落ちても ID が残る）
    appendFileSync(LEDGER, JSON.stringify({ roomId, authKey }) + '\n')
    return { status: 200, roomId }
  }
  return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.text() }
}

try {
  const t0 = Date.now()
  const results = []
  for (let i = 0; i < ATTEMPTS; i++) results.push(await create())
  const seconds = (Date.now() - t0) / 1000
  const ok = results.filter((r) => r.status === 200).length
  const denied = results.filter((r) => r.status === 429)
  console.log(`  ${ATTEMPTS} 回を ${seconds.toFixed(1)} 秒で送った: 通った ${ok} ・429 ${denied.length} ・その他 ${ATTEMPTS - ok - denied.length}`)

  check('429 が少なくとも1回返った（制限が効いている）', denied.length >= 1)
  // 送っている間にも戻る（1分に20個＝3秒に1個）ぶんだけ、容量を超えて通りうる
  const ceiling = CAPACITY + Math.ceil(seconds / 3) + 1
  check(`通ったのは容量（${CAPACITY}）＋その間の回復を超えない`, ok <= ceiling, `通った ${ok} ・上限 ${ceiling}`)
  check('429 の本文は { "error": "rate_limited" }', denied.length > 0 && denied.every((r) => JSON.parse(r.body).error === 'rate_limited'))
  check('429 に Retry-After（1以上の整数秒）がある', denied.length > 0 && denied.every((r) => /^[1-9][0-9]*$/.test(r.retryAfter ?? '')))
  check('429 と 200 のほかが混ざっていない', results.every((r) => r.status === 200 || r.status === 429), results.filter((r) => r.status !== 200 && r.status !== 429).map((r) => r.status).join(','))
} finally {
  await cleanup()
}

// 消した部屋が本当に無いこと
const gone = await fetch(`${BASE}/api/rooms/${'0'.repeat(16)}/salt`).then((r) => r.status)
check('（対照）存在しない部屋は 404', gone === 404, `status ${gone}`)

// 回復すること: 少し待つと、また作れる（止めっぱなしになっていない）
await new Promise((r) => setTimeout(r, 4000))
const after = await create()
check('少し待つと、また作れる（回復する）', after.status === 200, `status ${after.status}`)
await cleanup()

console.log(failures ? `\n${failures} 件失敗` : '\nすべて通過')
process.exit(failures ? 1 : 0)
