import { describe, it, expect } from 'vitest'
import { generateRoomId, issueToken, verifyToken } from '../src/token'

const SECRET = 'test-secret'
const NOW = 1_700_000_000_000

describe('部屋ID', () => {
  it('16文字で生成される', () => {
    expect(generateRoomId()).toHaveLength(16)
  })

  it('毎回異なる', () => {
    expect(new Set(Array.from({ length: 100 }, () => generateRoomId())).size).toBe(100)
  })

  it('紛らわしい文字を含まない', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRoomId()).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/)
    }
  })
})

describe('アクセストークン', () => {
  it('発行したトークンを検証できる', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM0000ROOM0000', SECRET, NOW + 1000)).toBe(true)
  })

  it('期限切れを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM0000ROOM0000', SECRET, NOW + 60_001)).toBe(false)
  })

  it('別の部屋のトークンを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    expect(await verifyToken(t, 'ROOM9999ROOM9999', SECRET, NOW)).toBe(false)
  })

  it('改ざんされたトークンを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', SECRET, 60_000, NOW)
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')
    expect(await verifyToken(tampered, 'ROOM0000ROOM0000', SECRET, NOW)).toBe(false)
  })

  // 計画には無いが追加した。別の署名鍵で作られたトークンが通らないことは
  // 本番シークレットを設定し忘れた時に効く不変条件なので固定する
  it('別のシークレットで署名されたトークンを拒否する', async () => {
    const t = await issueToken('ROOM0000ROOM0000', 'another-secret', 60_000, NOW)
    expect(await verifyToken(t, 'ROOM0000ROOM0000', SECRET, NOW)).toBe(false)
  })

  // 計画には無いが追加した。ここが崩れると WebSocket が「ときどき 401」になり、
  // 症状（WS が繋がらない）から原因（署名の符号化）まで距離があって追いにくい。
  // 標準 base64 だと `+` がクエリ文字列で空白に化ける
  it('クエリ文字列を往復しても検証できる', async () => {
    for (let i = 0; i < 200; i++) {
      const roomId = generateRoomId()
      const token = await issueToken(roomId, SECRET, 60_000, NOW)
      const url = new URL(`https://example.com/api/rooms/${roomId}/ws?token=${token}`)
      const roundTripped = url.searchParams.get('token') ?? ''
      expect(roundTripped).toBe(token)
      expect(await verifyToken(roundTripped, roomId, SECRET, NOW)).toBe(true)
    }
  })

  it('URLで安全な文字だけで構成される', async () => {
    for (let i = 0; i < 50; i++) {
      const t = await issueToken(generateRoomId(), SECRET, 60_000, NOW)
      expect(t).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })
})
