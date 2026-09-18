import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'
import { SERVER_STORED } from '../src/server-stored-fields'

const FAST = 100_000

/**
 * 条件が真になるまで待つ（上限つき）。固定の sleep は初回コールド実行で足りず落ちる
 * ＝公開クローンの初回で実際に落ちた（2026-09-19）。待つ対象は「時間」でなく「事象」。
 */
async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`待っている事象が起きなかった: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * 🔴 **サーバーが部屋ごとに保存するものを、宣言（src/server-stored-fields.ts）と突き合わせる。**
 *
 * 2026-09-07 に `rev` を足した時、公開予定のプライバシーポリシー §2 は「更新の回数は持っていない」
 * と書いたまま嘘になった（持っているのに持っていないと書く過少申告）。人が PP を洗い忘れても、
 * ここが止める。**キーだけでなく欄まで見る**＝既存のキーに欄を1つ足しても PP は嘘になるから。
 *
 * ⚠ 一通りの経路（作成・合言葉の失敗・入室・書き込み）を実際に通してから吐き出す。
 * 通さないと、失敗した時にしか作られない `gate` のような項目を見落とす。
 */
async function exercise() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys('あいことば', salt, FAST)
  const sealed = async (name: string) => ({ ...(await seal(encKeyBits, { name })), blobVersion: 1 })
  const created = (await (
    await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt, authKey, blob: await sealed('作成'), iterations: FAST, kdfVersion: 1 }),
    })
  ).json()) as { roomId: string; token: string; rev: number }
  const base = `https://example.com/api/rooms/${created.roomId}`

  // 合言葉を間違える（gate が作られる経路）
  const { authKey: wrong } = await deriveKeys('ちがうことば', salt, FAST)
  await SELF.fetch(`${base}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey: wrong }),
  })
  // 正しく入る（最後に入室した日時が動く経路）
  await SELF.fetch(`${base}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey }),
  })
  // 書き込む（blob と rev が動く経路）
  await SELF.fetch(`${base}/blob`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(await sealed('更新')), baseRev: created.rev }),
  })

  const stub = env.ROOM.get(env.ROOM.idFromName(created.roomId))
  return JSON.parse(await runInDurableObject(stub, (i: Room) => i.dumpForTest())) as {
    room?: { key: string; value: string }[]
    _storage_kv: Record<string, unknown>
  }
}

describe('サーバーが保存するもの', () => {
  it('表は room だけ（知らない表が増えていない）', async () => {
    const dump = await exercise()
    expect(Object.keys(dump).filter((k) => k !== '_storage_kv').sort()).toEqual(['room'])
  })

  it('room のキーは宣言と完全に一致する', async () => {
    const dump = await exercise()
    const keys = dump.room!.map((r) => r.key).sort()
    expect(keys).toEqual(Object.keys(SERVER_STORED.room).sort())
  })

  it('各キーの中の欄も宣言と完全に一致する（欄が1つ増えても PP は嘘になる）', async () => {
    const dump = await exercise()
    for (const row of dump.room!) {
      const decl = SERVER_STORED.room[row.key as keyof typeof SERVER_STORED.room]
      const value = JSON.parse(row.value)
      if (decl.fields === null) {
        expect(typeof value, `${row.key} は値そのもの（オブジェクトでない）と宣言している`).toBe('number')
      } else {
        expect(Object.keys(value).sort(), `${row.key} の欄`).toEqual([...decl.fields].sort())
      }
    }
  })

  it('KV には何も置かない（SQL から見えない場所に保存が増えていない）', async () => {
    const dump = await exercise()
    expect(Object.keys(dump._storage_kv)).toEqual([...SERVER_STORED.kv])
  })

  it('版の番号は書き込みのたびに増える＝更新の回数を持っていることの確認', async () => {
    const dump = await exercise()
    const rev = JSON.parse(dump.room!.find((r) => r.key === 'rev')!.value)
    // 作成で1、PUT で2。「サーバーは更新の回数を持たない」とは言えないことを、ここで固定する
    expect(rev).toBe(2)
  })
})

/**
 * 🔴 **改変したクライアントでも、保存は宣言どおりに揃うこと。**
 *
 * 以前は create と WS が受け取ったオブジェクトを丸ごと保存していた＝暗号化していない欄を
 * 足して保存させられた（2026-09-10 の監査で指摘）。上のテストは公式の流れしか通さないので、
 * ここでは**わざと余分な欄を付けて**3経路とも叩く。
 */
