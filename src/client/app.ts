import {
  RoomGoneError,
  TokenRejectedError,
  createRoom,
  enterRoom,
  loadState,
  saveState,
  roomEntry,
  emptyState,
  type RoomState,
  type Booking,
  type Session,
} from './api.ts'
import {
  remember,
  remembered,
  rememberedAll,
  rememberedEntry,
  rememberEntry,
  forget,
} from './session-store.ts'
import { balances, advanced, settle, parts, isDone, shareSummary } from './settle.ts'
import type { BookingConflict } from './merge.ts'
import { connectLive, disconnectLive, clientId } from './live.ts'
import { shareOrigin, initOrigins, billingKeys } from './origins.ts'
import { getApiBase } from './config.ts'
import { entryFromHash, entryForRoom, entryUrl, emptyRoomForEntry } from './entry.ts'
import { PBKDF2_ITERATIONS, deriveKeys } from '../keys.ts'
import { KDF_VERSION } from '../types.ts'
import {
  applyRemote,
  commitLocal,
  adoptRemote,
  localState,
  takePendingConflicts,
  adoptAsBase,
  isDirty,
  pull,
  push,
  dropLocal,
  conflictSides,
  resolveKeepMine,
  resolveBookings,
  markForgotten,
  revive,
  resolveTakeTheirs,
  type SyncStatus,
} from './store.ts'

// ⚠ 単語リスト（約7KB）は【部屋を作る時にしか要らない】ので、その時に取りに行く。
// 最初の読み込みに含めると、入室しかしない人にも運ばせることになる
/**
 * 🔴 **遅延読み込みは失敗しうる。失敗を握り潰さないこと。**
 *
 * 2026-09-06、iOS のシェルで「作る」を押しても**何も起きず、通知も出ない**状態を
 * 実際に踏んだ。原因は遅延 chunk の読み込み失敗で、それが try の外にあったため
 * 例外が誰にも拾われなかった。**画面は正常に見えるのにボタンが死んでいる**という、
 * 一番気づきにくい壊れ方になる。
 *
 * ⇒ 遅延読み込みは必ずここを通し、失敗したら利用者に見える形で言う。
 */
async function lazy<T>(load: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await load()
  } catch (e) {
    toast(`${what}を読み込めませんでした（電波が戻ってから試してください）`)
    console.error(`遅延読み込みに失敗: ${what}`, e)
    return null
  }
}

const passphraseModule = () => import('./passphrase.ts')
// 取り込みも、使う人だけが運べばよい
const importModule = () => import('./import.ts')
// QR は「QRを出す」を押した人だけが運ぶ（ライブラリが 7.6KB あるため）
const qrModule = () => import('./qr.ts')
// CSV書き出し（有料機能）は、押した人だけが運ぶ。billing はネイティブブリッジを
// 抱える @capacitor/core を引き込むため、特に Web 配信の初回読み込みに含めたくない
const billingModule = () => import('./billing.ts')
const exportShareModule = () => import('./export-share.ts')

/** 取り込んだ状態を一時的に持つ。「作る」を押した時に部屋の中身になる */
let pendingImport: RoomState | null = null

initOrigins()

/**
 * 🔴 アプリ本体をオフラインでも開けるようにする。
 *
 * これが無いと「電波が無くても動く」は**半分しか本当でない**＝入力した記録は
 * localStorage に残るが、**リロードするとアプリ自体が読み込めない**。
 * 旅先で圏外のままブラウザを閉じて開き直す、という一番ありそうな操作で詰む。
 * （2026-09-05 の監査で発見。README のデモ手順が実在しない機能を書いていた）
 *
 * ⚠ 失敗しても握り潰す。Service Worker が使えない環境（古い WebView・
 * 非セキュアコンテキスト）でアプリ本体が起動しなくなる方が悪い。
 */
/**
 * ⚠ **ネイティブのシェルの中では登録しない。**
 *
 * シェルは端末内のファイルを読むので、キャッシュする理由がそもそも無い。
 * それだけなら無害だが、登録すると**アプリを更新しても SW が古い資産を
 * 返し続ける**（Capacitor でよく踏まれる形）。画面は出るので気づきにくい。
 *
 * 判定に @capacitor/core を import しない＝そのぶんの配信量を増やさない。
 * シェルが注入する `window.Capacitor` の有無だけを見る。
 */
const inNativeShell = 'Capacitor' in window || location.protocol === 'capacitor:'
if ('serviceWorker' in navigator && !inNativeShell) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

const $ = (id: string) => document.getElementById(id)!
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

let session: Session | null = null
let state: RoomState | null = null
/** 追加フォームで選択中の対象者。null = まだ触っていない＝全員 */
let formParts: string[] | null = null
/** 修正中の記録のID。null = 新規追加 */
let editingId: string | null = null

/**
 * 🔴 これから作る記録の id を、保存の時ではなく**今この場で**確保しておく。
 *
 * 端数の1円を誰が負うかは予約IDから決まる（settle.ts の sharesOf）。
 * 保存時に採番すると、**入力中に見せた「1円は たなか」と、保存後のカードの担い手が違う**
 * ものになる。見せた通りに保存されないのは、金額を扱う画面では最悪の部類。
 */
let draftId = crypto.randomUUID()

/** 直近に作った部屋の入口券（QR に載せるもの）。中身は含まない */
let entry: { roomId: string; salt: string; iterations: number; kdfVersion: number } | null = null

/** メンバーIDから名前。見つからない時は '?'（消されたメンバーを参照しても壊れない） */
function nameOfMember(id: string): string {
  return state?.members.find((m) => m.id === id)?.name ?? '?'
}

function toast(msg: string) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('on')
  setTimeout(() => t.classList.remove('on'), 2600)
}

function show(screen: 'home' | 'created' | 'join' | 'room') {
  for (const id of ['home', 'created', 'join', 'room']) {
    $(id).hidden = id !== screen
  }
}

// ---------- 入口 ----------

/**
 * API に届くかを一度だけ確かめる（シェル向け）。
 *
 * 🔴 シェルは別オリジンで動くので、宛先か CORS が噛み合わないと
 * **画面は出るのに部屋が作れない**。原因が「通信」だと分からないまま
 * 「アプリが壊れている」に見える。届かない時だけ、理由を名指しで出す。
 *
 * ⚠ Web 配信（宛先が空＝相対パス）では何もしない。同一オリジンで起きない問題だし、
 * 起動のたびに1リクエスト増やす理由も無い。
 */
async function checkApiReachable() {
  if (!getApiBase()) return
  const box = $('apiWarn')
  try {
    const res = await fetch(`${getApiBase()}/api/health`)
    if (res.ok) return
    box.textContent = `サーバーが ${res.status} を返しました（${getApiBase()}）。`
  } catch {
    // ⚠ CORS で落ちた場合も fetch は同じ例外になる＝ここでは区別できない。
    // 区別できないことを、区別できるかのように書かない
    box.textContent =
      `サーバーに届きません（${getApiBase()}）。` +
      '通信が無いか、このアプリの出所が許可されていない可能性があります。'
  }
  box.hidden = false
}

function renderHome() {
  const rooms = rememberedAll()
  $('remembered').innerHTML = rooms.length
    ? `<h2>この端末で開ける旅行</h2>` +
      rooms
        .map(
          (r) =>
            `<div class="row"><button class="link" data-open="${esc(r.roomId)}">${esc(r.name) || '(名前なし)'}</button>
             <button class="ghost" data-forget="${esc(r.roomId)}">この端末から消す</button></div>`,
        )
        .join('')
    : ''
  show('home')
}

