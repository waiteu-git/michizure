import { loadState, saveState, type RoomState, type Session } from './api.ts'

/**
 * 旅先は電波が悪い。**通信が成功することを前提にしない。**
 *
 * 方針＝ローカル優先（local-first）:
 *   1. 変更は**まず端末に書く**（即座・失敗しない）
 *   2. サーバーへは後から送る。失敗したら「未同期」として残し、繋がった時に再送する
 *   3. 部屋を開く時も**端末の控えを先に見せる**。通信はその後ろで行う
 *
 * ⚠ これが無いと「入力した記録が再読み込みで消える」。旅先で最も起きてほしくない壊れ方。
 */

const KEY = (roomId: string) => `michizure.state.${roomId}`

type Local = {
  state: RoomState
  /** 最後にサーバーで見た（または自分が書いた）版の目印 */
  baseStamp: string | null
  /** 端末にあるがサーバーへ送れていない変更があるか */
  dirty: boolean
}

export type SyncStatus = 'synced' | 'pending' | 'offline' | 'conflict'

function read(roomId: string): Local | null {
  try {
    const raw = localStorage.getItem(KEY(roomId))
    return raw ? (JSON.parse(raw) as Local) : null
  } catch {
    return null
  }
}

function write(roomId: string, local: Local): void {
  localStorage.setItem(KEY(roomId), JSON.stringify(local))
}

export function dropLocal(roomId: string): void {
  localStorage.removeItem(KEY(roomId))
}

/** 端末の控え。無ければ null（＝通信でしか開けない） */
export function localState(roomId: string): RoomState | null {
  return read(roomId)?.state ?? null
}

export function isDirty(roomId: string): boolean {
  return read(roomId)?.dirty ?? false
}

/** 変更を端末へ確定させる。**通信は待たない** */
export function commitLocal(roomId: string, state: RoomState): void {
  const prev = read(roomId)
  write(roomId, { state, baseStamp: prev?.baseStamp ?? null, dirty: true })
}

/**
 * サーバーから取り込む。
 * 戻り値が 'conflict' の場合、**端末の未送信の変更とサーバーの新しい版が衝突している**。
 * 設計の非スコープに従い、自動マージはしない（利用者に選ばせる）。
 */
export async function pull(s: Session): Promise<'adopted' | 'conflict' | 'unchanged'> {
  const remote = await loadState(s)
  const local = read(s.roomId)
  const stamp = stampOf(remote)

  if (!local) {
    write(s.roomId, { state: remote, baseStamp: stamp, dirty: false })
    return 'adopted'
  }
  if (stamp === local.baseStamp) return 'unchanged'
  if (!local.dirty) {
    write(s.roomId, { state: remote, baseStamp: stamp, dirty: false })
    return 'adopted'
  }
  return 'conflict'
}

/** サーバーへ送る。失敗しても投げない（旅先では失敗が普通なので、例外にしない） */
export async function push(s: Session): Promise<SyncStatus> {
  const local = read(s.roomId)
  if (!local || !local.dirty) return 'synced'
  try {
    await saveState(s, local.state)
    write(s.roomId, { ...local, baseStamp: stampOf(local.state), dirty: false })
    return 'synced'
  } catch {
    return navigator.onLine ? 'pending' : 'offline'
  }
}

/**
 * 版の目印。中身から作るので、サーバーに余分な平文を持たせずに済む。
 * ⚠ 暗号文のサイズと更新頻度は元々サーバーから見えている（設計 §7.5）ので、
 * これによって新しく漏れるものは無い。
 */
function stampOf(state: RoomState): string {
  const s = JSON.stringify(state)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36) + ':' + s.length
}

/** 衝突したときに利用者へ見せる材料 */
export async function conflictSides(s: Session): Promise<{ mine: RoomState; theirs: RoomState }> {
  return { mine: read(s.roomId)!.state, theirs: await loadState(s) }
}

/** 衝突の解決＝どちらかを選ぶ。マージはしない（設計の非スコープ） */
export function resolveKeepMine(roomId: string, state: RoomState): void {
  write(roomId, { state, baseStamp: null, dirty: true })
}

export function resolveTakeTheirs(roomId: string, state: RoomState): void {
  write(roomId, { state, baseStamp: stampOf(state), dirty: false })
}
