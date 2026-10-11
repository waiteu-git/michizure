/**
 * 部屋を作れなかった時に利用者へ見せる文言。
 *
 * サーバーは英語の識別子（`rate_limited`・`limiter_unavailable`）を返す。それをそのまま見せると
 * 何が起きたか・待てば直るのかが分からない。ここで文に直す。
 *
 * ⚠ 仮の既定＝選択肢A（2026-10-11）。文言は本人と一緒に決める案件で、10/17 に A/B/C を裁定する
 *   （`~/dev/michizure-error-copy-options-2026-10-06.md`）。切り替えは **ここの表だけ**。
 *   PP・規約はこの文を引用していない（check-pp-ui-quotes の一覧に無い）。
 */
export const CREATE_ERROR_COPY: Record<string, string> = {
  rate_limited: 'いま部屋を作る人が多いようです。少し待ってから、もう一度お試しください。',
  limiter_unavailable: 'いま部屋を作れません。しばらくしてから、もう一度お試しください。',
}

/** 表に無いものは今までどおり（`作成に失敗しました: …`）。識別子を黙って握りつぶさない */
export function createErrorMessage(raw: string): string {
  return CREATE_ERROR_COPY[raw] ?? `作成に失敗しました: ${raw}`
}
