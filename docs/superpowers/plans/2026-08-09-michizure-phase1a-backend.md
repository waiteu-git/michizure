# Michizure Phase 1a: バックエンド基盤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

改訂: 2026-08-10（クライアントサイド暗号化の追加に伴い全面書き直し）

**Goal:** Cloudflare Workers + Durable Objects 上に「合言葉つきの部屋」のバックエンドを構築する。サーバーは暗号文とメタデータのみを保持し、部屋の作成・入室・同期・自動削除がテスト付きで動く状態にする。

**Architecture:** 合言葉からクライアント側で `authKey`（認証用）と `encKey`（暗号化用）を導出する。サーバーへ渡すのは `authKey` のみで、合言葉の平文も `encKey` も送らない。Durable Object は AES-GCM の暗号文をそのまま保存・中継し、中身を読まない。

**Tech Stack:** TypeScript / Cloudflare Workers / Durable Objects (SQLite backend) / wrangler / vitest + @cloudflare/vitest-pool-workers / WebCrypto (PBKDF2 + HKDF + AES-GCM)

設計文書: `docs/superpowers/specs/2026-08-09-michizure-phase1-design.md`

## Global Constraints

- **合言葉の平文をサーバーへ送信してはならない。** 送るのは `authKey` のみ
- **`encKey` をサーバーへ送信・保存してはならない**
- 合言葉・`authKey`・`encKey`・平文の `RoomState` を**ログやエラーメッセージに含めてはならない**
- AES-GCM の **IV は暗号化のたびにランダム生成する**（再利用は致命的）
- サーバーは暗号文の中身を検証しない。防御は**バイト数上限 256KB のみ**
- メンバー20人上限は**クライアント側でのみ強制**する。サーバーは強制できない（設計 §7.4）
- 部屋は**最終アクセスから1年**で自動削除する
- booking の id は**クライアント生成の UUID**
- WebSocket は **Hibernation API** を使う（`ctx.acceptWebSocket()`）。`server.accept()` を使ってはならない
- **送信者除外はサーバー側だけで行う。** クライアント側に重複防止フラグを置いてはならない
- Durable Object は **SQLite ストレージバックエンド**（`new_sqlite_classes`）を使う
- **本番 travel.waiteu.dev へ書き込むテストを行ってはならない**
- 本計画は**新規 PRIVATE リポジトリ**で実施する。リポジトリ作成は公開時でよく、それまではローカルの git で進めてよい

---

## File Structure

| ファイル | 責務 |
|---|---|
| `wrangler.toml` / `package.json` / `tsconfig.json` / `vitest.config.ts` | 設定 |
| `src/types.ts` | 共有型と定数 |
| `src/keys.ts` | **鍵導出**（PBKDF2 → HKDF）。クライアントとテストが使う。純粋関数のみ |
| `src/box.ts` | **暗号化と復号**（AES-GCM）。クライアントとテストが使う。純粋関数のみ |
| `src/token.ts` | 部屋IDの生成、アクセストークンの発行と検証。Worker が使う |
| `src/room.ts` | Durable Object。暗号文の保存、WebSocket、ブロードキャスト、Alarm |
| `src/index.ts` | Worker。ルーティングと DO へのディスパッチ |
| `test/keys.test.ts` / `test/box.test.ts` / `test/token.test.ts` | 上記のユニットテスト |
| `test/room.test.ts` | 部屋の作成・入室・暗号文の読み書き |
| `test/sync.test.ts` | WebSocket 中継と送信者除外 |
| `test/no-plaintext.test.ts` | **サーバーが平文を受け取らないことの検証** |
| `test/isolation.test.ts` | 部屋間の分離 |
| `test/deletion.test.ts` | 手動削除と自動削除 |

鍵導出・暗号化・トークンを3ファイルに分けるのは、いずれも純粋関数で単体検証でき、かつ最も間違えやすい部分だから。DO のライフサイクルを持ち込まずにテストする。

---

### Task 1: プロジェクト初期化とテスト基盤

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: DO バインディング名 `ROOM`、クラス名 `Room`、テストコマンド `npm test`

- [ ] **Step 1: プロジェクトを作成して依存を入れる**

```bash
mkdir michizure && cd michizure && git init
npm init -y
npm install --save-dev wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: 設定ファイルを書く**

`package.json` の `scripts` を次に置き換える:

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2022"],
    "module": "es2022",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`wrangler.toml`:

```toml
name = "michizure"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]

[limits]
cpu_ms = 50

