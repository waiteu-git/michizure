import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys } from '../src/keys'
import { seal } from '../src/box'

const FAST = 100_000

/**
 * 🔴 **認証なしで叩ける面を、実際に叩いて固定する。**
 *
 * 2026-09-09、前身 travel-calculation が `/api/data` を**認証なしで第三者の氏名と
 * 旅費を返したまま**稼働していたことが分かった。真因は「ログの不在」ではなく
 * **「認証の不在」**。発見は偶然で、しかも被害範囲は永久に確定できない
 * （アクセスログが対象期間を1日も覆っていなかった）。
 *
 * ⚠ この種の穴は**コードを読むレンズでは出ない**。「動いているサービスが何を返すか」
 * だから、実際に叩くしかない。scripts/check-public-surface.mjs が経路の数を、
 * ここがふるまいを固定する。**片方だけでは足りない。**
 */
async function makeRoom() {
  const salt = generateSalt()
  const { authKey, encKeyBits } = await deriveKeys('ことば', salt, FAST)
  const blob = {
    ...(await seal(encKeyBits, { name: '秘密の旅', members: [{ id: 'a', name: '山田太郎' }], bookings: [] })),
    blobVersion: 1,
  }
  const res = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authKey, blob, iterations: FAST, kdfVersion: 1 }),
  })
  return { ...((await res.json()) as { roomId: string; token: string; rev: number }), encKeyBits }
}

const bare = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://example.com${path}`, init) // ⚠ 資格情報を一切付けない

describe('認証なしで到達してよい面', () => {
  it('生存確認は誰でも叩けるが、部屋にも中身にも触れない', async () => {
    const res = await bare('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('ソルトは認証なしで返る（鍵を作る前に要るため）', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}/salt`)
    expect(res.status).toBe(200)
  })

  /**
   * 🔴 公開する面が「宣言した欄だけ」を返すこと。
   * 前身は、返す欄を数えていなかったから氏名まで出ていた。
   */
  it('ソルトの応答に、暗号文も鍵の照合値も入らない', async () => {
    const room = await makeRoom()
    const body = (await (await bare(`/api/rooms/${room.roomId}/salt`)).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['iterations', 'kdfVersion', 'salt'])
    const raw = JSON.stringify(body)
    for (const leak of ['ciphertext', 'iv', 'authKey', 'authKeyHash', 'token', '山田太郎', '秘密の旅']) {
      expect(raw).not.toContain(leak)
    }
  })

  it('存在しない部屋は 404（部屋の存在は漏れる＝設計どおり。IDは 36^16 で総当たり不能）', async () => {
    expect((await bare('/api/rooms/ZZZZZZZZZZZZZZZZ/salt')).status).toBe(404)
  })

  it('部屋の作成は認証なしで通る（作る前なので認証しようがない）', async () => {
    expect((await makeRoom()).roomId).toMatch(/^[0-9A-Z]{16}$/)
  })
})

describe('守られている面（資格情報なしで中身が出ないこと）', () => {
  it('暗号文の読み出しは token 無しで 401', async () => {
    const room = await makeRoom()
    expect((await bare(`/api/rooms/${room.roomId}/blob`)).status).toBe(401)
  })

  it('偽の token でも 401', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}/blob`, {
      headers: { Authorization: 'Bearer にせもの' },
    })
    expect(res.status).toBe(401)
  })

  it('暗号文の書き込みも token 無しで 401', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}/blob`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: 'QUJDRA==', iv: 'AAAAAAAAAAAAAAAA', blobVersion: 1, baseRev: 1 }),
    })
    expect(res.status).toBe(401)
  })

  it('WebSocket は token 無しでは開かない', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}/ws`, { headers: { Upgrade: 'websocket' } })
    expect(res.status).not.toBe(101)
  })

  it('入室は合言葉から作った鍵が要る（違えば入れない）', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    })
    expect(res.status).not.toBe(200)
  })

  it('削除も合言葉が要る（違えば消えない）', async () => {
    const room = await makeRoom()
    const res = await bare(`/api/rooms/${room.roomId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    })
    expect(res.status).not.toBe(200)
    // 消えていないこと（応答の形でなく、実際に残っているかで見る）
    expect((await bare(`/api/rooms/${room.roomId}/salt`)).status).toBe(200)
  })
})
