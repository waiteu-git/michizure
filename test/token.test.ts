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
})
