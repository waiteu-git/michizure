/**
 * API の宛先。
 *
 * ⚠ **このファイルは DOM に触れない。** テストが型のために `api.ts` を読み、
 * その先でここまで引き込まれるため、`location` 等を書くと Worker 側の型検査が落ちる
 * （`localStorage` で一度踏んだのと同じ形）。DOM を使う判定は `origins.ts` に置く。
 *
 * Web で配信する時は**空文字**＝相対パスのまま（同一オリジンなので CORS も要らない）。
 * ネイティブのシェルに入れると画面の出所が `capacitor://localhost` 等になり、
 * **相対パスの `/api/...` はシェル自身を指してしまう**ので、起動時に配信元を入れる。
 *
 * ⚠ 入れた瞬間に API 呼び出しは別オリジンになる＝**Worker 側の CORS が要る**
 * （`types.ts` の `ALLOWED_SHELL_ORIGINS`）。片方だけだと通信が全て黙って落ちる。
 */
let apiBase = ''

export function setApiBase(origin: string): void {
  apiBase = origin.replace(/\/+$/, '')
}

export function getApiBase(): string {
  return apiBase
}