# 開発専用。本番は `wrangler secret put TOKEN_SECRET` で上書きすること。
# この値が本番で使われるとアクセストークンを誰でも偽造できる
[vars]
TOKEN_SECRET = "dev-only-secret-do-not-use-in-production"
```

`vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: './wrangler.toml' } },
    },
  },
})
```

- [ ] **Step 3: 失敗するスモークテストを書く**

`test/smoke.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('worker', () => {
  it('ヘルスチェックに応答する', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('DO バインディングが存在する', () => {
    expect(env.ROOM).toBeDefined()
  })
})
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `npm test`
Expected: FAIL。`src/index.ts` が存在せずモジュール解決に失敗する

- [ ] **Step 5: 最小の実装を書く**

`src/index.ts`:

```ts
import { DurableObject } from 'cloudflare:workers'

export interface Env {
  ROOM: DurableObjectNamespace
  TOKEN_SECRET: string
}

export class Room extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（2件）

- [ ] **Step 7: コミット**

```bash
git add -A
git commit -m "chore: Workers + Durable Objects のプロジェクト基盤を作る"
```

---

### Task 2: 鍵導出

**Files:**
- Create: `src/keys.ts`, `test/keys.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `generateSalt(): string` — base64 の16バイト
  - `deriveKeys(passphrase: string, salt: string, iterations: number): Promise<{ authKey: string; encKeyBits: ArrayBuffer }>` — `authKey` は base64、`encKeyBits` は AES-GCM 用の生ビット
  - `PBKDF2_ITERATIONS: number` — 本番用の反復回数

`iterations` を引数にするのは、テストで低い値を使って高速化するため。**本番コードでは必ず `PBKDF2_ITERATIONS` を渡すこと。**

- [ ] **Step 1: 失敗するテストを書く**

`test/keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'

const FAST = 1000 // テスト用の低い反復回数

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

describe('鍵導出', () => {
  it('ソルトは毎回異なる', () => {
    const salts = new Set(Array.from({ length: 50 }, () => generateSalt()))
    expect(salts.size).toBe(50)
  })

  it('同じ合言葉とソルトから同じ鍵が出る', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('たびのあいことば', salt, FAST)
    const b = await deriveKeys('たびのあいことば', salt, FAST)
    expect(b.authKey).toBe(a.authKey)
    expect(b64(b.encKeyBits)).toBe(b64(a.encKeyBits))
  })

  it('合言葉が違えば鍵も違う', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('ことばA', salt, FAST)
    const b = await deriveKeys('ことばB', salt, FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('ソルトが違えば鍵も違う', async () => {
    const a = await deriveKeys('おなじ', generateSalt(), FAST)
    const b = await deriveKeys('おなじ', generateSalt(), FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('authKey と encKey は別物である', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ことば', generateSalt(), FAST)
    expect(authKey).not.toBe(b64(encKeyBits))
  })

  it('鍵に合言葉の平文が含まれない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ひみつのことば', generateSalt(), FAST)
    expect(authKey).not.toContain('ひみつのことば')
    expect(b64(encKeyBits)).not.toContain('ひみつのことば')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/keys.test.ts`
Expected: FAIL。`src/keys.ts` が存在しない

- [ ] **Step 3: 実装を書く**

`src/keys.ts`:

```ts
// 本番の反復回数。ローエンド端末で実測して調整すること（設計 §16 の未決事項）
export const PBKDF2_ITERATIONS = 600_000

const enc = new TextEncoder()

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function generateSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

/**
 * 合言葉から authKey（サーバーへ送る）と encKey（送らない）を導出する。
 * 別々の info から HKDF で分岐させるため、authKey が漏れても encKey は導出できない。
 */
export async function deriveKeys(
  passphrase: string,
  salt: string,
  iterations: number,
): Promise<{ authKey: string; encKeyBits: ArrayBuffer }> {
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ])
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
    pwKey,
    256,
  )
  const master = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits'])

  const derive = (info: string) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
      master,
      256,
    )

  const [authBits, encKeyBits] = await Promise.all([
    derive('michizure-auth-v1'),
    derive('michizure-enc-v1'),
  ])
  return { authKey: toBase64(new Uint8Array(authBits)), encKeyBits }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npm test test/keys.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: コミット**

```bash
git add src/keys.ts test/keys.test.ts
git commit -m "feat: 合言葉から authKey と encKey を導出する"
```

---

### Task 3: 暗号化と復号

**Files:**
- Create: `src/box.ts`, `test/box.test.ts`

**Interfaces:**
- Consumes: `src/keys.ts` の `toBase64` / `fromBase64`
- Produces:
  - `seal(encKeyBits: ArrayBuffer, plain: unknown): Promise<{ ciphertext: string; iv: string }>`
  - `open<T>(encKeyBits: ArrayBuffer, ciphertext: string, iv: string): Promise<T>` — 失敗時は例外

- [ ] **Step 1: 失敗するテストを書く**

`test/box.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal, open } from '../src/box'

const FAST = 1000

async function key(passphrase = 'ことば') {
  return (await deriveKeys(passphrase, generateSalt(), FAST)).encKeyBits
}

const state = {
  name: '沖縄旅行',
  members: [{ id: 'm1', name: '山田' }],
  bookings: [{ id: 'b1', amount: 12345 }],
}

describe('暗号化', () => {
  it('往復して元に戻る', async () => {
    const k = await key()
    const { ciphertext, iv } = await seal(k, state)
    expect(await open(k, ciphertext, iv)).toEqual(state)
  })

  it('IV は毎回異なる', async () => {
    const k = await key()
    const a = await seal(k, state)
    const b = await seal(k, state)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('暗号文に平文が現れない', async () => {
    const k = await key()
    const { ciphertext } = await seal(k, state)
    expect(ciphertext).not.toContain('沖縄旅行')
    expect(ciphertext).not.toContain('山田')
    expect(ciphertext).not.toContain('12345')
  })

  it('別の鍵では復号できない', async () => {
    const { ciphertext, iv } = await seal(await key('ことばA'), state)
    await expect(open(await key('ことばB'), ciphertext, iv)).rejects.toThrow()
  })

  it('改ざんされた暗号文を拒否する', async () => {
    const k = await key()
    const { ciphertext, iv } = await seal(k, state)
    const bytes = atob(ciphertext).split('')
    bytes[0] = bytes[0] === 'A' ? 'B' : 'A'
    await expect(open(k, btoa(bytes.join('')), iv)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/box.test.ts`
Expected: FAIL。`src/box.ts` が存在しない

- [ ] **Step 3: 実装を書く**

`src/box.ts`:

```ts
import { toBase64, fromBase64 } from './keys'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function importKey(encKeyBits: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encKeyBits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(
  encKeyBits: ArrayBuffer,
  plain: unknown,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(encKeyBits)
  // GCM では IV の再利用が致命的なので、暗号化のたびに必ず新しく生成する
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(plain)),
  )
  return { ciphertext: toBase64(new Uint8Array(buf)), iv: toBase64(iv) }
}

export async function open<T>(
  encKeyBits: ArrayBuffer,
  ciphertext: string,
  iv: string,
): Promise<T> {
  const key = await importKey(encKeyBits)
  // 鍵違い・改ざんはここで例外になる（AES-GCM の認証タグ検証）
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  )
  return JSON.parse(dec.decode(buf)) as T
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npm test test/box.test.ts`
Expected: PASS（5件）

- [ ] **Step 5: コミット**

```bash
git add src/box.ts test/box.test.ts
git commit -m "feat: AES-GCM による暗号化と復号を追加"
```

---

### Task 4: 部屋IDとアクセストークン

**Files:**
- Create: `src/token.ts`, `test/token.test.ts`

**Interfaces:**
- Consumes: `src/keys.ts` の `toBase64`
- Produces:
  - `generateRoomId(): string` — 16文字
  - `issueToken(roomId, secret, ttlMs, now): Promise<string>`
  - `verifyToken(token, roomId, secret, now): Promise<boolean>`

`now` を引数で受け取るのは、期限切れをテストで再現するため。**実装内で `Date.now()` を呼ばないこと。**

- [ ] **Step 1: 失敗するテストを書く**

`test/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateRoomId, issueToken, verifyToken } from '../src/token'

const SECRET = 'test-secret'
const NOW = 1_700_000_000_000

describe('部屋ID', () => {
  it('16文字で生成される', () => {
    expect(generateRoomId()).toHaveLength(16)
  })

  it('毎回異なる', () => {
    expect(new Set(Array.from({ length: 100 }, () => generateRoomId())).size).toBe(100)
  })

  it('紛らわしい文字を含まない', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRoomId()).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/)
    }
  })
})

describe('アクセストークン', () => {
  it('発行したトークンを検証できる', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM0000ROOM0000', SECRET, NOW + 1000)).toBe(true)
  })

  it('期限切れを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM0000ROOM0000', SECRET, NOW + 60_001)).toBe(false)
  })

  it('別の部屋のトークンを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM9999ROOM9999', SECRET, NOW)).toBe(false)
  })

  it('改ざんされたトークンを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')
    expect(await verifyToken(tampered, 'ROOM0000ROOM0000', SECRET, NOW)).toBe(false)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/token.test.ts`
Expected: FAIL。`src/token.ts` が存在しない

- [ ] **Step 3: 実装を書く**

`src/token.ts`:

```ts
import { toBase64 } from './keys'

