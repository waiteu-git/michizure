export const MAX_MEMBERS = 20 // クライアント側でのみ強制する。サーバーは検証できない

/**
 * サーバー側の唯一の防御（設計 §7.4）。**復号後の暗号文のバイト数**の上限。
 *
 * ⚠ `ciphertext` は base64 の【文字列】なので、`ciphertext.length` をこの値と
 * 直接比べてはいけない。base64 は 3 バイトを 4 文字にするため、文字数で切ると
 * 実際の上限が 3/4（＝192KiB）に縮み、spec の 256KB と静かにズレる。
 * 比較には必ず ciphertextBytes() を使う。
 */
export const MAX_CIPHERTEXT_BYTES = 256 * 1024

/** base64 文字列が表す復号後のバイト数。サイズ上限の判定にだけ使う（厳密さは不要） */
export function ciphertextBytes(ciphertext: string): number {
  const padding = ciphertext.endsWith('==') ? 2 : ciphertext.endsWith('=') ? 1 : 0
  return Math.floor((ciphertext.length * 3) / 4) - padding
}

/**
 * 本文そのものの足切り。巨大な本文を JSON.parse しないための安い防御で、
 * 上の上限より必ず緩くする（ここで先に弾くと上限の意味が変わってしまう）。
 * 256KiB のバイト列は base64 で約 341KiB になるため、その上に余裕を取る。
 */
export const MAX_REQUEST_BYTES = 512 * 1024

/** 96bit の IV は base64 で16文字。将来の方式変更を見込んでも64文字あれば足りる */
export const MAX_IV_CHARS = 64

/**
 * 認証失敗のカウンタが減衰するまでの時間。
 * 減衰が無いと「先月打ち間違えた5回」が永久に効き、次の1回でいきなり長時間ロックされる。
 * ⚠ これは誤操作の救済であって攻撃対策ではない。§7.4 の限界も参照
 */
export const GATE_DECAY_MS = 24 * 60 * 60 * 1000

/**
 * 部屋ごとの PBKDF2 反復回数の許容範囲。
 * 小さすぎる＝総当たりが容易／大きすぎる＝入室しようとした人の端末が固まる。
 * どちらも部屋を作った人が他の参加者に押し付けられてしまうので、サーバーで挟む
 */
export const MIN_ITERATIONS = 100_000
export const MAX_ITERATIONS = 5_000_000

/**
 * 🔴 鍵導出の規則そのものの版。**正規化の規則と HKDF の info 文字列を含む。**
 *
 * 鍵は「合言葉 → 正規化 → PBKDF2(salt, 反復回数) → HKDF(info)」で決まる。
 * salt と反復回数は部屋ごとに保存して後から変えられるようにしたが、
 * **正規化と info は保存していなかった**＝変えた瞬間に既存の部屋が全部開けなくなる。
 * （反復回数で一度学んだのと同じ形。効くべき面を数え損ねていた）
 *
 * ⇒ 部屋ごとに保存し、その部屋が作られた時の規則で導出する。
 * これにより「NFKC を選ぶ」という規格からの逸脱も、後から取り消せる判断になる。
 */
export const KDF_VERSION = 2
const KNOWN_KDF_VERSIONS = [1, 2]

/**
 * 版ごとの違い（`normalizePassphrase` が正典）:
 *
 * - **1** … NFKC → カタカナ畳み込み → 区切り除去。**設計 §2.2 の ④NFC が抜けている。**
 *   ⇒ 単体の濁点・半濁点（`゛` `゜` `ﾞ` `ﾟ`）で打たれた合言葉が分解形のまま残り、
 *   **画面上まったく同じ合言葉から違う鍵が出る**（`は`+U+3099 と `ば` は別の文字列）。
 *   機構＝NFKC(`゛`) は「空白 + 結合濁点」を生み、続く区切り除去が空白を消すため
 *   合成が起きない。設計 §2.2 の実測表がこの空白生成を最初から記録していた。
 * - **2** … 1 に ④NFC を足したもの。設計 §2.2 のパイプラインどおり。
 *
 * ⚠ 1 を残してあるのは、**本番にデプロイ済みかを実装側から確認できない**ため
 *   （Cloudflare の操作は人間の手）。既に 1 で作られた部屋があれば、消すと二度と開かない。
 *   **一度もデプロイしていないことを人間が確認できたら、1 は削除してよい**
 *   （launch 前ならそれが最も綺麗＝壊れた版を恒久的に抱えずに済む）。
 */

export function kdfVersionInvalid(v: unknown): boolean {
  return typeof v !== 'number' || !KNOWN_KDF_VERSIONS.includes(v)
}

/**
 * 暗号文の「形」だけを見る。中身は読まない・読めない。
 * ⚠ ciphertext だけを見ていると iv など他のフィールドが素通りし、
 * サイズ上限をすり抜けて保存されてしまう。
 */
export function blobShapeInvalid(blob: unknown): boolean {
  const b = blob as Blob | undefined
  if (!b || typeof b.ciphertext !== 'string' || typeof b.iv !== 'string') return true
  if (b.iv.length > MAX_IV_CHARS) return true
  return false
}

/** 反復回数が「その部屋に入ろうとする他人の端末で走らせてよい範囲」か */
export function iterationsInvalid(iterations: unknown): boolean {
  return (
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  )
}
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

/**
 * 🔴 **版の番号。書き込みのたびに1つ増える。**
 *
 * サーバーは中身を読めないので、送られてきた暗号文が「今持っている版から
 * 育ったもの」かどうかを中身では判定できない。番号を持たせて、
 * **今の番号を見ていない書き込みを断る**（設計 §9 の3方向マージは、
 * 断られた側が取り込み直してから送り直すことで初めて働く）。
 *
 * ⚠ これで新しく漏れるものは無い。**更新の回数はもともとサーバーから見えている**
 * （設計 §7.5＝暗号文の大きさと更新の頻度）。番号はそれを名前で呼んだだけ。
 */
export type Rev = number

export type ClientMessage = { type: 'update'; blob: Blob; baseRev: Rev }
export type ServerMessage =
  | { type: 'init'; blob: Blob | null; rev: Rev }
  | { type: 'update'; blob: Blob; rev: Rev }
  | { type: 'error'; code: string }

/**
 * ネイティブのシェルから API を叩く時に許可するオリジン。
 *
 * 🔴 **全開（`*`）にしてはいけない。** 誰のページからでも部屋を叩けるようになる。
 * ここは「この一覧に一致した時だけ、そのオリジンをそのまま返す」方式で使う。
 * ⚠ 反射（要求された Origin をそのまま返す）を無条件でやると全開と同じになる。
 *
 * Capacitor の画面の出所＝iOS が `capacitor://localhost`、Android が `http://localhost`。
 */
export const ALLOWED_SHELL_ORIGINS = ['capacitor://localhost', 'http://localhost'] as const

export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null
  return (ALLOWED_SHELL_ORIGINS as readonly string[]).includes(origin) ? origin : null
}
