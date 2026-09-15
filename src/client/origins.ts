import { getApiBase, setApiBase } from './config.ts'

/**
 * 起動時に配信元を決める。⚠ ブラウザからしか呼ばない。
 *
 * HTML の `<meta name="michizure-api-base">` を見る。Web 配信では空のままで、
 * ネイティブのシェルに入れる時だけ、そこへ配信元のオリジンを入れて焼く。
 * **ビルド時の置換に頼らない**＝配られた成果物を開けば宛先が読める方が、
 * 「どこへ繋いでいるか」を後から確かめられる。
 */
export function initOrigins(): void {
  const meta = document.querySelector('meta[name="michizure-api-base"]')
  const configured = meta?.getAttribute('content')?.trim()
  if (configured) setApiBase(configured)
}

/**
 * 人に渡す共有URL の元。
 * ⚠ シェルの中で `location.origin` を使うと `capacitor://localhost/r/...` という
 * **人に渡せない値**になる。配信元が分かっているならそちらを使う。
 */
export function shareOrigin(): string {
  return getApiBase() || location.origin
}

/** WebSocket の宛先 */
export function wsOrigin(): string {
  return (getApiBase() || location.origin).replace(/^http/, 'ws')
}

/**
 * RevenueCat の公開APIキー（`<meta>` から読む。焼き込みは `build-html.mjs`）。
 * Web 配信では両方空のまま＝`billing.ts` はこれを渡されても configure しない。
 */
export function billingKeys(): { ios: string; android: string } {
  const read = (name: string) =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? ''
  return {
    ios: read('michizure-revenuecat-ios-key'),
    android: read('michizure-revenuecat-android-key'),
  }
}