const enc = new TextEncoder()
// Crockford base32 から I / L / O / U を除いた文字集合。読み間違いを避ける
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))))
}

export async function issueToken(
  roomId: string,
  secret: string,
  ttlMs: number,
  now: number,
): Promise<string> {
  const payload = `${roomId}.${now + ttlMs}`
  return `${payload}.${await sign(payload, secret)}`
}

export async function verifyToken(
  token: string,
  roomId: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [tokenRoomId, expiresAt, sig] = parts
  if (tokenRoomId !== roomId) return false
  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || now > expiry) return false
  const expected = await sign(`${tokenRoomId}.${expiresAt}`, secret)
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npm test test/token.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: コミット**

```bash
git add src/token.ts test/token.test.ts
git commit -m "feat: 部屋IDの生成と署名付きアクセストークンを追加"
```

---

### Task 5: 型定義

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Consumes: なし
- Produces: `Blob`, `RoomMeta`, `Member`, `Booking`, `RoomState`, `ClientMessage`, `ServerMessage`, 各定数

- [ ] **Step 1: 型を書く**

`src/types.ts`:

```ts
export const MAX_MEMBERS = 20 // クライアント側でのみ強制する。サーバーは検証できない
export const MAX_BLOB_BYTES = 256 * 1024 // サーバー側の唯一の防御
export const ROOM_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 最終アクセスから1年
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30日

/** サーバーが保持する暗号文。サーバーはこの中身を読めない */
export interface Blob {
  ciphertext: string
  iv: string
  blobVersion: number
}

/** サーバーが保持する平文のメタデータ */
export interface RoomMeta {
  roomId: string
  createdAt: number
  lastAccessAt: number
  schemaVersion: number
}

// --- 以下はクライアントだけが扱う。サーバーには平文で渡らない ---

export interface Member {
  id: string
  name: string
}

export interface Booking {
  id: string // クライアント生成の UUID
  category: string
  description: string
  payer: string // Member.id
  amount: number
  participants: string[] // Member.id[]
  paid: Record<string, true>
}

export interface RoomState {
  name: string
  startDate: string | null
  endDate: string | null
  members: Member[]
  bookings: Booking[]
}

export type ClientMessage = { type: 'update'; blob: Blob }
export type ServerMessage =
  | { type: 'init'; blob: Blob | null }
  | { type: 'update'; blob: Blob }
  | { type: 'error'; code: string }
```

- [ ] **Step 2: 型検査が通ることを確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/types.ts
git commit -m "feat: 暗号文とメタデータの型を定義する"
```

---

### Task 6: 部屋の作成

**Files:**
- Create: `src/room.ts`, `test/room.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Task 2〜5
- Produces:
  - `POST /api/rooms` body `{ salt, authKey, blob }` → `{ roomId, token }`
  - DO 内部ルート `POST /create`

- [ ] **Step 1: 失敗するテストを書く**

`test/room.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 1000

export async function makeRoomPayload(passphrase = 'あいことば', name = '沖縄旅行') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name, members: [], bookings: [] })), blobVersion: 1 }
  return { salt, authKey, blob, encKeyBits }
}

async function createRoom(overrides: Record<string, unknown> = {}) {
  const { salt, authKey, blob } = await makeRoomPayload()
  return SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, ...overrides }),
  })
}

describe('部屋の作成', () => {
  it('roomId とトークンを返す', async () => {
    const res = await createRoom()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { roomId: string; token: string }
    expect(json.roomId).toHaveLength(16)
    expect(json.token).toBeTruthy()
  })

  it('毎回異なる roomId になる', async () => {
    const a = (await (await createRoom()).json()) as { roomId: string }
    const b = (await (await createRoom()).json()) as { roomId: string }
    expect(a.roomId).not.toBe(b.roomId)
  })

  it('authKey がなければ拒否する', async () => {
    expect((await createRoom({ authKey: '' })).status).toBe(400)
  })

  it('salt がなければ拒否する', async () => {
    expect((await createRoom({ salt: '' })).status).toBe(400)
  })

  it('大きすぎる暗号文を拒否する', async () => {
    const blob = { ciphertext: 'A'.repeat(300 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await createRoom({ blob })).status).toBe(413)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/room.test.ts`
Expected: FAIL。すべて 404 が返る

- [ ] **Step 3: DO を実装する**

`src/room.ts`:

```ts
import { DurableObject } from 'cloudflare:workers'
import { ROOM_TTL_MS, type Blob, type RoomMeta } from './types'

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/create') return this.handleCreate(request)
    return new Response('Not Found', { status: 404 })
  }

  private sql() {
    return this.ctx.storage.sql
  }

  private ensureSchema(): void {
    this.sql().exec('CREATE TABLE IF NOT EXISTS room (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  private put(key: string, value: unknown): void {
    this.sql().exec(
      'INSERT INTO room (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    )
  }

  private get<T>(key: string): T | null {
    const rows = [...this.sql().exec('SELECT value FROM room WHERE key = ?', key)]
    return rows.length === 0 ? null : (JSON.parse(rows[0].value as string) as T)
  }

  private async handleCreate(request: Request): Promise<Response> {
    this.ensureSchema()
    if (this.get<RoomMeta>('meta') !== null) {
      return Response.json({ error: 'already_exists' }, { status: 409 })
    }
    const body = (await request.json()) as {
      roomId: string
      salt: string
      authKeyHash: string
      blob: Blob
      now: number
    }
    this.put('meta', {
      roomId: body.roomId,
      createdAt: body.now,
      lastAccessAt: body.now,
      schemaVersion: 1,
    } satisfies RoomMeta)
    this.put('auth', { salt: body.salt, authKeyHash: body.authKeyHash })
    this.put('blob', body.blob)
    await this.ctx.storage.setAlarm(body.now + ROOM_TTL_MS)
    return Response.json({ ok: true })
  }

  async alarm(): Promise<void> {
    // Task 11 で実装する
  }
}
```

- [ ] **Step 4: Worker を実装する**

