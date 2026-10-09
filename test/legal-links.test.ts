import { describe, expect, it } from 'vitest'
import { LEGAL_LINKS, legalLinksReady } from '../src/client/legal-links'

describe('PP・規約へのリンク', () => {
  it('両方が https の絶対URLの時だけ表示する', () => {
    expect(legalLinksReady({ privacy: 'https://example.com/p', terms: 'https://example.com/t' })).toBe(true)
  })
  it('空・片方だけ・http・相対・空白入りは表示しない（リンク先の無いリンクを出さない）', () => {
    for (const l of [
      { privacy: '', terms: '' },
      { privacy: 'https://example.com/p', terms: '' },
      { privacy: 'http://example.com/p', terms: 'https://example.com/t' },
      { privacy: '/privacy', terms: '/terms' },
      { privacy: 'https://example.com/a b', terms: 'https://example.com/t' },
    ]) {
      expect(legalLinksReady(l), JSON.stringify(l)).toBe(false)
    }
  })
  it('実際の設定は、空（未決）か、両方 https のどちらか', () => {
    const filled = [LEGAL_LINKS.privacy, LEGAL_LINKS.terms].filter(Boolean).length
    expect([0, 2]).toContain(filled)
  })
})