async function doCreate() {
  const name = ($('newName') as HTMLInputElement).value.trim()
  if (!name) return toast('旅行の名前を入れてください')
  const custom = ($('customPass') as HTMLInputElement).value.trim()
  const mod = await lazy(passphraseModule, '合言葉の生成')
  if (!mod) return
  const { generatePassphrase, customPassphraseTooWeak, estimateBits } = mod
  if (custom && customPassphraseTooWeak(custom)) {
    return toast(`合言葉が弱すぎます（推定 ${estimateBits(custom)} ビット）`)
  }
  const passphrase = custom || generatePassphrase()

  $('createBtn').setAttribute('disabled', '')
  toast('鍵を作っています…')
  try {
    const initial = pendingImport ? { ...pendingImport, name } : emptyState(name)
    const s = await createRoom(passphrase, initial)
    session = { roomId: s.roomId, token: s.token, encKeyBits: s.encKeyBits }
    state = initial
    pendingImport = null
    // ⚠ 入口の材料も一緒に控える。控えないと、後から人を招く時に毎回
    // サーバーへ取りに行くことになり、**圏外では招けない**（設計 §9.1）
    remember(session, name, {
      salt: s.salt,
      iterations: PBKDF2_ITERATIONS,
      kdfVersion: KDF_VERSION,
    })
    // 🔴 `commitLocal` を使ってはいけない。あれは base=null / rev=0 / dirty=true を書くので、
    // **作った本人の最初の送信が必ず 409 になり、土台が無いのでマージもできず永久に詰む**
    // （2026-09-07 のレビューで発見。サーバーは create の時点で既に版1を持っている）
    adoptRemote(s.roomId, state, s.rev)
    ;($('shownPass') as HTMLElement).textContent = passphrase
    ;($('shownUrl') as HTMLElement).textContent = `${shareOrigin()}/r/${s.roomId}`
    // 圏外入室券（設計 §9.1）。中身は載せない＝QR が小さく、実機で読める
    entry = { roomId: s.roomId, salt: s.salt, iterations: PBKDF2_ITERATIONS, kdfVersion: KDF_VERSION }
    $('qr').hidden = true
    $('qrHint').hidden = true
    $('showQr').textContent = 'QRを出す'
    show('created')
  } catch (e) {
    toast(`作成に失敗しました: ${e instanceof Error ? e.message : e}`)
  } finally {
    $('createBtn').removeAttribute('disabled')
  }
}

async function doJoin() {
  const roomId = ($('joinRoom') as HTMLInputElement).value.trim().toUpperCase()
  const pass = ($('joinPass') as HTMLInputElement).value
  if (!/^[0-9A-Z]{16}$/.test(roomId)) return toast('部屋のIDが正しくありません')
  // ⚠ 本人が合言葉で入り直す＝明示の操作。「この端末から消す」の印を解く。
  // 解かないと、消した部屋に入り直した時に**書き込みが黙って全部捨てられる**
  revive(roomId)
  goneRooms.delete(roomId)
  expiredRooms.delete(roomId)
  $('joinBtn').setAttribute('disabled', '')
  toast('合言葉から鍵を作っています…')
  try {
    const entered = await enterRoom(roomId, pass)
    session = entered.session
    // 🔴 端末に控えがあるなら**上書きしない**。圏外入室（§9.1）で入った端末は
    // すでに自分の記録を持っている＝ここで loadState を書き込むと、
    // 圏外で足した記録が黙って消える。pull は3方向マージを通す
    if (localState(roomId)) {
      const r = await pull(session)
      state = localState(roomId)
      remember(session, state?.name ?? '', entered.entry)
      // 🔴 **衝突の時も、先に部屋を出す。** 衝突パネルと状態の帯は部屋の画面の中にある。
      // 以前は部屋を出さずに showConflict へ進んだので、画面は「合言葉で入る」のまま変わらず、
      // 選ぶ手段が見えなかった（2026-09-11 の多観点照合で発見）。期限切れや圏外入室の後の
      // 入り直しは、まさに端末とサーバーの双方が同じ1件を直している場面になりうる
      if (r === 'conflict') {
        renderRoom()
        return showConflict(session)
      }
      if (r === 'merged') toast('相手の記録と合わせました')
      renderSync(isDirty(roomId) ? 'pending' : 'synced')
      renderRoom()
      if (isDirty(roomId)) void push(session, clientId).then(afterPush(session))
    } else {
      const loaded = await loadState(session)
      state = loaded.state
      remember(session, state.name, entered.entry)
      // ⚠ 取ってきたばかりの版を「未送信の変更」にしない。
      // 版の番号もここで控える（控えないと最初の送信が必ず断られる）
      adoptRemote(roomId, state, loaded.rev)
      renderSync('synced')
      renderRoom()
    }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    // 🔴 つながらない時は、入口券があれば圏外で入る（設計 §9.1）。
    // ⚠ 合言葉が違う・部屋が無いといった**サーバーが答えを返した**場合には
    // 落ちてはいけない。それは通信できているので、正しい理由を伝えるべき場面
    const answered =
      msg.includes('invalid_key') || msg.includes('too_many_attempts') || msg.includes('not_found')
    if (!answered && (await offlineJoin(roomId, pass))) {
      $('joinBtn').removeAttribute('disabled')
      return
    }
    // 通信の失敗で入れなかったが、この端末には控えがある＝記録は無事だと伝える
    if (!answered && localState(roomId)) {
      return toast('つながりませんでした。この端末の記録はそのまま残っています。電波のある所でもう一度入ってください')
    }
    toast(
      msg.includes('invalid_key')
        ? '合言葉が違います'
        : msg.includes('too_many_attempts')
          ? '失敗が続いたため、しばらく入室できません'
          : msg.includes('not_found')
            ? 'その部屋は見つかりません（削除された可能性があります）'
            : `入室に失敗しました: ${msg}`,
    )
  } finally {
    $('joinBtn').removeAttribute('disabled')
  }
}

/** 端末の控えを先に見せ、通信はその後ろで行う（電波が無くても開ける） */
async function openRemembered(roomId: string) {
  const s = remembered(roomId)
  if (!s) return toast('この端末には保存されていません')
  revive(roomId) // 一覧から開いた＝明示の操作（別タブで入り直した部屋を、このタブで開く場合）

  // 🔴 圏外入室（§9.1）で入った部屋は**トークンを持たない**（authKey を端末に
  // 保存しない設計）。電波が戻ったら一度だけ合言葉を聞いて、正式に入室する。
  // ⚠ 中身は端末に在るので、聞くまでの間も見られるし、記録も足せる。
  if (!s.token) {
    session = s
    const cachedNow = localState(roomId)
    if (cachedNow) {
      state = cachedNow
      renderRoom()
      renderSync(navigator.onLine ? 'pending' : 'offline')
    }
    if (navigator.onLine) {
      ;($('joinRoom') as HTMLInputElement).value = roomId
      $('offlineHint').hidden = true
      $('expiredHint').hidden = true
      $('rejoinHint').hidden = false
      show('join')
    }
    return
  }

  session = s

  const cached = localState(roomId)
  if (cached) {
    state = cached
    renderRoom()
    renderSync(isDirty(roomId) ? 'pending' : 'synced')
  }

  try {
    await resync(s)
  } catch {
    if (!cached) {
      toast('つながりません。合言葉で入り直してください')
      ;($('joinRoom') as HTMLInputElement).value = roomId
      show('join')
    } else {
      renderSync(navigator.onLine ? 'pending' : 'offline')
    }
  }
}

/**
 * 端末とサーバーを突き合わせる。**取り込んでから送る**——順序を逆にすると、
 * まだ見ていない相手の版を自分の版で上書きする。
 *
 * ⚠ 通信の失敗は投げる。**どう見せるかは呼び出し側で違う**（部屋を開いた時は
 * 入り直しを促すが、電波が戻った時はその場で「未同期」に戻すだけでよい）。
 */