`src/index.ts` を次に置き換える:

```ts
import { generateRoomId, issueToken } from './token'
import { toBase64 } from './keys'
import { MAX_BLOB_BYTES, TOKEN_TTL_MS, type Blob } from './types'

export { Room } from './room'

export interface Env {
  ROOM: DurableObjectNamespace
  TOKEN_SECRET: string
}

function roomStub(env: Env, roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId))
}

/** authKey をそのまま保存しないためのハッシュ。ストレージが漏れても認証には使えない */
export async function hashAuthKey(authKey: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authKey))
  return toBase64(new Uint8Array(buf))
}

export function blobTooLarge(blob: Blob | undefined): boolean {
  if (!blob || typeof blob.ciphertext !== 'string') return false
  return blob.ciphertext.length > MAX_BLOB_BYTES
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  let body: { salt?: string; authKey?: string; blob?: Blob }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.salt) return Response.json({ error: 'salt_required' }, { status: 400 })
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })
  if (!body.blob?.ciphertext) return Response.json({ error: 'blob_required' }, { status: 400 })
  if (blobTooLarge(body.blob)) return Response.json({ error: 'blob_too_large' }, { status: 413 })

  const roomId = generateRoomId()
  const now = Date.now()
  const res = await roomStub(env, roomId).fetch('https://do/create', {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      salt: body.salt,
      authKeyHash: await hashAuthKey(body.authKey),
      blob: body.blob,
      now,
    }),
  })
  if (!res.ok) return Response.json({ error: 'create_failed' }, { status: 500 })

  return Response.json({ roomId, token: await issueToken(roomId, env.TOKEN_SECRET, TOKEN_TTL_MS, now) })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return handleCreateRoom(request, env)
    }
    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（smoke 2 + keys 6 + box 5 + token 7 + room 5 = 25件）

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: 暗号文を受け取る部屋の作成エンドポイントを追加"
```

---

### Task 7: ソルトの取得と入室

**Files:**
- Modify: `src/room.ts`, `src/index.ts`, `test/room.test.ts`

**Interfaces:**
- Consumes: Task 6
- Produces:
  - `GET /api/rooms/:roomId/salt` → `{ salt }`（認証前に必要）
  - `POST /api/rooms/:roomId/enter` body `{ authKey }` → `{ token }` / 401 / 404 / 429

- [ ] **Step 1: 失敗するテストを追記**

`test/room.test.ts` の末尾に追記:

```ts
async function createAndGet(passphrase = 'せいかい') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name: 'X', members: [], bookings: [] })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  const json = (await res.json()) as { roomId: string; token: string }
  return { ...json, salt, authKey }
}

async function enter(roomId: string, authKey: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey }),
  })
}

describe('入室', () => {
  it('ソルトを認証前に取得できる', async () => {
    const room = await createAndGet()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/salt`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { salt: string }).salt).toBe(room.salt)
  })

  it('正しい authKey でトークンを得る', async () => {
    const room = await createAndGet()
    const res = await enter(room.roomId, room.authKey)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { token: string }).token).toBeTruthy()
  })

  it('誤った authKey を拒否する', async () => {
    const room = await createAndGet('せいかい')
    const wrong = (await deriveKeys('まちがい', room.salt, FAST)).authKey
    expect((await enter(room.roomId, wrong)).status).toBe(401)
  })

  it('存在しない部屋は404を返す', async () => {
    expect((await enter('ZZZZZZZZZZZZZZZZ', 'anything')).status).toBe(404)
  })

  it('連続failで429になり、その後は正解でも弾かれる', async () => {
    const room = await createAndGet('せいかい')
    const wrong = (await deriveKeys('まちがい', room.salt, FAST)).authKey
    for (let i = 0; i < 5; i++) await enter(room.roomId, wrong)
    expect((await enter(room.roomId, room.authKey)).status).toBe(429)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/room.test.ts`
Expected: FAIL。入室系5件が 404 で落ちる

- [ ] **Step 3: DO に実装する**

`src/room.ts` の `fetch` に分岐を追加:

```ts
    if (url.pathname === '/salt') return this.handleSalt()
    if (url.pathname === '/enter') return this.handleEnter(request)
```

メソッドを追記:

```ts
  private handleSalt(): Response {
    this.ensureSchema()
    const auth = this.get<{ salt: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })
    // ソルトは秘密ではない。認証前に渡さないとクライアントが鍵を導出できない
    return Response.json({ salt: auth.salt })
  }

  private async handleEnter(request: Request): Promise<Response> {
    this.ensureSchema()
    const auth = this.get<{ salt: string; authKeyHash: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })

    const body = (await request.json()) as { authKeyHash: string; now: number }
    const gate = this.get<{ failures: number; blockedUntil: number }>('gate') ?? {
      failures: 0,
      blockedUntil: 0,
    }
    if (body.now < gate.blockedUntil) {
      return Response.json({ error: 'too_many_attempts' }, { status: 429 })
    }

    if (!constantTimeEquals(body.authKeyHash, auth.authKeyHash)) {
      const failures = gate.failures + 1
      // 5回目以降は指数バックオフ（5回目=1分、6回目=2分…最大1時間）
      const blockedUntil =
        failures >= 5 ? body.now + Math.min(60_000 * 2 ** (failures - 5), 3_600_000) : 0
      this.put('gate', { failures, blockedUntil })
      return Response.json({ error: 'invalid_key' }, { status: 401 })
    }

    this.put('gate', { failures: 0, blockedUntil: 0 })
    const meta = this.get<RoomMeta>('meta')!
    this.put('meta', { ...meta, lastAccessAt: body.now })
    await this.ctx.storage.setAlarm(body.now + ROOM_TTL_MS)
    return Response.json({ ok: true })
  }
```

`src/room.ts` の末尾に追加:

```ts
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

- [ ] **Step 4: Worker にルートを追加する**

`src/index.ts` に追加:

```ts
async function handleSalt(env: Env, roomId: string): Promise<Response> {
  const res = await roomStub(env, roomId).fetch('https://do/salt')
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } })
}

async function handleEnterRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  let body: { authKey?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })

  const now = Date.now()
  const res = await roomStub(env, roomId).fetch('https://do/enter', {
    method: 'POST',
    body: JSON.stringify({ authKeyHash: await hashAuthKey(body.authKey), now }),
  })
  if (!res.ok) return new Response(res.body, { status: res.status })

  return Response.json({ token: await issueToken(roomId, env.TOKEN_SECRET, TOKEN_TTL_MS, now) })
}
```

ルーティングに追加:

```ts
    const saltMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/salt$/)
    if (saltMatch && request.method === 'GET') return handleSalt(env, saltMatch[1])

    const enterMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/enter$/)
    if (enterMatch && request.method === 'POST') return handleEnterRoom(request, env, enterMatch[1])
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（30件）

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: ソルト取得と authKey による入室を追加"
```

---

### Task 8: 暗号文の取得と更新

**Files:**
- Modify: `src/room.ts`, `src/index.ts`, `test/room.test.ts`

**Interfaces:**
- Consumes: Task 7 のトークン
- Produces:
  - `GET /api/rooms/:roomId/blob`（`Authorization: Bearer <token>`）→ `Blob`
  - `PUT /api/rooms/:roomId/blob`（同上）→ `{ ok: true }` / 413

- [ ] **Step 1: 失敗するテストを追記**

`test/room.test.ts` の末尾に追記:

```ts
async function getBlob(roomId: string, token: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function putBlob(roomId: string, token: string, blob: unknown) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(blob),
  })
}

describe('暗号文', () => {
  it('保存した暗号文を読み戻して復号できる', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
    const first = { ...(await seal(encKeyBits, { name: '初期', members: [], bookings: [] })), blobVersion: 1 }
    const created = (await (
      await SELF.fetch('https://example.com/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt, authKey, blob: first }),
      })
    ).json()) as { roomId: string; token: string }

    const updated = {
      ...(await seal(encKeyBits, { name: '更新後', members: [{ id: 'm1', name: 'A' }], bookings: [] })),
      blobVersion: 1,
    }
    expect((await putBlob(created.roomId, created.token, updated)).status).toBe(200)

    const got = (await (await getBlob(created.roomId, created.token)).json()) as {
      ciphertext: string
      iv: string
    }
    const { open } = await import('../src/box')
    expect(await open<{ name: string }>(encKeyBits, got.ciphertext, got.iv)).toMatchObject({
      name: '更新後',
    })
  })

  it('トークンなしを拒否する', async () => {
    const room = await createAndGet()
    expect((await getBlob(room.roomId, '')).status).toBe(401)
  })

  it('大きすぎる暗号文を拒否する', async () => {
    const room = await createAndGet()
    const big = { ciphertext: 'A'.repeat(300 * 1024), iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1 }
    expect((await putBlob(room.roomId, room.token, big)).status).toBe(413)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/room.test.ts`
Expected: FAIL。暗号文系3件が 404 で落ちる

- [ ] **Step 3: DO に実装する**

`src/room.ts` の `fetch` に分岐を追加:

```ts
    if (url.pathname === '/blob' && request.method === 'GET') return this.handleGetBlob()
    if (url.pathname === '/blob' && request.method === 'PUT') return this.handlePutBlob(request)
```

メソッドを追記:

```ts
  private handleGetBlob(): Response {
    this.ensureSchema()
    const blob = this.get<Blob>('blob')
    if (blob === null) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(blob)
  }

  private async handlePutBlob(request: Request): Promise<Response> {
    this.ensureSchema()
    if (this.get<Blob>('blob') === null) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    // 中身は読まない。読めない。サイズだけ見る
    const blob = (await request.json()) as Blob
    if (typeof blob?.ciphertext !== 'string' || typeof blob?.iv !== 'string') {
      return Response.json({ error: 'invalid_blob' }, { status: 400 })
    }
    this.put('blob', blob)
    return Response.json({ ok: true })
  }
```

- [ ] **Step 4: Worker に認証付きルートを追加する**

`src/index.ts` に追加:

```ts
import { generateRoomId, issueToken, verifyToken } from './token'

async function authorize(request: Request, env: Env, roomId: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token ? verifyToken(token, roomId, env.TOKEN_SECRET, Date.now()) : false
}

async function handleBlob(request: Request, env: Env, roomId: string): Promise<Response> {
  if (!(await authorize(request, env, roomId))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  let body: string | undefined
  if (request.method === 'PUT') {
    body = await request.text()
    if (body.length > MAX_BLOB_BYTES * 2) {
      return Response.json({ error: 'blob_too_large' }, { status: 413 })
    }
  }
  const res = await roomStub(env, roomId).fetch('https://do/blob', { method: request.method, body })
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } })
}
```

ルーティングに追加:

```ts
    const blobMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/blob$/)
    if (blobMatch && (request.method === 'GET' || request.method === 'PUT')) {
      return handleBlob(request, env, blobMatch[1])
    }
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（33件）

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: 暗号文の取得と更新をトークン認証つきで追加"
```

---

### Task 9: WebSocket 中継と送信者除外

**Files:**
- Modify: `src/room.ts`, `src/index.ts`
- Create: `test/sync.test.ts`

**Interfaces:**
- Consumes: Task 8
- Produces: `GET /api/rooms/:roomId/ws?token=<token>` — 接続時に `{type:'init', blob}` を送り、`{type:'update', blob}` を受けたら**送信者以外の全接続へ**転送する

**この Task の Step 1 のテストは省略・簡略化してはならない。** 前身プロジェクトで送信者除外が壊れていたことに気づけなかった原因が、この検証の欠如だった。

- [ ] **Step 1: 失敗するテストを書く**

`test/sync.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 1000

async function createRoom() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name: '初期', members: [], bookings: [] })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), encKeyBits }
}

async function connect(roomId: string, token: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/ws?token=${token}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket!
  ws.accept()
  return ws
}

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    ws.addEventListener(
      'message',
      (e: MessageEvent) => {
        clearTimeout(timer)
        resolve(JSON.parse(e.data as string))
      },
      { once: true },
    )
  })
}

describe('WebSocket 中継', () => {
  it('接続時に init を受け取る', async () => {
    const room = await createRoom()
    const ws = await connect(room.roomId, room.token)
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('init')
    expect(msg.blob.ciphertext).toBeTruthy()
    ws.close()
  })

  it('他の接続へ update が届く', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    const b = await connect(room.roomId, room.token)
    await nextMessage(a)
    await nextMessage(b)

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    a.send(JSON.stringify({ type: 'update', blob }))
    const received = await nextMessage(b)
    expect(received.type).toBe('update')
    expect(received.blob.ciphertext).toBe(blob.ciphertext)
    a.close()
    b.close()
  })

  // このテストは削除・簡略化してはならない。
  // 前身プロジェクトで、送信者除外が効いているつもりで実際には
  // 他端末の更新を握り潰していた不具合を、検証がなく見逃した。
  it('送信者自身には update が返らない', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    await nextMessage(a)

    const blob = { ...(await seal(room.encKeyBits, { name: '変更後' })), blobVersion: 1 }
    a.send(JSON.stringify({ type: 'update', blob }))
    await expect(nextMessage(a, 500)).rejects.toThrow('timeout')
    a.close()
  })

  it('update された暗号文が永続化される', async () => {
    const room = await createRoom()
    const a = await connect(room.roomId, room.token)
    await nextMessage(a)
    const blob = { ...(await seal(room.encKeyBits, { name: '永続化' })), blobVersion: 1 }
    a.send(JSON.stringify({ type: 'update', blob }))
    await new Promise((r) => setTimeout(r, 200))
    a.close()

    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(((await res.json()) as { ciphertext: string }).ciphertext).toBe(blob.ciphertext)
  })

  it('トークンなしの接続を拒否する', async () => {
    const room = await createRoom()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/ws?token=bogus`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/sync.test.ts`
Expected: FAIL。すべて 404 か webSocket が undefined になる

- [ ] **Step 3: DO に実装する**

`src/room.ts` の `fetch` に分岐を追加:

```ts
    if (url.pathname === '/ws') return this.handleWebSocket()
