import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 🔴 `@revenuecat/purchases-capacitor` は Capacitor のネイティブブリッジを呼ぶので、
 * vitest（Node）では動かない。**SDK 自体はモックし、こちらのロジック（判定・失敗の扱い・
 * Web では何もしない）だけを検査する。**
 */
const configure = vi.fn()
const getCustomerInfo = vi.fn()
const getOfferings = vi.fn()
const purchasePackage = vi.fn()
const restorePurchases = vi.fn()

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    configure: (...a: unknown[]) => configure(...a),
    getCustomerInfo: (...a: unknown[]) => getCustomerInfo(...a),
    getOfferings: (...a: unknown[]) => getOfferings(...a),
    purchasePackage: (...a: unknown[]) => purchasePackage(...a),
    restorePurchases: (...a: unknown[]) => restorePurchases(...a),
  },
}))

const KEYS = { ios: 'ios_key', android: 'android_key' }
const active = (on: boolean) => ({
  customerInfo: { entitlements: { active: on ? { export: {} } : {} } },
})

beforeEach(() => {
  vi.resetModules()
  configure.mockReset().mockResolvedValue(undefined)
  getCustomerInfo.mockReset()
  getOfferings.mockReset()
  purchasePackage.mockReset()
  restorePurchases.mockReset()
  delete (globalThis as { window?: unknown }).window
})

/** Capacitor 環境を模す */
function enterShell(platform: 'ios' | 'android') {
  ;(globalThis as any).window = { Capacitor: { getPlatform: () => platform } }
}

describe('Web 配信（Capacitor が無い）', () => {
  it('configure を一度も呼ばない。判定は常に false、購入は failed', async () => {
    ;(globalThis as any).window = {}
    const { hasExportEntitlement, purchaseExport, restore } = await import('../src/client/billing')
    expect(await hasExportEntitlement(KEYS)).toBe(false)
    expect(await purchaseExport(KEYS)).toBe('failed')
    expect(await restore(KEYS)).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })
})

describe('ネイティブのシェルの中', () => {
  it('iOS では ios のキーで configure する', async () => {
    enterShell('ios')
    getCustomerInfo.mockResolvedValue(active(false))
    const { hasExportEntitlement } = await import('../src/client/billing')
    await hasExportEntitlement(KEYS)
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'ios_key' }))
  })

  it('Android では android のキーで configure する', async () => {
    enterShell('android')
    getCustomerInfo.mockResolvedValue(active(false))
    const { hasExportEntitlement } = await import('../src/client/billing')
    await hasExportEntitlement(KEYS)
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'android_key' }))
  })

  it('appUserID を渡さない（匿名ID＝端末帰属の裁定どおり）', async () => {
    enterShell('ios')
    getCustomerInfo.mockResolvedValue(active(false))
    const { hasExportEntitlement } = await import('../src/client/billing')
    await hasExportEntitlement(KEYS)
    const arg = configure.mock.calls[0][0]
    expect('appUserID' in arg).toBe(false)
  })

  it('configure は一度だけ（2回目の呼び出しでは呼ばない）', async () => {
    enterShell('ios')
    getCustomerInfo.mockResolvedValue(active(false))
    const { hasExportEntitlement } = await import('../src/client/billing')
    await hasExportEntitlement(KEYS)
    await hasExportEntitlement(KEYS)
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it('権利を持っていれば true', async () => {
    enterShell('ios')
    getCustomerInfo.mockResolvedValue(active(true))
    const { hasExportEntitlement } = await import('../src/client/billing')
    expect(await hasExportEntitlement(KEYS)).toBe(true)
  })

  it('権利が無ければ false', async () => {
    enterShell('ios')
    getCustomerInfo.mockResolvedValue(active(false))
    const { hasExportEntitlement } = await import('../src/client/billing')
    expect(await hasExportEntitlement(KEYS)).toBe(false)
  })

  it('通信の失敗は「持っている」にしない（過大な権利を与えない）', async () => {
    enterShell('ios')
    getCustomerInfo.mockRejectedValue(new Error('network'))
    const { hasExportEntitlement } = await import('../src/client/billing')
    expect(await hasExportEntitlement(KEYS)).toBe(false)
  })

  it('APIキーが空文字なら configure せず false（設定漏れで嘘の権利を出さない）', async () => {
    enterShell('ios')
    const { hasExportEntitlement } = await import('../src/client/billing')
    expect(await hasExportEntitlement({ ios: '', android: 'a' })).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })

  describe('購入', () => {
    it('オファリングが無ければ no_offering', async () => {
      enterShell('ios')
      getOfferings.mockResolvedValue({ current: null })
      const { purchaseExport } = await import('../src/client/billing')
      expect(await purchaseExport(KEYS)).toBe('no_offering')
      expect(purchasePackage).not.toHaveBeenCalled()
    })

    it('購入が通れば purchased', async () => {
      enterShell('ios')
      const pkg = { identifier: 'export' }
      getOfferings.mockResolvedValue({ current: { availablePackages: [pkg] } })
      purchasePackage.mockResolvedValue(active(true))
      const { purchaseExport } = await import('../src/client/billing')
      expect(await purchaseExport(KEYS)).toBe('purchased')
      expect(purchasePackage).toHaveBeenCalledWith({ aPackage: pkg })
    })

    it('利用者がキャンセルすると cancelled（失敗と区別する）', async () => {
      enterShell('ios')
      getOfferings.mockResolvedValue({ current: { availablePackages: [{ identifier: 'export' }] } })
      purchasePackage.mockRejectedValue({ code: '1' }) // PURCHASE_CANCELLED_ERROR
      const { purchaseExport } = await import('../src/client/billing')
      expect(await purchaseExport(KEYS)).toBe('cancelled')
    })

    it('それ以外の失敗は failed（黙って落とさない＝呼び出し側が理由を出せる）', async () => {
      enterShell('ios')
      getOfferings.mockResolvedValue({ current: { availablePackages: [{ identifier: 'export' }] } })
      purchasePackage.mockRejectedValue({ code: '2' })
      const { purchaseExport } = await import('../src/client/billing')
      expect(await purchaseExport(KEYS)).toBe('failed')
    })
  })

  describe('復元', () => {
    it('復元して権利があれば true', async () => {
      enterShell('android')
      restorePurchases.mockResolvedValue(active(true))
      const { restore } = await import('../src/client/billing')
      expect(await restore(KEYS)).toBe(true)
    })

    it('復元しても権利が無ければ false（購入履歴が無い）', async () => {
      enterShell('android')
      restorePurchases.mockResolvedValue(active(false))
      const { restore } = await import('../src/client/billing')
      expect(await restore(KEYS)).toBe(false)
    })
  })
})