async function resync(s: Session): Promise<void> {
  if (goneRooms.has(s.roomId)) return onRoomGone(s)
  if (expiredRooms.has(s.roomId)) return onTokenRejected(s)
  let result: Awaited<ReturnType<typeof pull>>
  try {
    result = await pull(s)
  } catch (e) {
    if (e instanceof RoomGoneError) return onRoomGone(s)
    if (e instanceof TokenRejectedError) return onTokenRejected(s)
    throw e
  }
  if (result === 'conflict') return showConflict(s)
  /**
   * 🔴 **pull の間に、別の部屋を開いた／合言葉で入り直したかもしれない。**
   *
   * このチェックの前は、画面復帰・接続失敗（C25）のたびに走る resync が、通信の遅れた
   * 応答を**今見ている部屋の画面**へそのまま描いていた。その状態で記録を1件足すと、
   * 今の部屋の控えとサーバーが、別の部屋の中身（他の参加者の名前や記録を含む）に
   * 置き換わる＝**部屋を跨いだ開示**になる（2026-09-11 の多観点レビューで発見・
   * DOM を差し替えた Node 上で再現した）。
   * ⚠ **`push` はここでは止めない。** ローカルの控えは `roomId` ごとに独立しており、
   * 今表示している部屋とは関係なく、s の部屋のサーバーへ届けるのが正しい（送らないと、
   * 取り込んだ内容が次のマージの土台に反映されない）。危ないのは**画面**の側だけ。
   */
  if (session === s) {
    if (result === 'merged') toast('相手の記録と合わせました')
    state = localState(s.roomId)
    renderRoom()
    renderSync(isDirty(s.roomId) ? 'pending' : 'synced')
  }
  if (isDirty(s.roomId)) void push(s, clientId).then(afterPush(s))
}

/**
 * 衝突＝自動でマージしない（設計の非スコープ）。**どちらを残すかは利用者が決める。**
 * 黙って上書きすると、片方の入力が理由も分からず消える
 */
/**
 * 🔴 **ボタンを押した時点の中身で決める。表示した時点のものを握らない。**
 *
 * 以前はパネルを描いた瞬間の状態をクロージャに閉じ込めていた。パネルは押されるまで
 * 消えず、その間も入力できるので、**押した瞬間にその後の入力が丸ごと消えた**
 * （2026-09-05、実際に画面で踏んだ。記録4件が消える状態だった）。
 * 表示している件数も止まったままで、利用者は何を捨てるのか判断できなかった。
 */
/**
 * 旅の途中で人を招く。**部屋の中から入口の QR を出す。**
 *
 * 作った直後の画面には券の材料が残っているが、そこを離れると消える。
 * 実際の旅では「宿に着いてから B さんも入れる」ほうが普通なので、
 * ここから出せないと機能が使い物にならない（2026-09-06 に気づいた設計漏れ）。
 *
 * ⚠ salt はサーバーから取り直す（`/salt` は認証不要）。**通信が要る**＝
 * 圏外では招けない。招くのは宿など電波のある場所を想定している。
 */
async function toggleInviteQr() {
  const box = $('qrRoom')
  if (!box.hidden) {
    box.hidden = true
    $('qrRoomHint').hidden = true
    $('inviteBtn').textContent = 'この旅行に招く（QR）'
    return
  }
  if (!session) return
  const qr = await lazy(qrModule, 'QR の描画')
  if (!qr) return
  /**
   * 🔴 **まず手元を見る。** 以前はここで必ずサーバーへ取りに行っていたので、
   * **圏外では人を招けなかった**——「招かれた人は電波なしで入れる」のに
   * 「招く側は電波が要る」という裏返し。宿に着いてから誰かを招く場面は、
   * だいたい電波が悪い（2026-09-06、ユーザーが実機で踏んだ）。
   *
   * ⚠ 材料は秘密ではない（`/salt` は認証なしで誰にでも返る）。控えても漏れは増えない。
   */
  let e = rememberedEntry(session.roomId)
  if (!e) {
    // この端末の控えが古い（材料を持たない世代）＝一度だけ取りに行き、次から手元で済ませる
    try {
      e = await roomEntry(session.roomId)
      rememberEntry(session.roomId, e)
    } catch {
      return toast('入口の情報がこの端末にありません。一度、電波のある場所で開いてください')
    }
  }
  const url = entryUrl(shareOrigin(), session.roomId, e)
  const { svg, modules } = qr.qrSvg(url)
  box.innerHTML = svg
  box.dataset.url = url
  box.hidden = false
  $('qrRoomHint').hidden = false
  $('inviteBtn').textContent = 'QRをしまう'
  if (modules > 85) console.warn(`QR が密です（${modules} モジュール）`)
}

/**
 * 入口の QR を出す・しまう。
 *
 * ⚠ 載せるのは入口（版・反復回数・salt）だけで、**部屋の中身は載せない**。
 * 中身まで載せると 6人3件の部屋で101モジュールになり、他端末の画面越しには
 * 読めなくなる（実測・設計 §9.1）。入口だけなら37モジュール。
 */
async function toggleQr() {
  const box = $('qr')
  if (!box.hidden) {
    box.hidden = true
    $('qrHint').hidden = true
    $('showQr').textContent = 'QRを出す'
    return
  }
  if (!entry) return
  const qr = await lazy(qrModule, 'QR の描画')
  if (!qr) return
  const { qrSvg } = qr
  const url = entryUrl(shareOrigin(), entry.roomId, entry)
  const { svg, modules } = qrSvg(url)
  box.innerHTML = svg
  // カメラで読めない相手には、この URL を送って渡す（合言葉は別経路のまま）
  box.dataset.url = url
  box.hidden = false
  $('qrHint').hidden = false
  $('showQr').textContent = 'QRをしまう'
  // ⚠ 密度は端末で読めるかを左右する。開発中に気づけるよう残す
  if (modules > 85) console.warn(`QR が密です（${modules} モジュール）`)
}

/**
 * 同じ1件を双方が別々に直した時だけ出す。**1件ずつ選ばせる。**
 *
 * ⚠ 以前は「この端末（3人・記録5件）／他の端末（…）選ばなかったほうは消えます」と、
 * 数だけを見せて一晩ぶんの記録を捨てさせていた。件数は中身の代わりにならない。
 */
function showBookingConflicts(s: import('./api.ts').Session, list: BookingConflict[]) {
  const nameOf = (id: string) => state?.members.find((m) => m.id === id)?.name ?? '?'
  const show = (b: Booking | null) =>
    b
      ? `${esc(b.category)} ${esc(b.description)} ${yen(b.amount)}円<br>
         <span class="muted">${esc(nameOf(b.payer))} が立替 ／ ${b.participants.length}人で割る</span>`
      : '<span class="muted">（消された）</span>'

  $('conflict').innerHTML =
    `<div class="warn"><b>同じ記録を、両方の端末で別々に直しました。</b>
       ${list.length}件あります。1件ずつ選んでください。</div>` +
    list
      .map(
        (c, i) => `<div class="card">
        <div class="row"><div>${show(c.mine)}</div>
          <button data-cf="mine" data-i="${i}">この端末を残す</button></div>
        <div class="row"><div>${show(c.theirs)}</div>
          <button class="ghost" data-cf="theirs" data-i="${i}">他の端末を残す</button></div>
      </div>`,
      )
      .join('')
  $('conflict').hidden = false

  const chosen = new Map<number, Booking | null>()
  $('conflict').onclick = (e) => {
    const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!el?.dataset.cf) return
    const i = Number(el.dataset.i)
    chosen.set(i, el.dataset.cf === 'mine' ? list[i].mine : list[i].theirs)
    el.closest('.card')?.classList.add('done')
    if (chosen.size < list.length) return

    // 全部選び終えた。選ばれた版を今のローカルへ入れて送る
    const local = localState(s.roomId)
    if (!local) return
    for (const [i, b] of chosen) {
      const id = (list[i].mine ?? list[i].theirs)!.id
      const at = local.bookings.findIndex((x) => x.id === id)
      if (b === null) { if (at >= 0) local.bookings.splice(at, 1) }
      else if (at >= 0) local.bookings[at] = b
      else local.bookings.push(b)
    }
    // ⚠ `resolveKeepMine` を使ってはいけない。あれは「今サーバーにある版」を名乗るので、
    // **取り込んでいない相手の記録まで上書きして消す**（2026-09-07 のレビューで実測）。
    // 件別の解決はマージ済みの上に載るので、控えてある版のままでよい
    resolveBookings(s.roomId, local)
    state = local
    $('conflict').hidden = true
    renderRoom()
    void push(s, clientId).then(afterPush(s))
  }
}

