import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('worker', () => {
  it('ヘルスチェックに応答する', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('DO バインディングが存在する', () => {
    expect(env.ROOM).toBeDefined()
  })
})
