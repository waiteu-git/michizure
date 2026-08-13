import {
  createRoom,
  enterRoom,
  loadState,
  saveState,
  emptyState,
  type RoomState,
  type Session,
} from './api.ts'
import { remember, remembered, rememberedAll, forget } from './session-store.ts'
import { balances, advanced, settle, parts, isDone } from './settle.ts'
import {
  commitLocal,
  localState,
  isDirty,
  pull,
  push,
  dropLocal,
  conflictSides,
  resolveKeepMine,
  resolveTakeTheirs,
  type SyncStatus,
} from './store.ts'

// ⚠ 単語リスト（約7KB）は【部屋を作る時にしか要らない】ので、その時に取りに行く。
// 最初の読み込みに含めると、入室しかしない人にも運ばせることになる
const passphraseModule = () => import('./passphrase.ts')

const $ = (id: string) => document.getElementById(id)!
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

let session: Session | null = null
let state: RoomState | null = null

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
  const { generatePassphrase, customPassphraseTooWeak, estimateBits } = await passphraseModule()
  if (custom && customPassphraseTooWeak(custom)) {
    return toast(`合言葉が弱すぎます（推定 ${estimateBits(custom)} ビット）`)
  }
  const passphrase = custom || generatePassphrase()

  $('createBtn').setAttribute('disabled', '')
  toast('鍵を作っています…')
  try {
    const s = await createRoom(passphrase, emptyState(name))
    session = { roomId: s.roomId, token: s.token, encKeyBits: s.encKeyBits }
    state = emptyState(name)
    remember(session, name)
    commitLocal(s.roomId, state)
    ;($('shownPass') as HTMLElement).textContent = passphrase
    ;($('shownUrl') as HTMLElement).textContent = `${location.origin}/r/${s.roomId}`
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
  $('joinBtn').setAttribute('disabled', '')
  toast('合言葉から鍵を作っています…')
  try {
    session = await enterRoom(roomId, pass)
    state = await loadState(session)
    remember(session, state.name)
    commitLocal(roomId, state)
    renderSync('synced')
    renderRoom()
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
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
  session = s

  const cached = localState(roomId)
  if (cached) {
    state = cached
    renderRoom()
    renderSync(isDirty(roomId) ? 'pending' : 'synced')
  }

  try {
    const result = await pull(s)
    if (result === 'conflict') return showConflict(s)
    state = localState(roomId)
    renderRoom()
    renderSync(isDirty(roomId) ? 'pending' : 'synced')
    if (isDirty(roomId)) void push(s).then(renderSync)
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
 * 衝突＝自動でマージしない（設計の非スコープ）。**どちらを残すかは利用者が決める。**
 * 黙って上書きすると、片方の入力が理由も分からず消える
 */
async function showConflict(s: import('./api.ts').Session) {
  renderSync('conflict')
  const { mine, theirs } = await conflictSides(s)
  const count = (x: typeof mine) => `${x.members.length}人・記録${x.bookings.length}件`
  $('conflict').innerHTML = `
    <div class="warn">
      <b>この端末の変更と、他の端末の変更が食い違っています。</b>
      どちらを残すか選んでください。<b>選ばなかったほうは消えます。</b>
    </div>
    <div class="row"><span>この端末（${count(mine)}）</span>
      <button id="keepMine">こちらを残す</button></div>
    <div class="row"><span>他の端末（${count(theirs)}）</span>
      <button class="ghost" id="takeTheirs">こちらを残す</button></div>`
  $('conflict').hidden = false
  $('keepMine').onclick = () => {
    resolveKeepMine(s.roomId, mine)
    state = mine
    $('conflict').hidden = true
    renderRoom()
    void push(s).then(renderSync)
  }
  $('takeTheirs').onclick = () => {
    resolveTakeTheirs(s.roomId, theirs)
    state = theirs
    $('conflict').hidden = true
    renderRoom()
    renderSync('synced')
  }
}

// ---------- 部屋 ----------

function renderRoom() {
  if (!state) return
  $('roomName').textContent = state.name
  renderMembers()
  renderBookings()
  renderSummary()
  show('room')
}

function renderMembers() {
  if (!state) return
  $('members').innerHTML =
    state.members.map((m) => `<span class="chip on">${esc(m.name)}</span>`).join('') ||
    '<span class="muted">まだ誰もいません</span>'
  const sel = $('payer') as HTMLSelectElement
  sel.innerHTML = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')
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
        <div class="muted">${esc(nameOf(b.payer))} が立替 ／ ${others.length + 1}人で割る</div>
        <div class="paid">${others
          .map(
            (id) =>
              `<label><input type="checkbox" data-paid="${esc(b.id)}" data-member="${esc(id)}"
                ${b.paid?.[id] ? 'checked' : ''}> ${esc(nameOf(id))}</label>`,
          )
          .join('')}</div>
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
  renderSync('pending')
  void push(session).then(renderSync)
}

function renderSync(status: SyncStatus) {
  const el = $('sync')
  const label: Record<SyncStatus, string> = {
    synced: '保存済み',
    pending: '未同期（この端末には保存されています）',
    offline: 'オフライン（この端末には保存されています）',
    conflict: '他の端末の変更と食い違っています',
  }
  el.textContent = label[status]
  el.className = `sync ${status}`
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

function addBooking() {
  if (!state) return
  const amount = Number(($('amount') as HTMLInputElement).value)
  const payer = ($('payer') as HTMLSelectElement).value
  if (!payer) return toast('先にメンバーを追加してください')
  if (!Number.isFinite(amount) || amount <= 0) return toast('金額を入れてください')
  state.bookings.push({
    // オフラインで採番すると連番は必ず衝突する（設計 §6）
    id: crypto.randomUUID(),
    category: ($('category') as HTMLSelectElement).value,
    description: ($('description') as HTMLInputElement).value.trim(),
    payer,
    amount,
    participants: state.members.map((m) => m.id),
    paid: {},
  })
  ;($('amount') as HTMLInputElement).value = ''
  ;($('description') as HTMLInputElement).value = ''
  renderBookings()
  renderSummary()
  persist()
}

// ---------- 配線 ----------

document.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  if (el.id === 'createBtn') void doCreate()
  if (el.id === 'joinBtn') void doJoin()
  if (el.id === 'toJoin') show('join')
  if (el.id === 'toHome') renderHome()
  if (el.id === 'enterRoomBtn') renderRoom()
  if (el.id === 'addMemberBtn') addMember()
  if (el.id === 'addBookingBtn') addBooking()
  if (el.dataset.open) void openRemembered(el.dataset.open)
  if (el.dataset.forget) {
    dropLocal(el.dataset.forget)
    forget(el.dataset.forget)
    renderHome()
    toast('この端末から消しました')
  }
  if (el.id === 'copyPass') {
    void navigator.clipboard.writeText($('shownPass').textContent ?? '')
    toast('合言葉をコピーしました')
  }
  if (el.id === 'copyUrl') {
    void navigator.clipboard.writeText($('shownUrl').textContent ?? '')
    toast('リンクをコピーしました（合言葉は別に伝えてください）')
  }
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
addEventListener('online', () => {
  if (session && isDirty(session.roomId)) void push(session).then(renderSync)
})

// URL が /r/<roomId> なら、その部屋を開こうとする（合言葉は URL に入れない＝設計 §7.6.1 ②）
const m = location.pathname.match(/^\/r\/([0-9A-Z]{16})$/)
if (m) {
  const saved = remembered(m[1])
  if (saved) void openRemembered(m[1])
  else {
    ;($('joinRoom') as HTMLInputElement).value = m[1]
    show('join')
  }
} else {
  renderHome()
}