async function showConflict(s: import('./api.ts').Session) {
  // 🔴 **呼ばれた時点で、もう別の部屋・別のセッションを見ているかもしれない。**
  // 呼び出し元（resync・afterPush）は通信を挟むので、その間に「入口に戻る」→別の部屋を開く／
  // 合言葉で入り直す、が起きうる。ここで進めると、**今見ている部屋の画面に、別の部屋の
  // 衝突パネルが出る**（2026-09-11 の多観点レビューで発見）。呼び出し元でチェックせず、
  // ここに置く＝どの経路から呼ばれても一度だけ確かめれば足りる。
  if (session !== s) return
  renderSync('conflict')

  // 🔴 件単位で解けた分は既にマージ済み。ここへ来るのは
  // **同じ1件を双方が別々に直した**時だけ。丸ごと選ばせるのは土台が無い時に限る。
  // 🔴 **件別の衝突は通信せずに出す。** マージは既にローカルで済んでおり、版も控えてある。
  // ここで通信を挟むと、電波が切れた瞬間に起きた衝突の解決手段が画面に出ない
  // （2026-09-07 のレビューで指摘。まさに圏外で起きる衝突を解けなくしていた）。
  const perBooking = takePendingConflicts(s.roomId)
  if (perBooking.length) return showBookingConflicts(s, perBooking)

  // 丸ごと選ぶ経路（土台が無い時）だけは、相手の版を取りに行く必要がある
  const count = (x: RoomState) => `${x.members.length}人・記録${x.bookings.length}件`
  const sides = await conflictSides(s)
  $('conflict').innerHTML = `
    <div class="warn">
      <b>この端末の変更と、他の端末の変更が食い違っています。</b>
      どちらを残すか選んでください。<b>選ばなかったほうは消えます。</b>
    </div>
    <div class="row"><span>この端末（${count(sides.mine)}）</span>
      <button id="keepMine">こちらを残す</button></div>
    <div class="row"><span>他の端末（${count(sides.theirs)}）</span>
      <button class="ghost" id="takeTheirs">こちらを残す</button></div>`
  $('conflict').hidden = false
  $('keepMine').onclick = () => {
    // 押した時点のローカル＝パネルを見ている間に足した記録も残る
    const mine = localState(s.roomId)
    if (!mine) return
    resolveKeepMine(s.roomId, mine, sides.rev)
    state = mine
    $('conflict').hidden = true
    renderRoom()
    void push(s, clientId).then(afterPush(s))
  }
  $('takeTheirs').onclick = async () => {
    // 押した時点のサーバー側を取り直す。表示していた版はもう古いかもしれない
    let now: Awaited<ReturnType<typeof conflictSides>>
    try {
      now = await conflictSides(s)
    } catch {
      return toast('つながりません。もう一度試してください')
    }
    const theirs = now.theirs
    resolveTakeTheirs(s.roomId, theirs, now.rev)
    state = theirs
    $('conflict').hidden = true
    renderRoom()
    renderSync('synced')
  }
}

/**
 * 前のアプリから書き出したファイルを読み込む。
 * ⚠ **前のアプリには触れない**＝利用者がエクスポートしたファイルだけを読む。
 * ⚠ 読み込んだ時点では作らない。**何が入るかを見せてから**作らせる
 */
async function handleImportFile(file: File) {
  // 利用者のファイル＝壊れている前提で読む。大きすぎるものは開かない
  if (file.size > 5 * 1024 * 1024) return toast('ファイルが大きすぎます')
  try {
    const raw = JSON.parse(await file.text())
    const { convertLegacy } = await importModule()
    const name = ($('newName') as HTMLInputElement).value.trim() || '取り込んだ旅行'
    const { state: imported, notes } = convertLegacy(raw, name)
    pendingImport = imported
    $('importInfo').innerHTML =
      `<div class="warn"><b>${imported.members.length}人・記録${imported.bookings.length}件</b>を読み込みました。` +
      `「作る」を押すと、この内容で新しい旅行ができます。` +
      (notes.length ? `<br>${notes.map(esc).join('<br>')}` : '') +
      `</div>`
  } catch (e) {
    pendingImport = null
    $('importInfo').innerHTML = ''
    toast(`読み込めませんでした: ${e instanceof Error ? e.message : e}`)
  }
}

// ---------- 部屋 ----------

/** 同じ部屋を開いている端末からの変更を受け取る */
function startLive() {
  if (!session) return
  // 🔴 圏外入室（設計 §9.1）で入った部屋は token を持たない。繋ごうとしても
  // サーバーは必ず断るので、**成功しようのない再接続が延々と回り続ける**
  // （電池と通信量を使い切る。2026-09-07 のレビューで発見）。
  // 正式に入り直すと token が入り、その時の renderRoom で繋がる。
  if (!session.token) return
  const s = session
  if (goneRooms.has(s.roomId)) return
  if (expiredRooms.has(s.roomId)) return
  connectLive(s, {
    onGone: () => onRoomGone(s),
    onExpired: () => onTokenRejected(s),
    // 繋がらない理由（圏外・トークン切れ・削除済み）は WebSocket では分からない＝HTTP で確かめる
    onUnreachable: () => void resync(s).catch(() => renderSync(isDirty(s.roomId) ? 'pending' : 'offline')),
    onStatus: (connected) => {
      $('live').textContent = connected ? '他の端末とつながっています' : ''
    },
    onUpdate: async (blob, rev) => {
      try {
        const { decryptBlob } = await import('./api.ts')
        const remote = await decryptBlob(s, blob)
        // ⚠ 未送信の変更がある時は取り込まない。黙って上書きすると入力が消える
        const result = applyRemote(s.roomId, remote, rev)
        // 'stale' ＝手元より古い版。送り終えた後に届いた送る前の版か、版が本当に戻ったか
        // （運営者の時点復元）のどちらか。**ここでは見分けられないので、取り込み直して決める**
        // （前者なら何も変わらず、後者なら戻った版を取り込む）。
        // ⚠ 下の「保存済み」へ落とさないこと。未送信が残っていても保存済みと出てしまう
        if (result === 'stale') return void resync(s).catch(() => {})
        if (result === 'conflict') return void showConflict(s)
        // 'ahead' ＝相手は動いていない。取り込むものは無いが、ローカルの変更も捨てない。
        // ここで state を remote に差し替えると、**入力したばかりの記録が画面から消える**
        if (result === 'ahead') return void push(s, clientId).then(afterPush(s))
        // 'merged' ＝双方の追加が黙って併合された。**利用者に聞くことは何も無い。**
        // 画面はマージ結果（＝ローカル）を映し、送り返す
        if (result === 'merged') {
          state = localState(s.roomId)
          renderRoom()
          toast('相手の記録と合わせました')
          return void push(s, clientId).then(afterPush(s))
        }
        state = remote
        renderRoom()
        renderSync('synced')
      } catch {
        // 復号できない＝自分の鍵では読めないもの。触らない
      }
    },
  })
}

/**
 * 🔴 **電波のあるうちに、圏外で要る物を手元へ寄せておく。**
 *
 * QR を描くコードは遅延 chunk（ライブラリ本体で約 21KB）で、Service Worker は
 * **使われた時にしか蓄えない**。つまり一度も QR を出していない端末は、圏外に
 * なった瞬間に**人を招けなくなる**——招かれた側は電波なしで入れるのに、招く側が
 * 電波を要求される。2026-09-06、ユーザーが実機で踏んだ（入口の材料と合わせて2層あった）。
 *
 * ⚠ 初回読み込みには足さない（静的 import にすると初回がほぼ倍になる）。
 * **部屋に居る人だけが、描画を邪魔しない後ろで静かに取る。**
 * ⚠ 失敗しても黙る。要る時に改めて取りに行き、そこで初めて画面に出す。
 * ⚠ ネイティブのシェルでは成果物が端末に同梱されるので、この寄せ集めは要らない
 *   （害も無い＝同じファイルを読むだけ）。
 */
