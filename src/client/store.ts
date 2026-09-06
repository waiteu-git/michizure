import { loadState, saveState, StaleError, type RoomState, type Session } from './api.ts'
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
  /**
   * 🔴 最後にサーバーで見た**版の番号**。書き込みに必ず添える。
   *
   * 目印（baseStamp）は中身のハッシュで、サーバーは中身を読めないので使えない。
   * サーバーが数える番号だけが「今の版を見ているか」の共通の物差しになる。
   * ⚠ 0 ＝「サーバーをまだ見ていない」（圏外入室の直後など）。この状態で送ると
   * 断られるが、それが正しい——断られてから取り込めば、記録は片方も消えない。
   */
  rev?: number
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
  // ⚠ 版は 0＝まだサーバーを見ていない。最初の送信は断られ、取り込んでから送り直す
  write(roomId, { state, baseStamp: null, base: state, rev: 0, dirty: false })
}

/**
 * サーバーから取ってきた版をそのまま土台にする（入室した直後）。
 * ⚠ 「未送信の変更」にしないこと。取ってきたばかりの物を送り返す理由は無い。
 */
export function adoptRemote(roomId: string, state: RoomState, rev: number): void {
  write(roomId, { state, baseStamp: stampOf(state), base: state, rev, dirty: false })
}

/** 変更を端末へ確定させる。**通信は待たない** */
export function commitLocal(roomId: string, state: RoomState): void {
  const prev = read(roomId)
  write(roomId, {
    state,
    baseStamp: prev?.baseStamp ?? null,
    base: prev?.base ?? null,
    rev: prev?.rev ?? 0,
    dirty: true,
  })
}

/**
 * サーバーから取り込む。
 * 戻り値が 'conflict' の場合、**端末の未送信の変更とサーバーの新しい版が衝突している**。
 * 設計の非スコープに従い、自動マージはしない（利用者に選ばせる）。
 */
export async function pull(s: Session): Promise<'adopted' | 'merged' | 'conflict' | 'unchanged'> {
  const { state: remote, rev } = await loadState(s)
  const local = read(s.roomId)
  const stamp = stampOf(remote)

  if (!local) {
    write(s.roomId, { state: remote, baseStamp: stamp, base: remote, rev, dirty: false })
    return 'adopted'
  }
  if (stamp === local.baseStamp) {
    // ⚠ 中身が同じでも**版は控える**。控えないと、次の送信が古い版で断られ続け、
    // 取り込み直しても同じ所へ戻る（送れないまま無限に往復する）
    write(s.roomId, { ...local, rev })
    return 'unchanged'
  }
  if (!local.dirty) {
    write(s.roomId, { state: remote, baseStamp: stamp, base: remote, rev, dirty: false })
    return 'adopted'
  }
  return mergeInto(s.roomId, local, remote, rev)
}

/**
 * サーバーへ送る。失敗しても投げない（旅先では失敗が普通なので、例外にしない）。
 *
 * 🔴 **断られたら取り込んでから送り直す。押し通さない。**
 * サーバーが先に進んでいたのに上書きすると、相手の記録が黙って消える。
 */
