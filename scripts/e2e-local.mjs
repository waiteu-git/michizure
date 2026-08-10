// wrangler dev（http://localhost:8787）に対して、ブラウザがやることを
// そのまま順に叩く。vitest のハーネスの外で契約が通ることを確かめるためのもの。
// 使い方: 別ターミナルで `npm run dev` を起動してから `node scripts/e2e-local.mjs`
import { generateSalt, deriveKeys } from '../src/keys.ts'
import { seal, open } from '../src/box.ts'

const BASE = process.env.MICHIZURE_BASE ?? 'http://localhost:8787'
const ITERATIONS = 100_000 // サーバーが受け付ける最小値
const PASSPHRASE = 'おきなわのあいことば'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const state = {
  name: '沖縄旅行',
  startDate: '2026-09-20',
  endDate: '2026-09-23',
  members: [
    { id: 'm1', name: '山田' },
    { id: 'm2', name: '鈴木' },
  ],
  bookings: [
    {
      id: crypto.randomUUID(),
      category: '航空券',
      description: '往復',
      payer: 'm1',
      amount: 48000,
      participants: ['m1', 'm2'],
      paid: {},
    },
  ],
}

// 1. 部屋を作る（合言葉は送らない）
const salt = generateSalt()
const { authKey, encKeyBits } = await deriveKeys(PASSPHRASE, salt, ITERATIONS)
const blob = { ...(await seal(encKeyBits, state)), blobVersion: 1 }

const createRes = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ salt, authKey, blob, iterations: ITERATIONS }),
})
const created = await createRes.json()
check('部屋を作れる', createRes.status === 200 && created.roomId?.length === 16, created.roomId)

// 2. 別の端末として入り直す（URL と合言葉しか知らない状態）
const saltRes = await fetch(`${BASE}/api/rooms/${created.roomId}/salt`)
const { salt: fetchedSalt, iterations: roomIterations } = await saltRes.json()
check('ソルトを認証前に取得できる', fetchedSalt === salt)

check('反復回数も一緒に返る', roomIterations === ITERATIONS, String(roomIterations))
const second = await deriveKeys(PASSPHRASE, fetchedSalt, roomIterations)
const enterRes = await fetch(`${BASE}/api/rooms/${created.roomId}/enter`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey: second.authKey }),
})
const { token } = await enterRes.json()
check('合言葉だけで入室できる', enterRes.status === 200 && !!token)

const wrong = await deriveKeys('ちがうあいことば', fetchedSalt, ITERATIONS)
const wrongRes = await fetch(`${BASE}/api/rooms/${created.roomId}/enter`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey: wrong.authKey }),
})
check('違う合言葉は弾かれる', wrongRes.status === 401)

// 3. 取得して復号する
const getRes = await fetch(`${BASE}/api/rooms/${created.roomId}/blob`, {
  headers: { Authorization: `Bearer ${token}` },
})
const got = await getRes.json()
const decrypted = await open(second.encKeyBits, got.ciphertext, got.iv)
check('取得した暗号文を復号すると元の状態に戻る', JSON.stringify(decrypted) === JSON.stringify(state))

// 4. 更新して読み戻す
const updated = { ...state, bookings: [...state.bookings, { id: crypto.randomUUID(), category: '宿泊', description: '2泊', payer: 'm2', amount: 32000, participants: ['m1', 'm2'], paid: { m1: true } }] }
const putRes = await fetch(`${BASE}/api/rooms/${created.roomId}/blob`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...(await seal(second.encKeyBits, updated)), blobVersion: 1 }),
})
check('更新できる', putRes.status === 200)

const reread = await (
  await fetch(`${BASE}/api/rooms/${created.roomId}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json()
const rereadState = await open(second.encKeyBits, reread.ciphertext, reread.iv)
check('更新後の状態が読み戻せる', rereadState.bookings.length === 2)

// 5. WebSocket で中継される
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/rooms/${created.roomId}/ws?token=${token}`)
const messages = []
ws.addEventListener('message', (e) => messages.push(JSON.parse(e.data)))
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
  setTimeout(() => reject(new Error('WS 接続がタイムアウトした')), 5000)
})
await new Promise((r) => setTimeout(r, 300))
check('WebSocket で init を受け取る', messages[0]?.type === 'init', `受信 ${messages.length} 件`)
ws.close()

// 6. 削除する
const delRes = await fetch(`${BASE}/api/rooms/${created.roomId}`, {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey: second.authKey }),
})
check('合言葉を出せる人が削除できる', delRes.status === 200)

const afterDelete = await fetch(`${BASE}/api/rooms/${created.roomId}/blob`, {
  headers: { Authorization: `Bearer ${token}` },
})
check('削除後は取得できない', afterDelete.status === 404)

console.log(failures === 0 ? '\nすべて通過' : `\n${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