let qrWarmed = false
let entryAsked = ''

function warmForOffline(roomId: string): void {
  if (!navigator.onLine) return

  // ① QR を描くコード。**主な保証は sw.js の先読み**（scripts/build-sw.mjs の
  //    OFFLINE_CRITICAL）。ここはその予備＝Service Worker がまだ有効でない初回や、
  //    登録に失敗した環境のために、電波のあるうちに触っておく
  if (!qrWarmed) {
    qrWarmed = true
    void qrModule().catch(() => (qrWarmed = false))
  }

  /**
   * ② 入口の材料。**この版より前に覚えた部屋は持っていない。**
   *
   * 🔴 利用者に「電波のあるうちに一度QRを出しておいて」と頼まないこと。
   * 頼まれたことは忘れるし、**忘れたことに気づくのは押せない場所（圏外）**。
   * 移行の手間を利用者の記憶に預けた時点で、その機能は壊れている。
   * ⇒ 電波のある所でその部屋を開いたら、黙って取ってくる（認証不要の小さな1回）。
   */
  if (entryAsked !== roomId && !rememberedEntry(roomId)) {
    entryAsked = roomId
    void roomEntry(roomId)
      .then((e) => rememberEntry(roomId, e))
      .catch(() => (entryAsked = '')) // 取れなければ、次に部屋を開いた時にまた試す
  }
}

function renderRoom() {
  if (!state) return
  if (session) warmForOffline(session.roomId)
  $('roomName').textContent = state.name
  startLive()
  renderMembers()
  renderBookings()
  renderSummary()
  // Web 配信では出さない（billing.ts と同じ判定＝サーバーに課金状態を持たせない設計の帰結）
  $('exportRow').hidden = !inNativeShell
  $('exportHint').hidden = !inNativeShell
  show('room')
}

/**
 * 🔴 **CSV書き出し（Shipaton の有料機能）。**
 *
 * 権利判定は圏外でも動く（`billing.ts`）ので、まず判定してから、無ければ購入を挟む。
 * 判定・購入・書き出しのどこで失敗しても、利用者に理由が分かる形で止める
 * （`lazy()` と同じ規律＝失敗を握り潰さない）。
 */
async function doExport() {
  if (!state) return
  const billing = await lazy(billingModule, '課金の確認')
  if (!billing) return
  const keys = billingKeys()
  $('exportBtn').setAttribute('disabled', '')
  try {
    let ok = await billing.hasExportEntitlement(keys)
    if (!ok) {
      toast('購入手続きを開いています…')
      const result = await billing.purchaseExport(keys)
      if (result === 'cancelled') return // 静かに戻る。失敗ではない
      if (result === 'no_offering') return toast('現在、購入できる状態ではありません')
      if (result === 'failed') return toast('購入に失敗しました')
      ok = true // 'purchased'
    }
    const share = await lazy(exportShareModule, 'CSVの書き出し')
    if (!share) return
    const { roomToCsv, csvFileName } = await import('./csv.ts')
    await share.shareCsv(csvFileName(state.name), roomToCsv(state))
  } catch (e) {
    toast(`書き出しに失敗しました: ${e instanceof Error ? e.message : e}`)
  } finally {
    $('exportBtn').removeAttribute('disabled')
  }
}

/** 機種変・再インストールで購入を引き継ぐ（端末帰属の代償を埋める導線） */
async function doRestore() {
  const billing = await lazy(billingModule, '購入の復元')
  if (!billing) return
  toast('復元しています…')
  const ok = await billing.restore(billingKeys())
  toast(ok ? '購入を復元しました' : 'この端末・アカウントでの購入履歴が見つかりませんでした')
}

function renderMembers() {
  if (!state) return
  $('members').innerHTML =
    state.members.map((m) => `<span class="chip on">${esc(m.name)}</span>`).join('') ||
    '<span class="muted">まだ誰もいません</span>'
  const sel = $('payer') as HTMLSelectElement
  const keep = sel.value
  sel.innerHTML = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')
  if (keep) sel.value = keep
  renderFormParts()
}

/**
 * 誰で割るかを選ぶ。**旅行では「この食事は3人だけ」が普通に起きる**ので、
 * 常に全員で割ると金額が合わない。
 */
function renderFormParts() {
  if (!state) return
  const ids = state.members.map((m) => m.id)
  if (formParts) formParts = formParts.filter((id) => ids.includes(id))
  const chosen = formParts ?? ids
  const all = chosen.length === ids.length
  $('parts').innerHTML =
    ids.length === 0
      ? '<span class="muted">先にメンバーを追加してください</span>'
      : `<button type="button" class="chip${all ? ' on' : ''}" data-part="*">全員</button>` +
        state.members
          .map(
            (m) =>
              `<button type="button" class="chip${chosen.includes(m.id) ? ' on' : ''}" data-part="${esc(m.id)}">${esc(m.name)}</button>`,
          )
          .join('')
  const amount = Number(($('amount') as HTMLInputElement).value)
  // ⚠ `amount / chosen.length` を出してはいけない。実際に課されるのは sharesOf の
  // 整数配分で、100円を3人なら 34/33/33。割り算の結果（33.33…）を丸めて見せると
  // **画面が「1人33円」と言い、精算は34円を課す**（README が「端数は丸めない」と
  // 書いているその画面で矛盾していた。2026-09-06 の設計レビューで発見）
  if (chosen.length && Number.isFinite(amount) && amount > 0) {
    const { base, delta, bearers } = shareSummary(amount, chosen, editingId ?? draftId)
    const who = bearers.map((id) => nameOfMember(id)).join('・')
    $('partsInfo').textContent = bearers.length
      ? `${chosen.length}人で割る → 1人 ${yen(base)}円（端数の${yen(Math.abs(delta))}円は ${who}）`
      : `${chosen.length}人で割る → 1人 ${yen(base)}円`
  } else {
    $('partsInfo').textContent = `${chosen.length}人で割る`
  }
}

function renderBookings() {
  if (!state) return
  const ids = state.members.map((m) => m.id)
  const nameOf = (id: string) => state!.members.find((m) => m.id === id)?.name ?? '?'
  $('bookings').innerHTML = state.bookings.length
    ? state.bookings
        .map((b) => {
          const others = parts(b, ids).filter((id) => id !== b.payer)
          return `<div class="card${isDone(b, ids) ? ' done' : ''}">
        <div class="card-head"><b>${esc(b.category)}</b> ${esc(b.description)}
          <span class="amount">${yen(b.amount)}円</span></div>
        <div class="muted">${esc(nameOf(b.payer))} が立替 ／ ${parts(b, ids).length}人で割る
          （${parts(b, ids).map((id) => esc(nameOf(id))).join('・')}）${(() => {
            const { delta, bearers } = shareSummary(b.amount, parts(b, ids), b.id)
            // ⚠ 旅を通した「当番」の集計は出さない。担い手は予約IDから決まる疑似乱数で、
            // 同じ人に続けて当たるのは普通。集計すると公平に配っているのに不公平に見える
            return bearers.length
              ? `<br>端数の${yen(Math.abs(delta))}円は ${bearers.map((id) => esc(nameOf(id))).join('・')}`
              : ''
          })()}</div>
        <div class="paid">${others
          .map(
            (id) =>
              `<label><input type="checkbox" data-paid="${esc(b.id)}" data-member="${esc(id)}"
                ${b.paid?.[id] ? 'checked' : ''}> ${esc(nameOf(id))}</label>`,
          )
          .join('')}</div>
        <div class="actions">
          <button class="ghost small" data-edit="${esc(b.id)}">直す</button>
          <button class="ghost small" data-del="${esc(b.id)}">消す</button>
        </div>
      </div>`
        })
        .join('')
    : '<p class="muted">まだ記録がありません</p>'
}