export async function push(s: Session, clientId = '', tries = 2): Promise<SyncStatus> {
  const local = read(s.roomId)
  if (!local || !local.dirty) return 'synced'
  try {
    const rev = await saveState(s, local.state, clientId, local.rev ?? 0)
    // 🔴 送っている**間に足された記録**を巻き戻さない。
    // 以前はここで送信前の控えを丸ごと書き戻していたため、通信中に入力した分が
    // 消えていた（サーバーは受け取っているのに端末から消えるので気づけない）。
    const after = read(s.roomId)!
    const moved = stampOf(after.state) !== stampOf(local.state)
    write(s.roomId, {
      ...after,
      // 送れた＝この版で双方が一致した。次のマージの土台はここ
      baseStamp: stampOf(local.state),
      base: local.state,
      rev,
      dirty: moved,
    })
    return moved ? 'pending' : 'synced'
  } catch (e) {
    if (e instanceof StaleError && tries > 0) {
      let again: Awaited<ReturnType<typeof pull>>
      try {
        again = await pull(s)
      } catch {
        return navigator.onLine ? 'pending' : 'offline'
      }
      // 同じ1件を双方が直していた＝利用者に選ばせる。勝手に決めない
      if (again === 'conflict') return 'conflict'
      return push(s, clientId, tries - 1)
    }
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
export function applyRemote(
  roomId: string,
  remote: RoomState,
  rev: number,
): 'adopted' | 'ahead' | 'merged' | 'conflict' {
  const local = read(roomId)
  const stamp = stampOf(remote)
  if (!local || !local.dirty) {
    write(roomId, { state: remote, baseStamp: stamp, base: remote, rev, dirty: false })
    return 'adopted'
  }

  // 🔴 ここから先は「この端末に未送信の変更がある」状態。**それだけでは衝突ではない。**
  // 以前はここで即 'conflict' を返していたため、**自分が送ったものが返ってきただけで
  // 衝突パネルが出た**（部屋を作った直後に必ず起きる）。`pull()` は同じ判定を
  // 正しく持っていたのに、WebSocket 経路にだけ無かった＝**効くべき面を数え損ねていた**。
  // 2026-09-05、実際に画面を触って発見。

  // ① 中身が同じ＝自分の push が中継されて戻ってきた。送信済みとして扱う
  if (stamp === stampOf(local.state)) {
    write(roomId, { state: local.state, baseStamp: stamp, base: local.state, rev, dirty: false })
    return 'adopted'
  }
  // ② 相手はこちらが編集を始めた版から動いていない＝こちらが先行しているだけ。
  //    取り込むものは無いが、ローカルの変更も捨てない
  //    ⚠ 版だけは控える（中身が同じでもサーバーの番号は進んでいる）
  if (local.baseStamp !== null && stamp === local.baseStamp) {
    write(roomId, { ...local, rev })
    return 'ahead'
  }

  // ③ 双方が別々に動いた。**ここで初めてマージを試みる。**
  //    追加どうしなら黙って併合され、同じ1件を双方が直した時だけ 'conflict' になる
  return mergeInto(roomId, local, remote, rev)
}

/** 衝突したときに利用者へ見せる材料 */
export async function conflictSides(
  s: Session,
): Promise<{ mine: RoomState; theirs: RoomState; rev: number }> {
  const { state: theirs, rev } = await loadState(s)
  return { mine: read(s.roomId)!.state, theirs, rev }
}

/**
 * 衝突の解決＝どちらかを選ぶ。マージはしない（設計の非スコープ）。
 * ⚠ どちらを選んでも**見た版の番号を控える**。控えないと、選んだ結果を
 * サーバーへ送れない（古い版として断られ続ける）。
 */
export function resolveKeepMine(roomId: string, state: RoomState, rev: number): void {
  // ⚠ 土台は残す。共通の祖先は「自分が選んだ版」ではない
  write(roomId, { state, baseStamp: null, base: read(roomId)?.base ?? null, rev, dirty: true })
}

export function resolveTakeTheirs(roomId: string, state: RoomState, rev: number): void {
  write(roomId, { state, baseStamp: stampOf(state), base: state, rev, dirty: false })
}

/**
 * 土台があればマージする。無ければ従来どおり丸ごと選ばせる。
 *
 * ⚠ マージが成立した後の土台は**相手の版**にする。相手の版はマージ結果の
 * 祖先であり、次に比べるべき共通点はそこだから。
 *
 * 🔴 **その版の目印も残す。** 電波が戻ると、サーバーの版は WebSocket の `init` と
 * HTTP の `pull` の**両方から届く**（どちらが先かは決まっていない）。目印を空に
 * していると、二度目も「初めて見た版」として扱われて**同じマージが二度走り、
 * 「相手の記録と合わせました」が二度出る**。目印を残せば二度目は 'ahead' /
 * 'unchanged' に落ちる＝取り込むものは無く、送るだけ。
 * ⚠ これは便宜ではない。マージした時点で相手の版は**実際に見ている**。
 */
function mergeInto(
  roomId: string,
  local: Local,
  remote: RoomState,
  rev: number,
): 'merged' | 'conflict' {
  if (!local.base) return 'conflict'
  const { state, conflicts } = merge3(local.base, local.state, remote)
  if (conflicts.length) {
    pendingConflicts = conflicts
    return 'conflict'
  }
  pendingConflicts = []
  write(roomId, { state, baseStamp: stampOf(remote), base: remote, rev, dirty: true })
  return 'merged'
}

/** 直前のマージで解けなかった予約。呼び出し側が利用者へ出す */
let pendingConflicts: BookingConflict[] = []
export function takePendingConflicts(): BookingConflict[] {
  return pendingConflicts
}
