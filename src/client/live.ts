import type { Session } from './api.ts'

/**
 * 同じ部屋を開いている端末へ、変更を即座に届ける。
 *
 * ⚠ 旅先では接続が頻繁に切れる。**切れることを異常として扱わない**＝
 * 黙って繋ぎ直し、繋がらない間もアプリは普通に使える（保存はローカル優先）。
 */

/** この端末（このタブ）の識別子。書いた本人へ中継し返さないために使う */
export const clientId = crypto.randomUUID()

type Handlers = {
  onUpdate: (blob: { ciphertext: string; iv: string }) => void
  onStatus: (connected: boolean) => void
}

let socket: WebSocket | null = null
let roomOf: string | null = null
let retry = 0
let stopped = false

/**
 * ⚠ 何度呼ばれても接続は1本しか作らない。
 * 呼び出し側（renderRoom）は変更のたびに走るので、素直に繋ぐと
 * **描画のたびに接続が増えて溜まる**（サーバー側の監査で実際に見つけた形）。
 */
export function connectLive(s: Session, h: Handlers): void {
  if (socket && roomOf === s.roomId) {
    const st = socket.readyState
    if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) return
  }
  if (roomOf !== s.roomId) disconnectLive()
  roomOf = s.roomId
  stopped = false
  open(s, h)
}

export function disconnectLive(): void {
  stopped = true
  retry = 0
  roomOf = null
  socket?.close()
  socket = null
}

function open(s: Session, h: Handlers): void {
  if (stopped) return
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${location.host}/api/rooms/${s.roomId}/ws?token=${encodeURIComponent(s.token)}&client=${clientId}`
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
    let msg: { type?: string; blob?: { ciphertext: string; iv: string } }
    try {
      msg = JSON.parse(String(e.data))
    } catch {
      return
    }
    // init は「今のサーバーの中身」、update は「誰かが変えた」。
    // どちらも取り込み方は同じ（判断は呼び出し側の衝突検出に任せる）
    if ((msg.type === 'init' || msg.type === 'update') && msg.blob) h.onUpdate(msg.blob)
  })

  const down = () => {
    h.onStatus(false)
    if (socket === ws) socket = null
    schedule(s, h)
  }
  ws.addEventListener('close', down)
  ws.addEventListener('error', down)
}

/**
 * 繋ぎ直し。⚠ 一定間隔で叩き続けない＝圏外のまま電池と通信量を使い切る。
 * 1秒から倍々で最大30秒まで待つ。
 */
function schedule(s: Session, h: Handlers): void {
  if (stopped) return
  const wait = Math.min(1000 * 2 ** retry, 30_000)
  retry++
  setTimeout(() => open(s, h), wait)
}