function renderSummary() {
  if (!state) return
  const nameOf = (id: string) => state!.members.find((m) => m.id === id)?.name ?? '?'
  const bal = balances(state)
  const adv = advanced(state)
  $('summary').innerHTML = state.members
    .map((m) => {
      const r = Math.round(bal.get(m.id) ?? 0)
      const tag = r > 0 ? `受け取る ${yen(r)}円` : r < 0 ? `支払う ${yen(-r)}円` : '精算済み'
      return `<div class="row"><b>${esc(m.name)}</b>
        <span class="muted">立替 ${yen(adv.get(m.id) ?? 0)}円</span>
        <span class="${r > 0 ? 'recv' : r < 0 ? 'pay' : 'ok'}">${tag}</span></div>`
    })
    .join('')

  const txns = settle(bal)
  $('transfers').innerHTML = txns.length
    ? `<h3>誰が誰にいくら払うか</h3>` +
      txns
        .map(
          (t) =>
            `<div class="row"><b class="pay">${esc(nameOf(t.from))}</b> → <b class="recv">${esc(nameOf(t.to))}</b>
             <span class="amount">${yen(t.amount)}円</span></div>`,
        )
        .join('')
    : '<p class="ok">精算完了。支払い残はありません</p>'
}

/**
 * 🔴 変更は**まず端末に確定させる**。通信は後ろで行う。
 * 旅先で電波が切れても入力が消えないようにするための順序であり、逆にしてはいけない。
 */
function persist() {
  if (!session || !state) return
  commitLocal(session.roomId, state)
  // 消えた部屋へは送らない（送っても 404 が返るだけ）。端末の控えには残す
  if (goneRooms.has(session.roomId)) return renderSync('gone')
  // 断られると分かっているトークンでは送らない。入り直した後の合流で送る
  if (expiredRooms.has(session.roomId)) return renderSync('expired')
  renderSync('pending')
  void push(session, clientId).then(afterPush(session))
}

/**
 * 🔴 **部屋がサーバーから消えていた。控えは消さない。知らせて、同期を止める。**
 *
 * 以前は 404 を「繋がらない」と同じに扱っていた。削除済みの部屋を開いた端末は「未同期」のまま
 * 最大30秒おきに繋ぎ直しを続け、**以後足した記録はどこにも届かず、削除されたことも一度も
 * 知らされなかった**＝他の参加者には「この端末から消す」を押すきっかけが来なかった
 * （2026-09-10 の PP×実装の監査で指摘）。
 * ⚠ 控えは**自動で消さない**。本人の同意なく消すのは、中身を最後に見る機会を奪う。
 *   消すかどうかは本人が「この端末から消す」で決める（PP の説明どおり）。
 */
const goneRooms = new Set<string>()
function onRoomGone(s: import('./api.ts').Session) {
  // 🔴 何度呼ばれてもトーストは初回だけ。画面復帰（visibilitychange）は削除済みの部屋を
  // 開いたままでも毎回 resync を呼ぶので、印を付けずに毎回 toast すると、
  // 戻るたびに同じ通知が繰り返し出る（2026-09-11 の多観点レビューで発見。onTokenRejected と同じ形）
  const first = !goneRooms.has(s.roomId)
  goneRooms.add(s.roomId)
  if (session?.roomId !== s.roomId) return
  disconnectLive()
  // ⚠ 接続を先に手放すので「切れた」の通知（onStatus(false)）は来ない。自分で消さないと
  // 「他の端末とつながっています」が削除の表示と並んで残る（2026-09-11 に実ブラウザで見つけた）
  $('live').textContent = ''
  renderSync('gone')
  if (first) toast('この旅行はサーバーから削除されています')
}

/**
 * 🔴 **接続用のトークンが断られた（主に30日の期限切れ）。控えは消さない。知らせて、同期を止める。**
 *
 * 以前は 401 を「繋がらない」と同じに扱っていた。最後に合言葉で入ってから30日経った端末は
 * 「未同期」のまま黙って止まり、合言葉を聞き直す経路も無かった＝以後足した記録はどこにも届かず、
 * 1年の自動削除の期限も延びない（延ばすのは入室だけ＝PP §7）（2026-09-11 に発見）。
 * ⚠ 画面を合言葉の入力へ**勝手に切り替えない**。中身は端末にあり、合言葉が手元に無くても
 *   見られるべき（端末の控えは期限なく読める＝設計 §9）。入り直すのは本人が押した時だけ。
 * ⚠ トークンは消さない。空にすると圏外入室（§9.1）の部屋と区別できなくなり、別の案内が出る。
 *   断られたことはこのタブの間だけ覚える。開き直せば一度だけ問い合わせ、また断られて分かる。
 */
const expiredRooms = new Set<string>()
function onTokenRejected(s: import('./api.ts').Session) {
  const first = !expiredRooms.has(s.roomId)
  expiredRooms.add(s.roomId)
  if (session?.roomId !== s.roomId) return
  disconnectLive()
  // onRoomGone と同じ理由で、「つながっています」は自分で消す
  $('live').textContent = ''
  renderSync('expired')
  if (first) toast('接続の期限が切れました。合言葉で入り直すと同期を再開します')
  // ⚠ 見せる控えが無い（部屋の一覧にだけ残っている）なら、入り直す以外に進む先が無い
  if (!localState(s.roomId)) startRejoin()
}

/** 期限が切れた部屋に、合言葉で入り直す。端末の控えは doJoin の3方向マージを通る＝消えない */
function startRejoin() {
  if (!session) return
  ;($('joinRoom') as HTMLInputElement).value = session.roomId
  $('offlineHint').hidden = true
  $('rejoinHint').hidden = true
  $('expiredHint').hidden = false
  show('join')
}

/**
 * 🔴 **`push` が返す 'conflict' を捨てない。**
 *
 * 以前は全ての呼び出しが `.then(renderSync)` だけで、renderSync は帯の文字を
 * 書き換えるだけだった。だから送信中に衝突が起きると、**「食い違っています」と
 * 出るのに選ぶ手段が無く、以後その端末は1件もサーバーへ届かなくなった**
 * （2026-09-07 のレビューで発見。WebSocket が塞がれた網では恒久化する）。
 */
function afterPush(s: import('./api.ts').Session) {
  return (status: SyncStatus) => {
    if (status === 'conflict') return void showConflict(s)
    if (status === 'gone') return onRoomGone(s)
    if (status === 'expired') return onTokenRejected(s)
    // 🔴 送信中に別の部屋へ移った／入り直したかもしれない。resync と同じ理由（上のコメント）で、
    // 帯（#sync）を今見ている部屋以外の状態で書き換えない。onRoomGone/onTokenRejected は
    // roomId で内部に同じ守りを持つのでここでは触らない
    if (session === s) renderSync(status)
  }
}

function renderSync(status: SyncStatus) {
  const el = $('sync')
  const label: Record<SyncStatus, string> = {
    synced: '保存済み',
    pending: '未同期（この端末には保存されています）',
    offline: 'オフライン（この端末には保存されています）',
    conflict: '他の端末の変更と食い違っています',
    gone: 'この旅行はサーバーから削除されています。この端末の控えだけが残っています（入口の「この端末から消す」で消せます）',
    expired: '接続の期限が切れています。合言葉で入り直すと同期を再開します（この端末には保存されています）',
  }
  el.textContent = label[status]
  el.className = `sync ${status}`
  $('rejoinBtn').hidden = status !== 'expired'
}

function addMember() {
  const input = $('newMember') as HTMLInputElement
  const name = input.value.trim()
  if (!name || !state) return
  if (state.members.length >= 20) return toast('メンバーは20人までです')
  state.members.push({ id: crypto.randomUUID(), name })
  input.value = ''
  renderMembers()
  renderBookings()
  renderSummary()
  persist()
}

