/**
 * RevenueCat 統合（Shipaton 提出向け）。
 *
 * 🔴 **ネイティブのシェルの中でしか動かない。** Web 配信では有料機能そのものを出さない。
 * これは技術的な制約ではなく設計判断——「誰に対して課金するのか」が Web では定義できない
 * （`docs/shipaton-revenuecat-findings.md`）。**9/4 ユーザー裁定＝課金の帰属は端末**
 * （RevenueCat の匿名 ID）で、**サーバーに課金状態を持たせない**。この関数群がサーバーへ
 * 一切通信しないのはその帰結——有料機能の実体（`csv.ts`）も端末の中で完結する。
 *
 * ⚠ **遅延読み込みが前提。** `@revenuecat/purchases-capacitor` は内部で `@capacitor/core` を
 * 使うため、他の重い機能（`passphrase.ts`・`qr.ts`）と同じく、呼び出し側が動的 `import()` で
 * 運ぶこと。トップレベルで import すると Web 配信のバンドルにも含まれてしまう。
 */
import { Purchases } from '@revenuecat/purchases-capacitor'

export const EXPORT_ENTITLEMENT_ID = 'export'

/** プラットフォームごとの公開APIキー。RevenueCat ダッシュボードで発行する（ユーザーの手） */
export type BillingKeys = { ios: string; android: string }

let configured = false

/** ⚠ `@capacitor/core` を import しない＝グローバルの有無だけで判定する既存パターンに合わせる */
function platform(): 'ios' | 'android' | null {
  const cap = (globalThis as { window?: { Capacitor?: { getPlatform?: () => string } } }).window
    ?.Capacitor
  if (!cap) return null
  const p = cap.getPlatform?.()
  return p === 'ios' || p === 'android' ? p : null
}

/**
 * ⚠ **一度しか configure しない。** 呼ぶたびに SDK を再初期化すると、
 * 端末に残る RevenueCat のキャッシュ（圏外判定の土台）が壊れうる。
 */
async function ensureConfigured(keys: BillingKeys): Promise<boolean> {
  if (configured) return true
  const p = platform()
  if (!p) return false
  const apiKey = p === 'ios' ? keys.ios : keys.android
  if (!apiKey) return false
  try {
    // appUserID は渡さない＝匿名ID（9/4裁定「端末帰属」。機種変で失う代わりに
    // アカウントを持たない設計を崩さない）
    await Purchases.configure({ apiKey })
    configured = true
    return true
  } catch {
    return false
  }
}

/**
 * 権利の判定。**圏外でも動く**——SDK はキャッシュされた CustomerInfo を返す
 * （RevenueCat 公式ドキュメント）ので、旅先で電波が無くても書き出しボタンの活性/非活性は決まる。
 * ⚠ 通信に失敗しても「持っている」にしない。過大な権利を与えるより、
 * 権利があるのに一時的に使えない方が安全（正規の利用者は電波が戻れば直る）。
 */
export async function hasExportEntitlement(keys: BillingKeys): Promise<boolean> {
  if (!(await ensureConfigured(keys))) return false
  try {
    const { customerInfo } = await Purchases.getCustomerInfo()
    return Boolean(customerInfo.entitlements.active[EXPORT_ENTITLEMENT_ID])
  } catch {
    return false
  }
}

export type PurchaseResult = 'purchased' | 'cancelled' | 'no_offering' | 'failed'

/**
 * ⚠ **失敗を握り潰さない**（`app.ts` の `lazy()` と同じ規律）。
 * 「キャンセルした」と「壊れて買えなかった」を区別しないと、利用者は理由が分からないまま
 * 何度も同じボタンを押すことになる。
 */
export async function purchaseExport(keys: BillingKeys): Promise<PurchaseResult> {
  if (!(await ensureConfigured(keys))) return 'failed'
  try {
    const { current } = await Purchases.getOfferings()
    const pkg = current?.availablePackages[0]
    if (!pkg) return 'no_offering'
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg })
    return customerInfo.entitlements.active[EXPORT_ENTITLEMENT_ID] ? 'purchased' : 'failed'
  } catch (e) {
    // PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR = "1"
    if ((e as { code?: string })?.code === '1') return 'cancelled'
    return 'failed'
  }
}

/**
 * 機種変・再インストールで購入を引き継ぐ唯一の手段（端末帰属の代償を埋める導線）。
 * `docs/shipaton-native-shell-estimate.md` の「復元導線を最初から入れる」に対応。
 */
export async function restore(keys: BillingKeys): Promise<boolean> {
  if (!(await ensureConfigured(keys))) return false
  try {
    const { customerInfo } = await Purchases.restorePurchases()
    return Boolean(customerInfo.entitlements.active[EXPORT_ENTITLEMENT_ID])
  } catch {
    return false
  }
}
