import { describe, it, expect } from 'vitest'
import { createErrorMessage, CREATE_ERROR_COPY } from '../src/client/create-error-copy'

describe('部屋作成の失敗文言', () => {
  it('速度制限・カウンタ不調は、識別子でなく待てば直ると分かる文になる', () => {
    expect(createErrorMessage('rate_limited')).toContain('もう一度')
    expect(createErrorMessage('rate_limited')).not.toContain('rate_limited')
    expect(createErrorMessage('limiter_unavailable')).toContain('もう一度')
    expect(createErrorMessage('limiter_unavailable')).not.toContain('limiter_unavailable')
  })
  it('表に無いものは識別子を握りつぶさず、従来どおりの形で出す', () => {
    expect(createErrorMessage('HTTP 500')).toBe('作成に失敗しました: HTTP 500')
  })
  it('サーバーが返しうる2つの識別子は両方とも表にある', () => {
    expect(Object.keys(CREATE_ERROR_COPY).sort()).toEqual(['limiter_unavailable', 'rate_limited'])
  })
})