function saveBooking() {
  if (!state) return
  const amount = Number(($('amount') as HTMLInputElement).value)
  const payer = ($('payer') as HTMLSelectElement).value
  if (!payer) return toast('先にメンバーを追加してください')
  if (!Number.isFinite(amount) || amount <= 0) return toast('金額を入れてください')
  const chosen = formParts ?? state.members.map((m) => m.id)
  if (chosen.length === 0) return toast('割る相手を1人以上選んでください')

  const fields = {
    category: ($('category') as HTMLSelectElement).value,
    description: ($('description') as HTMLInputElement).value.trim(),
    payer,
    amount,
    participants: chosen,
  }

  if (editingId) {
    const b = state.bookings.find((x) => x.id === editingId)
    if (b) {
      // ⚠ 支払い済みのチェックは残す。ただし対象から外れた人の分は消す
      // （残すと「もう払った人」として精算から抜け落ちる）
      Object.assign(b, fields)
      for (const id of Object.keys(b.paid ?? {})) {
        if (!chosen.includes(id)) delete b.paid[id]
      }
    }
  } else {
    state.bookings.push({
      // オフラインで採番すると連番は必ず衝突する（設計 §6）
      id: draftId,
      ...fields,
      paid: {},
    })
    // 次の記録のぶんを確保し直す。ここを忘れると全記録が同じIDになる
    draftId = crypto.randomUUID()
  }
  cancelEdit()
  renderBookings()
  renderSummary()
  persist()
}

function startEdit(id: string) {
  if (!state) return
  const b = state.bookings.find((x) => x.id === id)
  if (!b) return
  editingId = id
  formParts = [...parts(b, state.members.map((m) => m.id))]
  ;($('category') as HTMLSelectElement).value = b.category
  ;($('description') as HTMLInputElement).value = b.description
  ;($('amount') as HTMLInputElement).value = String(b.amount)
  ;($('payer') as HTMLSelectElement).value = b.payer
  $('saveBookingBtn').textContent = 'この内容に直す'
  $('cancelEditBtn').hidden = false
  renderFormParts()
  $('bookingForm').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function cancelEdit() {
  editingId = null
  formParts = null
  // ⚠ カテゴリも戻す。戻さないと、直前に直した記録の種別が次の記録に引き継がれる
  ;($('category') as HTMLSelectElement).selectedIndex = 0
  ;($('description') as HTMLInputElement).value = ''
  ;($('amount') as HTMLInputElement).value = ''
  $('saveBookingBtn').textContent = '記録する'
  $('cancelEditBtn').hidden = true
  renderFormParts()
}

function deleteBooking(id: string) {
  if (!state) return
  const b = state.bookings.find((x) => x.id === id)
  if (!b) return
  // 消すのは戻せないので、何を消すのか見せてから聞く
  if (!confirm(`「${b.description || b.category}／${yen(b.amount)}円」を消します。よろしいですか。`)) return
  state.bookings = state.bookings.filter((x) => x.id !== id)
  if (editingId === id) cancelEdit()
  renderBookings()
  renderSummary()
  persist()
}

/** 部屋ごと消す。合言葉を保存していないので、必ず打ってもらう＝不可逆操作の関門になる */
async function destroyRoom() {
  if (!session || !state) return
  // ⚠ prompt() は素のテキストしか出せない。Markdown の `**` はそのまま文字として表示される。
  // ここはアプリで唯一の不可逆操作の直前なので、記号が混ざって見えるのは最悪の場所だった
  // （2026-09-05 の監査で発見）。強調は記号でなく、文そのもので出す。
  const pass = prompt(
    `「${state.name}」を完全に消します。\n\n` +
      `元に戻せません。サーバーは鍵を持たないので、消した内容は誰にも復元できません。\n\n` +
      `続けるなら合言葉を入力してください。`,
  )
  if (!pass) return
  const roomId = session.roomId
  try {
    const { deleteRoom } = await import('./api.ts')
    await deleteRoom(roomId, pass)
    // 🔴 「この端末から消す」と同じ手順で消す（止める→書き戻し禁止の印→消す）。以前は印を付けずに
    // 控えを消していたので、削除の往復中に届いた取り込みが控えを書き戻し、一覧に載らない
    // **孤児**になりえた（2026-09-10 に「この端末から消す」側だけ直していた＝2026-09-11 の照合で発見）
    forgetOnThisDevice(roomId)
    toast('消しました')
    renderHome()
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    toast(msg.includes('invalid_key') ? '合言葉が違います' : `消せませんでした: ${msg}`)
  }
}

/**
 * 🔴 **「この端末から消す」は、先に止めてから消す。**
 *
 * 以前は控えと鍵を消すだけで、その部屋の WebSocket も、画面の記憶（鍵とトークンを含む
 * session）も残していた。通信中の取り込みが返ると控えを書き戻し、入口の一覧に載らない
 * **孤児**ができた（2026-09-10 の監査で指摘）。
 */
function forgetOnThisDevice(roomId: string) {
  if (session?.roomId === roomId) {
    disconnectLive()
    session = null
    state = null
  }
  markForgotten(roomId) // 遅れて届く応答が書き戻さないように、消す前に印を付ける
  dropLocal(roomId)
  forget(roomId)
}

/**
 * 🔴 **別のタブで消された時も、このタブが追従する。**
 *
 * 同じブラウザの別タブでその部屋を開いたままだと、相手の更新が届いた時や記録を足した時に
 * 控えが書き直され、**サイトデータの削除でしか消せない孤児**が残っていた（2026-09-10 の監査）。
 * ⚠ `storage` は**変更した以外のタブ**で発火する＝まさにこの場合だけ拾える。
 * ⚠ key が null ＝別タブでサイトデータがまるごと消された。これも止める。
 */
addEventListener('storage', (e) => {
  if (!session) return
  if (e.key !== null && e.key !== 'michizure.rooms.v1') return
  const id = session.roomId
  if (rememberedAll().some((r) => r.roomId === id)) return
  forgetOnThisDevice(id)
  renderHome()
  toast('別のタブで、この旅行をこの端末から消しました')
})

// ---------- 配線 ----------

document.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  if (el.id === 'createBtn') void doCreate()
  if (el.id === 'joinBtn') void doJoin()
  if (el.id === 'toJoin') {
    $('expiredHint').hidden = true
    show('join')
  }
  if (el.id === 'rejoinBtn') startRejoin()
  if (el.id === 'toHome') {
    disconnectLive()
    renderHome()
  }
  if (el.id === 'enterRoomBtn') renderRoom()
  if (el.id === 'addMemberBtn') addMember()
  if (el.id === 'saveBookingBtn') saveBooking()
  if (el.id === 'cancelEditBtn') cancelEdit()
  if (el.id === 'destroyRoomBtn') void destroyRoom()
  if (el.id === 'exportBtn') void doExport()
  if (el.id === 'restoreBtn') void doRestore()
  if (el.dataset.edit) startEdit(el.dataset.edit)
  if (el.dataset.del) deleteBooking(el.dataset.del)
  if (el.dataset.part) {
    const ids = state?.members.map((m) => m.id) ?? []
    if (el.dataset.part === '*') formParts = formParts?.length === ids.length ? [] : [...ids]
    else {
      const cur = formParts ?? [...ids]
      formParts = cur.includes(el.dataset.part)
        ? cur.filter((x) => x !== el.dataset.part)
        : [...cur, el.dataset.part]
    }
    renderFormParts()
  }
  if (el.dataset.open) void openRemembered(el.dataset.open)
  if (el.dataset.forget) {
    forgetOnThisDevice(el.dataset.forget)
    renderHome()
    toast('この端末から消しました')
  }
  if (el.id === 'copyPass') {
    void navigator.clipboard.writeText($('shownPass').textContent ?? '')
    toast('合言葉をコピーしました（リンクとは別の経路で送ってください）')
  }
  if (el.id === 'copyUrl') {
    void navigator.clipboard.writeText($('shownUrl').textContent ?? '')
    toast('リンクをコピーしました（合言葉は別に伝えてください）')
  }
  if (el.id === 'showQr') {
    void toggleQr()
  }
  if (el.id === 'inviteBtn') {
    void toggleInviteQr()
  }
  if (el.id === 'sayPass') {
    // 読み上げる人のために大きくするだけ。合言葉を音声で送るわけではない
    const box = $('shownPass')
    const on = box.classList.toggle('say')
    el.textContent = on ? '元の大きさに戻す' : '声で伝える'
  }
})