```

メソッドを追記:

```ts
  private handleWebSocket(): Response {
    this.ensureSchema()
    const blob = this.get<Blob>('blob')
    if (blob === null) return new Response('not found', { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Hibernation API。server.accept() を使うと DO が常駐し duration 課金が続く
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'init', blob }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    if (message.length > MAX_BLOB_BYTES * 2) {
      ws.send(JSON.stringify({ type: 'error', code: 'blob_too_large' }))
      return
    }
    let msg: { type?: string; blob?: Blob }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (msg.type !== 'update' || typeof msg.blob?.ciphertext !== 'string') return

    this.ensureSchema()
    this.put('blob', msg.blob)

    // 送信者を除外するのはここだけ。クライアント側に重複防止フラグを置いてはならない
    const payload = JSON.stringify({ type: 'update', blob: msg.blob })
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(payload)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason)
  }
```

import に `MAX_BLOB_BYTES` を追加:

```ts
import { MAX_BLOB_BYTES, ROOM_TTL_MS, type Blob, type RoomMeta } from './types'
```

- [ ] **Step 4: Worker にルートを追加する**

`src/index.ts` に追加:

```ts
async function handleWebSocket(request: Request, env: Env, roomId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  if (!(await verifyToken(token, roomId, env.TOKEN_SECRET, Date.now()))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return roomStub(env, roomId).fetch('https://do/ws', { headers: request.headers })
}
```

ルーティングに追加:

```ts
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})\/ws$/)
    if (wsMatch) return handleWebSocket(request, env, wsMatch[1])
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（38件）。**「送信者自身には update が返らない」が PASS していることを目視で確認する**

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: WebSocket Hibernation による暗号文の中継と送信者除外を追加"
```

---

### Task 10: サーバーが平文を受け取らないことの検証と部屋の分離

**Files:**
- Create: `test/no-plaintext.test.ts`, `test/isolation.test.ts`

**Interfaces:**
- Consumes: Task 9
- Produces: なし（既存実装の性質を固定するテストのみ）

このタスクは新機能を追加しない。**設計の中核的な主張（サーバーは平文を持たない・部屋は分離される）が実際に成り立っていることを固定し、後続の変更で壊れたら即座に落ちるようにする。**

- [ ] **Step 1: 平文が渡らないことのテストを書く**

`test/no-plaintext.test.ts`:

```ts
import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'

const FAST = 1000
const SECRET_NAME = 'ヒミツノリョコウメイ'
const SECRET_MEMBER = 'ヤマダタロウ'
const SECRET_AMOUNT = 987654
const PASSPHRASE = 'ヒミツノアイコトバ'

async function createRoomWithSecrets() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(PASSPHRASE, salt, FAST)
  const blob = {
    ...(await seal(encKeyBits, {
      name: SECRET_NAME,
      members: [{ id: 'm1', name: SECRET_MEMBER }],
      bookings: [{ id: 'b1', amount: SECRET_AMOUNT }],
    })),
    blobVersion: 1,
  }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), authKey }
}

describe('サーバーは平文を持たない', () => {
  it('作成レスポンスに平文が現れない', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys(PASSPHRASE, salt, FAST)
    const blob = { ...(await seal(encKeyBits, { name: SECRET_NAME })), blobVersion: 1 }
    const res = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt, authKey, blob }),
    })
    const text = await res.text()
    expect(text).not.toContain(SECRET_NAME)
    expect(text).not.toContain(PASSPHRASE)
  })

  it('DO のストレージに平文も合言葉も authKey も残らない', async () => {
    const room = await createRoomWithSecrets()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))

    const dump = await runInDurableObject(stub, async (instance: Room) => {
      return instance.dumpForTest()
    })

    expect(dump).not.toContain(SECRET_NAME)
    expect(dump).not.toContain(SECRET_MEMBER)
    expect(dump).not.toContain(String(SECRET_AMOUNT))
    expect(dump).not.toContain(PASSPHRASE)
    // authKey そのものではなくハッシュが保存されている
    expect(dump).not.toContain(room.authKey)
  })

  it('blob 取得レスポンスにも平文が現れない', async () => {
    const room = await createRoomWithSecrets()
    const res = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    const text = await res.text()
    expect(text).not.toContain(SECRET_NAME)
    expect(text).not.toContain(SECRET_MEMBER)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/no-plaintext.test.ts`
Expected: FAIL。`dumpForTest` が存在しない

- [ ] **Step 3: 検査用メソッドを追加する**

`src/room.ts` に追記:

```ts
  /** テスト専用。ストレージの全内容を文字列で返す。平文が混入していないかの検査に使う */
  async dumpForTest(): Promise<string> {
    this.ensureSchema()
    const rows = [...this.sql().exec('SELECT key, value FROM room')]
    return JSON.stringify(rows)
  }
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npm test test/no-plaintext.test.ts`
Expected: PASS（3件）

もし落ちた場合は、**設計の中核が壊れているということ**なので、テストを緩めずに実装を直すこと。

- [ ] **Step 5: 部屋の分離テストを書く**

`test/isolation.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal, open } from '../src/box'

const FAST = 1000

async function createRoom(passphrase: string, name: string) {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), encKeyBits, salt, authKey }
}

