/**
 * 🔴 プライバシーポリシー・利用規約へのリンク先（アプリ内の入口・部屋画面のフッターに出る）。
 *
 * PP §10 は「本ポリシーの記載をもって利用目的の通知に代える」と書く＝**アプリの画面から辿れる場所に
 * 置かれていることが前提**（2026-09-11 の照合で、アプリ内にリンクが0件と判明）。
 *
 * ⚠ URL は **未決**（公開の場所は 2026-10-17 の本人判断の回で決める）。決まったらここの2つを
 *   `https://…` で埋めるだけ。**空の間はフッター自体を出さない**（リンク先の無いリンクを出さない）。
 *   埋めたら PP・規約の公開（BH）と同時に出すこと＝PP が公開される前にリンクだけが生きない。
 */
export const LEGAL_LINKS: { privacy: string; terms: string } = {
  privacy: '',
  terms: '',
}

/** 両方が https の絶対URLで埋まっている時だけ表示する（片方だけ・http・相対は出さない） */
export function legalLinksReady(l: { privacy: string; terms: string } = LEGAL_LINKS): boolean {
  return [l.privacy, l.terms].every((u) => /^https:\/\/[^\s]+$/.test(u))
}