/**
 * 切符を裂く。ミシン目の上を横になぞると二つに分かれる。
 *
 * ⚠ **これは近道ではなく、意味の説明である。** 裂かなくてもボタンは全部使えるし、
 * 裂いても何かが起きるわけではない。伝えたいのは「リンクと合言葉は別の物で、
 * 別々に渡す」という一点で、注意書きより手の方がよく覚える。
 *
 * ⚠ 縦スクロールを殺さないこと（CSS の touch-action: pan-y と対）。
 * 横に一定量動いた時だけ成立させ、縦に動いたら諦める。
 */
function setupTear() {
  const perf = $('perf')
  const ticket = $('ticket')
  let x0: number | null = null
  let y0 = 0
  perf.addEventListener('pointerdown', (e) => {
    x0 = e.clientX
    y0 = e.clientY
  })
  perf.addEventListener('pointermove', (e) => {
    if (x0 === null || ticket.classList.contains('torn')) return
    if (Math.abs(e.clientY - y0) > 24) return void (x0 = null) // 縦の動き＝スクロール
    if (Math.abs(e.clientX - x0) < 48) return
    x0 = null
    ticket.classList.add('torn')
    $('tearHint').textContent = '別々の相手に、別々の経路で渡してください。'
  })
  perf.addEventListener('pointerup', () => (x0 = null))
  perf.addEventListener('pointercancel', () => (x0 = null))
}

setupTear()

document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement
  if (el.id === 'importFile' && el.files?.[0]) void handleImportFile(el.files[0])
})

document.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id === 'amount') renderFormParts()
})

document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement
  if (el.dataset.paid && state) {
    const b = state.bookings.find((x) => x.id === el.dataset.paid)
    if (!b) return
    b.paid ??= {}
    if (el.checked) b.paid[el.dataset.member!] = true
    else delete b.paid[el.dataset.member!]
    renderBookings()
    renderSummary()
    persist()
  }
})

// 電波が戻ったら、溜まっている変更を自動で送る（利用者に再操作させない）
/**
 * 圏外入室（設計 §9.1）。**サーバーに一度も触れずに部屋へ入る。**
 *
 * URL のフラグメントに入口券（版・反復回数・salt）が付いていれば、
 * 合言葉だけで鍵を作れる。中身は入っていないので**空の部屋として始まり**、
 * 電波が戻った時に3方向マージで相手の記録と合流する。
 *
 * ⚠ 土台は「空の部屋」に置く。これは便宜ではなく**実際に真の共通祖先**
 * （入った人は何も持っていなかった）。だから双方の追加が全部残る。
 *
 * ⚠ `authKey` は端末に保存しない（設計 §9.1）。最初の入室が通るまで
 * 記憶の中だけに置く＝盗まれた端末でできることを広げない。
 */
async function offlineJoin(roomId: string, passphrase: string): Promise<boolean> {
  // 🔴 券は URL の部屋にだけ使う（別の部屋の入口で鍵を作らない）
  const e = entryForRoom(location.pathname, location.hash, roomId)
  if (!e) return false
  // 🔴 **控えがある部屋は、圏外入室で上書きしない。** 圏外入室は「まだ何も持っていない」人の
  // 入り方で、空の部屋を土台に書く。以前は控えの有無を見ずに書いていたので、入り直しが
  // 通信の失敗で落ちると、**期限切れの間に足した未送信の記録ごと控えが空になり**、一覧の行も
  // 名前とトークンを失っていた（2026-09-11 の多観点照合で発見・反証2票とも本物）。
  if (localState(roomId)) return false
  revive(roomId) // 本人が券で入り直す＝明示の操作
  try {
    // ⚠ 静的 import であること。ここを遅延にすると **圏外で読み込めない**
    // （2026-09-06、実際にそれで入室に失敗した）
    const { encKeyBits } = await deriveKeys(passphrase, e.salt, e.iterations, e.kdfVersion)
    // ⚠ ここでは合言葉の正しさを確かめられない（照合する物が手元に無い）。
    // 間違っていれば、電波が戻って最初に同期しようとした時に分かる
    session = { roomId, token: '', encKeyBits }
    const empty = emptyRoomForEntry()
    state = empty
    adoptAsBase(roomId, empty)
    // 🔴 券そのものが入口の材料。控えれば**この端末も圏外のまま次の人を招ける**
    remember(session, '', e)
    show('room')
    renderRoom()
    renderSync('offline')
    toast('圏外で入りました。電波が戻ると、相手の記録と合流します')
    return true
  } catch {
    return false
  }
}

/** 入口券が付いている時だけ、圏外でも入れることを画面で知らせる */
function offerOfflineJoin(roomId: string) {
  if (!entryFromHash(location.hash)) return
  $('offlineHint').hidden = false
  $('expiredHint').hidden = true
  $('offlineHint').dataset.room = roomId
}

/**
 * 電波が戻った瞬間にやること。
 *
 * 🔴 **`isDirty` で門を作らない。自分が何も足していなくても、相手の記録は取りに行く。**
 *
 * 以前はここが「未送信があれば送る」だけだった。だから圏外で何も足さなかった端末は、
 * 電波が戻っても**合流せず、`renderSync` も呼ばれないので表示も「オフライン」のまま**
 * だった。合流と表示が同じ1つの条件にぶら下がっていたせいで、利用者からは
 * 「保存済みに変わる時だけ合流する」ように見えていた——**相関ではなく、同じ原因**。
 * （2026-09-06、実機からの報告で判明）
 *
 * ⚠ 送るだけでは足りない。`push` は相手の版を取りに行かないので、
 * **受け取る側が永久に受け取らない**。
 */
addEventListener('online', () => {
  const s = session
  if (!s || $('room').hidden) return
  // 圏外入室（設計 §9.1）で入った部屋は token を持たない＝送っても弾かれる。
  // 合言葉で正式に入り直してもらう（#rejoinHint はこの瞬間のために書かれている）
  if (!s.token) {
    ;($('joinRoom') as HTMLInputElement).value = s.roomId
    $('expiredHint').hidden = true
    $('rejoinHint').hidden = false
    return show('join')
  }
  void resync(s).catch(() => renderSync(isDirty(s.roomId) ? 'pending' : 'offline'))
})

/**
 * 🔴 **画面に戻った時も、HTTP で確かめる。**
 *
 * 以前は WebSocket を張り直すだけだった。張り直しが 401（トークン切れ）や 404（削除済み）で
 * 断られても理由は分からないので、背景から戻っただけのタブは「保存済み」のまま、トークン切れにも
 * 削除にも気づけなかった（2026-09-11 の多観点照合で発見）。⚠ 圏外入室の部屋（token 無し）は
 * online の側が合言葉を聞くので、ここでは触らない。
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  const s = session
  if (!s || !s.token || $('room').hidden) return
  void resync(s).catch(() => renderSync(isDirty(s.roomId) ? 'pending' : 'offline'))
})

// URL が /r/<roomId> なら、その部屋を開こうとする（合言葉は URL に入れない＝設計 §7.6.1 ②）
const m = location.pathname.match(/^\/r\/([0-9A-Z]{16})$/)
if (m) {
  const saved = remembered(m[1])
  if (saved) void openRemembered(m[1])
  else {
    ;($('joinRoom') as HTMLInputElement).value = m[1]
    // 圏外入室券（`#k=`）が付いていれば、通信せずに入れると案内する
    offerOfflineJoin(m[1])
    show('join')
  }
} else {
  renderHome()
}

void checkApiReachable()