describe('部屋の分離', () => {
  it('別の部屋のデータが混ざらない', async () => {
    const a = await createRoom('aaa', '部屋Aの旅行')
    const b = await createRoom('bbb', '部屋Bの旅行')

    const resA = await SELF.fetch(`https://example.com/api/rooms/${a.roomId}/blob`, {
      headers: { Authorization: `Bearer ${a.token}` },
    })
    const blobA = (await resA.json()) as { ciphertext: string; iv: string }
    expect(await open<{ name: string }>(a.encKeyBits, blobA.ciphertext, blobA.iv)).toEqual({
      name: '部屋Aの旅行',
    })
  })

  it('部屋Aのトークンでは部屋Bを読めない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/blob`, {
      headers: { Authorization: `Bearer ${a.token}` },
    })
    expect(res.status).toBe(401)
  })

  it('部屋Aの鍵では部屋Bの暗号文を復号できない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/blob`, {
      headers: { Authorization: `Bearer ${b.token}` },
    })
    const blobB = (await res.json()) as { ciphertext: string; iv: string }
    // トークンで取得できても、鍵が違えば中身は読めない（二重の防御）
    await expect(open(a.encKeyBits, blobB.ciphertext, blobB.iv)).rejects.toThrow()
  })

  it('部屋Aの authKey では部屋Bに入れない', async () => {
    const a = await createRoom('aaa', 'A')
    const b = await createRoom('bbb', 'B')
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: a.authKey }),
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（45件）

- [ ] **Step 7: コミット**

```bash
git add -A
git commit -m "test: サーバーが平文を持たないことと部屋の分離を検証する"
```

---

### Task 11: 手動削除と自動削除

**Files:**
- Modify: `src/room.ts`, `src/index.ts`
- Create: `test/deletion.test.ts`

**Interfaces:**
- Consumes: Task 7
- Produces:
  - `DELETE /api/rooms/:roomId` body `{ authKey }` → `{ ok: true }` / 401
  - `Room.alarm()` — 最終アクセスから1年経過していればストレージを破棄する

- [ ] **Step 1: 失敗するテストを書く**

`test/deletion.test.ts`:

```ts
import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'

const FAST = 1000

async function createRoom(passphrase = 'けす') {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys(passphrase, salt, FAST)
  const blob = { ...(await seal(encKeyBits, { name: '削除テスト' })), blobVersion: 1 }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob }),
  })
  return { ...((await res.json()) as { roomId: string; token: string }), salt, authKey }
}

async function del(roomId: string, authKey: string) {
  return SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey }),
  })
}

async function blobStatus(roomId: string, token: string) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.status
}

describe('部屋の削除', () => {
  it('正しい authKey で削除できる', async () => {
    const room = await createRoom()
    expect((await del(room.roomId, room.authKey)).status).toBe(200)
    expect(await blobStatus(room.roomId, room.token)).toBe(404)
  })

  it('誤った authKey では削除できない', async () => {
    const room = await createRoom('けす')
    const wrong = (await deriveKeys('ちがう', room.salt, FAST)).authKey
    expect((await del(room.roomId, wrong)).status).toBe(401)
    expect(await blobStatus(room.roomId, room.token)).toBe(200)
  })
})

describe('自動削除', () => {
  it('1年経過していれば alarm でデータが消える', async () => {
    const room = await createRoom()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (instance: Room) => {
      await instance.setLastAccessForTest(Date.now() - 400 * 24 * 60 * 60 * 1000)
      await instance.alarm()
    })
    expect(await blobStatus(room.roomId, room.token)).toBe(404)
  })

  it('1年経過していなければ alarm でも消えない', async () => {
    const room = await createRoom()
    const stub = env.ROOM.get(env.ROOM.idFromName(room.roomId))
    await runInDurableObject(stub, async (instance: Room) => {
      await instance.setLastAccessForTest(Date.now() - 24 * 60 * 60 * 1000)
      await instance.alarm()
    })
    expect(await blobStatus(room.roomId, room.token)).toBe(200)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test test/deletion.test.ts`
Expected: FAIL。DELETE が 404、`setLastAccessForTest` が存在しない

- [ ] **Step 3: DO に実装する**

`src/room.ts` の `fetch` に分岐を追加:

```ts
    if (url.pathname === '/delete') return this.handleDelete(request)
```

`alarm()` を置き換え、メソッドを追記:

```ts
  private async handleDelete(request: Request): Promise<Response> {
    this.ensureSchema()
    const auth = this.get<{ authKeyHash: string }>('auth')
    if (auth === null) return Response.json({ error: 'not_found' }, { status: 404 })
    const body = (await request.json()) as { authKeyHash: string }
    if (!constantTimeEquals(body.authKeyHash, auth.authKeyHash)) {
      return Response.json({ error: 'invalid_key' }, { status: 401 })
    }
    await this.destroy()
    return Response.json({ ok: true })
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  async alarm(): Promise<void> {
    this.ensureSchema()
    const meta = this.get<RoomMeta>('meta')
    if (meta === null) return
    if (Date.now() - meta.lastAccessAt >= ROOM_TTL_MS) {
      await this.destroy()
      return
    }
    // まだ使われているので次の期限へ再設定する
    await this.ctx.storage.setAlarm(meta.lastAccessAt + ROOM_TTL_MS)
  }

  /** テスト専用。lastAccessAt を任意の時刻に書き換える */
  async setLastAccessForTest(at: number): Promise<void> {
    this.ensureSchema()
    const meta = this.get<RoomMeta>('meta')
    if (meta === null) return
    this.put('meta', { ...meta, lastAccessAt: at })
  }
```

- [ ] **Step 4: Worker にルートを追加する**

`src/index.ts` に追加:

```ts
async function handleDeleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  let body: { authKey?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.authKey) return Response.json({ error: 'auth_key_required' }, { status: 400 })
  const res = await roomStub(env, roomId).fetch('https://do/delete', {
    method: 'POST',
    body: JSON.stringify({ authKeyHash: await hashAuthKey(body.authKey) }),
  })
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } })
}
```

ルーティングに追加:

```ts
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Z]{16})$/)
    if (roomMatch && request.method === 'DELETE') return handleDeleteRoom(request, env, roomMatch[1])
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npm test`
Expected: PASS（49件）

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: 部屋の手動削除と1年経過での自動削除を追加"
```

---

### Task 12: 全体の通し確認とデプロイ準備

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: Task 1〜11
- Produces: デプロイ可能な状態（**ただしデプロイはリタス初版公開後**）

- [ ] **Step 1: 全テストを実行する**

Run: `npm test`
Expected: PASS（49件）。1件でも落ちていれば先に進まない

- [ ] **Step 2: 型検査を実行する**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: 本番の反復回数で速度を実測する**

`PBKDF2_ITERATIONS`（600,000）が対象端末で許容できるか確かめる。

```bash
npx vitest run --reporter=verbose test/keys.test.ts
```

そのうえで、ブラウザでの実測値を取るため一時的なベンチを書いて確認する:

```ts
// test/bench.test.ts（確認後に削除してよい）
import { it } from 'vitest'
import { deriveKeys, generateSalt, PBKDF2_ITERATIONS } from '../src/keys'