describe('改変したクライアントが余分な欄を足しても', () => {
  const EXTRA = { plaintext: '山田太郎・居酒屋・6000円', debug: { note: 'わざと足した欄' } }

  async function blobKeysOf(roomId: string) {
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId))
    const dump = JSON.parse(await runInDurableObject(stub, (i: Room) => i.dumpForTest())) as {
      room: { key: string; value: string }[]
    }
    return Object.keys(JSON.parse(dump.room.find((r) => r.key === 'blob')!.value)).sort()
  }

  async function createWith(extra: object) {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('あいことば', salt, FAST)
    const blob = { ...(await seal(encKeyBits, { name: '作成' })), blobVersion: 1, ...extra }
    const res = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
    })
    return { ...((await res.json()) as { roomId: string; token: string; rev: number }), encKeyBits }
  }

  it('作成の経路でも、保存される暗号文は3欄だけ', async () => {
    const room = await createWith(EXTRA)
    expect(await blobKeysOf(room.roomId)).toEqual(['blobVersion', 'ciphertext', 'iv'])
  })

  it('PUT の経路でも3欄だけ', async () => {
    const room = await createWith({})
    await SELF.fetch(`https://example.com/api/rooms/${room.roomId}/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${room.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(await seal(room.encKeyBits, { name: '更新' })), blobVersion: 1, baseRev: room.rev, ...EXTRA }),
    })
    expect(await blobKeysOf(room.roomId)).toEqual(['blobVersion', 'ciphertext', 'iv'])
  })

  it('WebSocket の経路でも3欄だけ（しかも他の端末へ中継される物も3欄だけ）', async () => {
    const room = await createWith({})
    const open = async (client: string) => {
      const res = await SELF.fetch(
        `https://example.com/api/rooms/${room.roomId}/ws?token=${encodeURIComponent(room.token)}&client=${client}`,
        { headers: { Upgrade: 'websocket' } },
      )
      const ws = res.webSocket!
      const got: any[] = []
      ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))))
      ws.accept()
      return { ws, got }
    }
    const writer = await open('writer')
    const reader = await open('reader')
    // サーバーは接続を受けた直後に init を送る＝それが届けば DO に登録済み
    await until(() => writer.got.some((m) => m.type === 'init'), 'writer への init')
    await until(() => reader.got.some((m) => m.type === 'init'), 'reader への init')
    writer.ws.send(JSON.stringify({
      type: 'update',
      blob: { ...(await seal(room.encKeyBits, { name: 'WSから' })), blobVersion: 1, ...EXTRA },
      baseRev: room.rev,
    }))
    await until(() => reader.got.some((m) => m.type === 'update'), '他の端末への update 中継')
    expect(await blobKeysOf(room.roomId)).toEqual(['blobVersion', 'ciphertext', 'iv'])
    const relayed = reader.got.find((m) => m.type === 'update')
    expect(relayed, '他の端末に中継が届いていること').toBeTruthy()
    expect(Object.keys(relayed.blob).sort()).toEqual(['blobVersion', 'ciphertext', 'iv'])
    writer.ws.close(); reader.ws.close()
  })
})

/**
 * 🔴 **部屋が消えた後の書き込みを受けない。**
 *
 * PUT は本文を待っている間に削除や期限切れが走りうる（本文の読み込み中は DO の入力ゲートが
 * 閉じない）。待った後に確かめ直さないと、meta も auth も alarm も無い blob と rev が残り、
 * 1年の自動削除の対象にもならない（2026-09-10 の監査で指摘）。
 * ⚠ 交互の順序そのものは再現しにくいので、**「在るかどうかを blob でなく meta で見る」**ことを
 * 固定する＝meta だけが消えた状態で PUT を送り、断られることを確かめる。
 */
describe('部屋が消えた後の書き込み', () => {
  it('meta が無い部屋への PUT は断る（blob が残っていても）', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('あいことば', salt, FAST)
    const created = (await (
      await SELF.fetch('https://example.com/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt, authKey, blob: { ...(await seal(encKeyBits, { name: '作成' })), blobVersion: 1 }, iterations: FAST, kdfVersion: 1 }),
      })
    ).json()) as { roomId: string; token: string; rev: number }
    const stub = env.ROOM.get(env.ROOM.idFromName(created.roomId))
    // 削除が途中まで走った状態を作る（meta だけ消す）
    await runInDurableObject(stub, (i: Room) => (i as any).sql().exec("DELETE FROM room WHERE key = 'meta'"))

    const res = await SELF.fetch(`https://example.com/api/rooms/${created.roomId}/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(await seal(encKeyBits, { name: '消えた後' })), blobVersion: 1, baseRev: created.rev }),
    })
    expect(res.status).toBe(404)
  })
})

/**
 * 🔴 **ユーザー裁定④（2026-09-11）＝使っていない createdAt を消す。古い部屋からも消えること。**
 *
 * createdAt は書くだけで一度も読まれていなかった。新しい部屋で書かないだけでは足りない＝
 * meta を展開（...meta）で書き直すと、**古い部屋に残り続ける**。次に入室した時に落ちることを確かめる。
 */
describe('作成日時（createdAt）を持たない', () => {
  it('古い形の meta も、次に入室した時に createdAt が消える', async () => {
    const salt = generateSalt()
    const { authKey, encKeyBits } = await deriveKeys('あいことば', salt, FAST)
    const created = (await (
      await SELF.fetch('https://example.com/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt, authKey, blob: { ...(await seal(encKeyBits, { name: '作成' })), blobVersion: 1 }, iterations: FAST, kdfVersion: 1 }),
      })
    ).json()) as { roomId: string }
    const stub = env.ROOM.get(env.ROOM.idFromName(created.roomId))
    // この変更の前に作られた部屋を再現する（meta に createdAt が入っている）
    await runInDurableObject(stub, (i: Room) => {
      const sql = (i as any).sql()
      const meta = JSON.parse([...sql.exec("SELECT value FROM room WHERE key = 'meta'")][0].value as string)
      sql.exec("UPDATE room SET value = ? WHERE key = 'meta'", JSON.stringify({ ...meta, createdAt: 1234567890 }))
    })
    await SELF.fetch(`https://example.com/api/rooms/${created.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey }),
    })
    const dump = JSON.parse(await runInDurableObject(stub, (i: Room) => i.dumpForTest())) as {
      room: { key: string; value: string }[]
    }
    const meta = JSON.parse(dump.room.find((r) => r.key === 'meta')!.value)
    expect(Object.keys(meta).sort()).toEqual(['lastAccessAt', 'roomId', 'schemaVersion'])
  })
})
