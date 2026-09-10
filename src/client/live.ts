import type { Session } from './api.ts'
import { wsOrigin } from './origins.ts'

/**
 * 同じ部屋を開いている端末へ、変更を即座に届ける。
 *
 * ⚠ 旅先では接続が頻繁に切れる。**切れることを異常として扱わない**＝
 * 黙って繋ぎ直し、繋がらない間もアプリは普通に使える（保存はローカル優先）。
 *
 * 🔴 ただし**繋ぎ直しをタイマーだけに任せない**。詳しくは `wakeUp()`。
 */

/** この端末（このタブ）の識別子。書いた本人へ中継し返さないために使う */
export const clientId = crypto.randomUUID()

type Handlers = {
  /** 🔴 部屋がサーバーから消えた。**繋ぎ直しは止める**（404 に向けて叩き続けない） */
  onGone?: () => void
  /** ⚠ 版も渡す。これが無いと、受け取った側は次の書き込みで必ず断られる */
  onUpdate: (blob: { ciphertext: string; iv: string }, rev: number) => void
  onStatus: (connected: boolean) => void
}

let socket: WebSocket | null = null
let roomOf: string | null = null
let retry = 0
let stopped = false
/** 予約してある繋ぎ直し。電波が戻ったら**取り消して**すぐ繋ぐので、握っておく */
let pending: ReturnType<typeof setTimeout> | null = null
/** 最後に繋ごうとした相手。`wakeUp()` から繋ぎ直すために持つ */
let target: { s: Session; h: Handlers } | null = null

/**
 * ⚠ 何度呼ばれても接続は1本しか作らない。
 * 呼び出し側（renderRoom）は変更のたびに走るので、素直に繋ぐと
 * **描画のたびに接続が増えて溜まる**（サーバー側の監査で実際に見つけた形）。
 */
export function connectLive(s: Session, h: Handlers): void {
  // ⚠ **繋ぎ先の更新を早期 return より前に置く。** 後ろに置くと、同じ部屋で
  // セッション（トークン）が差し替わった時に、繋ぎ直しが古いトークンを使い続ける
  // （2026-09-07 のレビューで指摘）。圏外入室 → 正式入室がまさにこの形。
  const changed = !target || target.s.token !== s.token
  target = { s, h }

  if (socket && roomOf === s.roomId && !changed) {
    const st = socket.readyState
    if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) return
  }
  if (roomOf !== s.roomId) disconnectLive()
  roomOf = s.roomId
  stopped = false
  target = { s, h }
  open(s, h)
}

export function disconnectLive(): void {
  stopped = true
  retry = 0
  roomOf = null
  target = null
  // ⚠ 予約も取り消す。残しておくと、別の部屋へ移った後に発火して**前の部屋へ繋ぐ**
  clearPending()
  drop()
}

function clearPending(): void {
  if (pending === null) return
  clearTimeout(pending)
  pending = null
}

/** 今の接続を手放す。⚠ 先に `socket` を空にする（`down` の持ち主判定より前に） */
function drop(): void {
  const prev = socket
  socket = null
  prev?.close()
}

function open(s: Session, h: Handlers): void {
  if (stopped) return
  clearPending()
  drop()

  const url = `${wsOrigin()}/api/rooms/${s.roomId}/ws?token=${encodeURIComponent(s.token)}&client=${clientId}`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    return schedule(s, h)
  }
  socket = ws

  ws.addEventListener('open', () => {
    retry = 0
    h.onStatus(true)
  })

  ws.addEventListener('message', (e) => {
    let msg: { type?: string; code?: string; blob?: { ciphertext: string; iv: string }; rev?: number }
    try {
      msg = JSON.parse(String(e.data))
    } catch {
      return
    }
    // init は「今のサーバーの中身」、update は「誰かが変えた」。
    // どちらも取り込み方は同じ（判断は呼び出し側の衝突検出に任せる）
    if ((msg.type === 'init' || msg.type === 'update') && msg.blob && typeof msg.rev === 'number') {
      h.onUpdate(msg.blob, msg.rev)
    }
    // ⚠ 以前は error 型を捨てていた。サーバーは削除の瞬間に room_deleted を送っているのに、
    // 端末は 404 に向けて最大30秒おきに繋ぎ直しを続けていた（2026-09-10 の監査で指摘）
    if (msg.type === 'error' && msg.code === 'room_deleted') {
      disconnectLive()
      h.onGone?.()
    }
  })

  /**
   * 🔴 **1回の失敗で1回だけ動くこと。**
   *
   * 繋がらなかった接続は `error` と `close` を**続けて**出す。同じ処理を素直に
   * 両方へ繋ぐと、1回の失敗で繋ぎ直しが2本予約され、待ち時間の倍々も2段ずつ進む
   * ＝上限の30秒に**3回の失敗（体感7秒）で到達する**。
   * 2026-09-06 にテストで実測。**コードを読むだけでは見えなかった**。
   *
   * `socket` が自分でなくなっていたら、その失敗はもう関係ない
   * ——2度目の通知も、`wakeUp()` に追い越された古い接続も、同じ一言で落ちる。
   */
  const down = () => {
    if (socket !== ws) return
    socket = null
    h.onStatus(false)
    schedule(s, h)
  }
  ws.addEventListener('close', down)
  ws.addEventListener('error', down)
}

/**
 * 繋ぎ直しの予約。⚠ 一定間隔で叩き続けない＝圏外のまま電池と通信量を使い切る。
 * 1秒から倍々で最大30秒まで待つ。
 */
function schedule(s: Session, h: Handlers): void {
  if (stopped) return
  const wait = Math.min(1000 * 2 ** retry, 30_000)
  retry++
  pending = setTimeout(() => {
    pending = null
    open(s, h)
  }, wait)
}

/**
 * 🔴 **「繋がるはずの瞬間」を受け取る。**
 *
 * 繋ぎ直しをタイマーだけに任せると、電波が戻っても**最大30秒待たされる**。
 * リロードすると直るのは、待ち時間の積み上げが 0 に戻って即座に繋ぎ直すから
 * ——つまり「リロードで直る」は仕様ではなく、**この購読が無いことの症状**だった
 * （2026-09-06、実機で「合流する時としない時がある」として踏んだ）。
 *
 * ⚠ 画面へ戻った時も見る。機内モードの解除は**アプリの外**（設定・コントロール
 * センター）で行うので、端末は戻ってくるまでタイマーを止めていることがある
 * ＝`online` だけでは、戻った瞬間に動くとは限らない。
 */
function wakeUp(): void {
  if (stopped || !target) return
  if (socket && socket.readyState === WebSocket.OPEN) return
  retry = 0
  open(target.s, target.h)
}

addEventListener('online', wakeUp)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) wakeUp()
})