it('本番の反復回数にかかる時間を測る', async () => {
  const start = Date.now()
  await deriveKeys('ことば', generateSalt(), PBKDF2_ITERATIONS)
  console.log(`PBKDF2_ITERATIONS=${PBKDF2_ITERATIONS}: ${Date.now() - start}ms`)
}, 60_000)
```

Run: `npx vitest run test/bench.test.ts`
Expected: 実測値がログに出る。**入室のたびに1回だけ走る処理なので数秒までは許容する。** 極端に遅ければ `PBKDF2_ITERATIONS` を下げ、設計 §16 の未決事項へ実測値を記録する

- [ ] **Step 4: ローカルで起動して手で叩く**

Run: `npm run dev`

**別のターミナルで、まず起動完了を待つ。** wrangler は起動に数秒かかるため、待たずに叩くと接続拒否になり「エンドポイントが壊れている」と誤読する:

```bash
until curl -sf http://localhost:8787/api/health >/dev/null 2>&1; do sleep 1; done; echo "起動完了"
```

Expected: `起動完了` が表示される。出ないまま止まる場合は `npm run dev` 側のログを見る（ポート競合・コンパイルエラー）

起動を確認してから、存在しない部屋への入室が 404 になることを確かめる:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/api/rooms/ZZZZZZZZZZZZZZZZ/enter -H 'Content-Type: application/json' -d '{"authKey":"dummy"}'
```

Expected: `404`

- [ ] **Step 5: README を書く**

`README.md`:

```markdown
# Michizure（道連れ）

旅行の費用を記録して精算まで見届けるアプリ。合言葉つきの「部屋」を作り、URL と合言葉を知っている人だけが入れる。

設計: `docs/superpowers/specs/2026-08-09-michizure-phase1-design.md`

## 開発

    npm install
    npm test        # 全テスト
    npm run dev     # ローカル起動（http://localhost:8787）

## デプロイ

⚠ 公開はリタス初版公開後（設計 §1）。それまでデプロイしない。

本番のトークン署名鍵は wrangler のシークレットとして設定する（wrangler.toml の [vars] は開発用）。

    wrangler secret put TOKEN_SECRET
    npm run deploy

## 設計上の注意

- サーバーは**暗号文とメタデータのみ**を保持する。合言葉も復号鍵も持たない
- ⚠ ただし**この暗号化を利用者は検証できない**（配信している JavaScript は運営者のもの）。
  「運営者にも中身が見えない」等を対外的に謳ってはならない。設計 §7.5 を必ず読むこと
- メンバー20人上限は**クライアント側でのみ強制**される。サーバーは検証できない
- 合言葉を紛失するとデータは復旧できない
```

- [ ] **Step 6: ベンチを削除してコミット**

```bash
rm -f test/bench.test.ts
git add -A
git commit -m "docs: README と本番シークレット・設計上の注意を追加"
```

---

## Self-Review

**1. Spec coverage**

| spec の要求 | 対応 |
|---|---|
| §5 アーキテクチャ（Worker + DO + SQLite、暗号文を保持） | Task 1, 6 |
| §6 サーバーが持つもの / 暗号文の中身 | Task 5, 6 |
| §7.1 鍵導出（PBKDF2 → HKDF、authKey と encKey の分離） | Task 2 |
| §7.2 認証（authKey のハッシュのみ保存、合言葉を送らない） | Task 6, 7, 10 |
| §7.3 暗号化（AES-GCM、IV 毎回生成） | Task 3 |
| §7.4 サーバー側検証の不能とサイズ上限 | Task 6, 8 |
| §7.5 限界（README と設計への明記） | Task 12 |
| §8 Hibernation・暗号文の中継・送信者除外の検証 | Task 9 |
| §11 手動削除・自動削除（DO Alarm） | Task 11 |
| §12 エラー処理（存在しない部屋・鍵違い・サイズ超過） | Task 6, 7, 8, 11 |
| §13 テスト 1（鍵導出） | Task 2 |
| §13 テスト 2（暗号化の往復・IV） | Task 3 |
| §13 テスト 3（認証・バックオフ） | Task 7 |
| §13 テスト 4（平文を受け取らない） | Task 10 |
| §13 テスト 5（送信者除外） | Task 9 |
| §13 テスト 6（部屋の分離） | Task 10 |
| §16 PBKDF2 反復回数の実測 | Task 12 Step 3 |

**未対応（Phase 1b へ送る）:** §9 オフライン、§10 インポート、§11 プライバシーポリシー・利用規約の文面、§13 テスト 7〜9（インポートの同一性・精算ロジックの同値性・オフラインキュー）。いずれもフロントエンド側の実装を伴う。

**2. Placeholder scan**

`alarm()` に Task 6 時点で「Task 11 で実装する」と書いたが、Task 11 で実際に置き換える手順を明示済み。他にプレースホルダなし。

**3. Type consistency**

- `deriveKeys(passphrase, salt, iterations)` → `{ authKey: string, encKeyBits: ArrayBuffer }` — Task 2 で定義、Task 6〜11 のテストで一貫して使用
- `seal(encKeyBits, plain)` → `{ ciphertext, iv }` / `open(encKeyBits, ciphertext, iv)` — Task 3 で定義、以降一貫
- `hashAuthKey(authKey)` — Task 6 で定義、Task 7・11 で使用
- `constantTimeEquals(a, b)` — Task 7 で定義、Task 11 で使用
- `Blob { ciphertext, iv, blobVersion }` — Task 5 で定義、以降すべて同一。テストでも `blobVersion: 1` を必ず付けている
- DO 内部ルート `/create` `/salt` `/enter` `/blob` `/ws` `/delete` — 命名が一貫
- `toBase64` / `fromBase64` は `src/keys.ts` に置き、`src/box.ts` と `src/token.ts` が import する

---

## Phase 1b（次の計画）で扱うもの

本計画の完了後、実際に確定した API シグネチャを前提に次の計画を書く。

1. クライアント側の鍵導出・暗号化の組み込みと、合言葉の入力 UI
2. フロントの部屋対応（現行 UI の移植、メンバー可変化、id の UUID 化）
3. オフライン（ローカル描画、送信キュー、衝突提示）
4. インポート（現行のエクスポート JSON をクライアント側で変換・暗号化）
5. プライバシーポリシー・利用規約・削除導線の UI（§7.5 の限界を踏まえた文面）
6. 独自ドメイン割り当てと公開（**リタス初版公開後**）
