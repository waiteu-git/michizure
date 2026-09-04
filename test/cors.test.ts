import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { allowedOrigin, ALLOWED_SHELL_ORIGINS } from '../src/types'

/**
 * 🔴 CORS は「足したか」ではなく「**絞れているか**」が要点。
 * 要求された Origin をそのまま返す（反射する）と全開と同じで、
 * 誰のページからでも部屋を叩けるようになる。
 */
describe('許可オリジンの判定', () => {
  it('一覧にあるものだけ通す', () => {
    for (const o of ALLOWED_SHELL_ORIGINS) expect(allowedOrigin(o)).toBe(o)
  })

  it('一覧に無いものは通さない', () => {
    for (const o of [
      'https://evil.example',
      'http://localhost:3000', // ポート違いは別オリジン
      'https://localhost', // scheme 違いも別オリジン
      'capacitor://evil',
      'null',
      '',
    ]) {
      expect(allowedOrigin(o)).toBeNull()
    }
  })

  it('Origin が無ければ通さない', () => {
    expect(allowedOrigin(null)).toBeNull()
  })
})

describe('実際の応答', () => {
  it('許可オリジンには許可を返す', async () => {
    const res = await SELF.fetch('https://example.com/api/health', {
      headers: { Origin: 'capacitor://localhost' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    // ⚠ 中間キャッシュがオリジンごとに分けられるように
    expect(res.headers.get('Vary')).toContain('Origin')
  })

  // これが落ちたら「全開」になっている
  it('知らないオリジンには許可を返さない', async () => {
    const res = await SELF.fetch('https://example.com/api/health', {
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('preflight は許可オリジンにだけ答える', async () => {
    const ok = await SELF.fetch('https://example.com/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost' },
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')

    const ng = await SELF.fetch('https://example.com/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    })
    expect(ng.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  // 同一オリジン（Origin ヘッダ無し）の Web 配信を壊していないこと
  it('Origin が無い普通の要求はこれまでどおり通る', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
