import { SELF, runInDurableObject, env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'
import type { Room } from '../src/room'
import { SERVER_STORED } from '../src/server-stored-fields'

const FAST = 100_000

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
