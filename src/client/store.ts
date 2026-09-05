import { loadState, saveState, type RoomState, type Session } from './api.ts'
import { merge3, type BookingConflict } from './merge.ts'

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
  /**
   * 🔴 最後に双方が一致していた版**そのもの**。3方向マージの土台。
   *
   * 目印（ハッシュ）だけでは「誰が何を変えたか」が決まらない＝マージできない。
   * ⚠ 無い時（古い端末の控え・初回）は**マージしない**。土台を捏造すると、
   * 相手の変更を自分の追加として扱うような、静かに間違った併合が起きる。
   */
  base?: RoomState | null
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

/**
 * 圏外入室の直後に、土台として置く（設計 §9.1）。
 *
 * ⚠ 渡すのは**空の部屋**。それが入った人にとっての真の共通祖先だから、
 * 電波が戻った時の3方向マージで双方の追加が全部残る。
 * ⚠ `dirty: false` で置くこと。まだ何も変えていないのに送ろうとすると、
 * 相手の記録を空で上書きする。
 */
export function adoptAsBase(roomId: string, state: RoomState): void {
  write(roomId, { state, baseStamp: null, base: state, dirty: false })
}

/** 変更を端末へ確定させる。**通信は待たない** */
export function commitLocal(roomId: string, state: RoomState): void {
  const prev = read(roomId)
  write(roomId, { state, baseStamp: prev?.baseStamp ?? null, base: prev?.base ?? null, dirty: true })
}

/**
 * サーバーから取り込む。
 * 戻り値が 'conflict' の場合、**端末の未送信の変更とサーバーの新しい版が衝突している**。
 * 設計の非スコープに従い、自動マージはしない（利用者に選ばせる）。
 */
export async function pull(s: Session): Promise<'adopted' | 'merged' | 'conflict' | 'unchanged'> {
  const remote = await loadState(s)
  const local = read(s.roomId)
  const stamp = stampOf(remote)

  if (!local) {
    write(s.roomId, { state: remote, baseStamp: stamp, base: remote, dirty: false })
    return 'adopted'
  }
  if (stamp === local.baseStamp) return 'unchanged'
  if (!local.dirty) {
    write(s.roomId, { state: remote, baseStamp: stamp, base: remote, dirty: false })
    return 'adopted'
  }
  return mergeInto(s.roomId, local, remote)
}

/** サーバーへ送る。失敗しても投げない（旅先では失敗が普通なので、例外にしない） */
export async function push(s: Session, clientId = ''): Promise<SyncStatus> {
  const local = read(s.roomId)
  if (!local || !local.dirty) return 'synced'
  try {
    await saveState(s, local.state, clientId)
    // 送れた＝この版で双方が一致した。次のマージの土台はここ
    write(s.roomId, { ...local, baseStamp: stampOf(local.state), base: local.state, dirty: false })
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

/**
 * 外（他の端末）から届いた状態を取り込む。
 * ⚠ **この端末に未送信の変更がある時は取り込まない**＝黙って上書きすると
 * 入力が理由も分からず消える。呼び出し側で衝突として扱う
 */
export function applyRemote(roomId: string, remote: RoomState): 'adopted' | 'ahead' | 'merged' | 'conflict' {
  const local = read(roomId)
  const stamp = stampOf(remote)
  if (!local || !local.dirty) {
    write(roomId, { state: remote, baseStamp: stamp, base: remote, dirty: false })
    return 'adopted'
  }

  // 🔴 ここから先は「この端末に未送信の変更がある」状態。**それだけでは衝突ではない。**
  // 以前はここで即 'conflict' を返していたため、**自分が送ったものが返ってきただけで
  // 衝突パネルが出た**（部屋を作った直後に必ず起きる）。`pull()` は同じ判定を
  // 正しく持っていたのに、WebSocket 経路にだけ無かった＝**効くべき面を数え損ねていた**。
  // 2026-09-05、実際に画面を触って発見。

  // ① 中身が同じ＝自分の push が中継されて戻ってきた。送信済みとして扱う
  if (stamp === stampOf(local.state)) {
    write(roomId, { state: local.state, baseStamp: stamp, base: local.state, dirty: false })
    return 'adopted'
  }
  // ② 相手はこちらが編集を始めた版から動いていない＝こちらが先行しているだけ。
  //    取り込むものは無いが、ローカルの変更も捨てない
  if (local.baseStamp !== null && stamp === local.baseStamp) return 'ahead'

  // ③ 双方が別々に動いた。**ここで初めてマージを試みる。**
  //    追加どうしなら黙って併合され、同じ1件を双方が直した時だけ 'conflict' になる
  return mergeInto(roomId, local, remote)
}

/** 衝突したときに利用者へ見せる材料 */
export async function conflictSides(s: Session): Promise<{ mine: RoomState; theirs: RoomState }> {
  return { mine: read(s.roomId)!.state, theirs: await loadState(s) }
}

/** 衝突の解決＝どちらかを選ぶ。マージはしない（設計の非スコープ） */
export function resolveKeepMine(roomId: string, state: RoomState): void {
  // ⚠ 土台は残す。共通の祖先は「自分が選んだ版」ではない
  write(roomId, { state, baseStamp: null, base: read(roomId)?.base ?? null, dirty: true })
}

export function resolveTakeTheirs(roomId: string, state: RoomState): void {
  write(roomId, { state, baseStamp: stampOf(state), base: state, dirty: false })
}

/**
 * 土台があればマージする。無ければ従来どおり丸ごと選ばせる。
 *
 * ⚠ マージが成立した後の土台は**相手の版**にする。相手の版はマージ結果の
 * 祖先であり、次に比べるべき共通点はそこだから。
 */
function mergeInto(roomId: string, local: Local, remote: RoomState): 'merged' | 'conflict' {
  if (!local.base) return 'conflict'
  const { state, conflicts } = merge3(local.base, local.state, remote)
  if (conflicts.length) {
    pendingConflicts = conflicts
    return 'conflict'
  }
  pendingConflicts = []
  write(roomId, { state, baseStamp: null, base: remote, dirty: true })
  return 'merged'
}

/** 直前のマージで解けなかった予約。呼び出し側が利用者へ出す */
let pendingConflicts: BookingConflict[] = []
export function takePendingConflicts(): BookingConflict[] {
  return pendingConflicts
}
