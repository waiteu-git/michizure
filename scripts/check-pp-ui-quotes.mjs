// プライバシーポリシー・利用規約が「画面にこう出る」と**一字一句引用している文言**が、今も実装にあるか。
//
// 🔴 なぜ要るか（2026-09-11）: PP §7 が、トークン期限切れの表示を画面の文言そのままで引用した
// （fd4143f）。その文言はまだ仮で、利用者と一緒に決め直す予定＝**画面の文言を変えた瞬間に
// PP が「こう表示されます」と嘘をつく**。PP は実装の消費者で、同じ形の食い違いは今週だけで
// 何度も起きている（保存項目は check-stored-fields / check-pp-rows が見ている。文言はここが見る）。
//
// 見るのは両方向:
// - 一覧の文言が PP・規約のどちらにも無い ⇒ PP 側で引用が消えた・変わった＝一覧を直す
// - 一覧の文言が実装（コメントを除く）に無い ⇒ 画面の文言が変わった＝**PP が偽**＝BH へ
// ⚠ 一覧は手で持つ。PP が新しく画面の文言を引用したら、ここへ足す（自動抽出は、折り返しと
//   コメント中の一致で誤検出が多く、使えなかった）。
//
// 使い方: node scripts/check-pp-ui-quotes.mjs [ルート]   ※ルートの指定は対照を当てる時だけ
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * PP・規約が画面の文言として引用しているもの（引用している箇所・種類）。
 * 種類 'button' は**ボタンの名前そのもの**として照合する（`>名前</button>`）。
 * ⚠ 部分一致だけだと、ボタンの名前が別の文（状態欄やトースト）にも含まれる時に、
 *   ボタンだけ変えても素通りする（「合言葉で入り直す」「この端末から消す」がそうだった＝
 *   2026-09-11 の多観点照合で指摘）。
 */
const QUOTES = [
  ['接続の期限が切れています。合言葉で入り直すと同期を再開します（この端末には保存されています）', 'PP §7', 'text'],
  ['合言葉で入り直す', 'PP §7', 'button'],
  ['この旅行はサーバーから削除されています。この端末の控えだけが残っています', 'PP §7', 'text'],
  ['見つかりません（削除された可能性があります）', 'PP §7', 'text'],
  ['この端末から消す', 'PP §2.1・§7／規約', 'button'],
]
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ⚠ 文書は折り返してあるので、改行と行頭の字下げを詰めてから探す（詰めないと長い引用が見つからない）
const flat = (s) => s.replaceAll('**', '').replace(/\n[ \t]*/g, '')
// ⚠ PP・規約の下書きは公開リポジトリに含めない（履歴からも除外済み）＝公開クローンには無い。
// 「見られなかった」と明示して通す（黙って通さない）
const docPaths = ['docs/legal/privacy-policy.draft.md', 'docs/legal/terms.draft.md'].map((f) => join(root, f))
if (!docPaths.every((f) => existsSync(f))) {
  console.log('PP・規約の引用の照合: 省略（docs/legal/*.draft.md は公開リポジトリに含まれない）')
  process.exit(0)
}
const docs = flat(docPaths.map((f) => readFileSync(f, 'utf8')).join(''))
// ⚠ コメントは除く。除かないと、説明に書いた文言が「画面にある」と数えられる
const src =
  readFileSync(join(root, 'src/client/app.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '') +
  readFileSync(join(root, 'src/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

let bad = false
for (const [text, where, kind] of QUOTES) {
  if (!docs.includes(text)) {
    console.error(
      `✘ 一覧の「${text}」が PP・規約に無い（${where} の引用が消えた・変わった）\n` +
        `  ⇒ scripts/check-pp-ui-quotes.mjs の一覧を今の引用に合わせる`,
    )
    bad = true
  }
  const inUi = kind === 'button' ? new RegExp(`>\\s*${escapeRe(text)}\\s*</button>`).test(src) : src.includes(text)
  if (!inUi) {
    console.error(
      `✘ ${where} が画面の文言として引用している「${text}」が、実装に${kind === 'button' ? 'ボタンの名前として' : ''}無い\n` +
        `  ⇒ 画面の文言を変えたなら、**PP が偽になっている**＝ビジネスハブへ連絡して引用を直してもらう`,
    )
    bad = true
  }
}
if (bad) process.exit(1)
console.log(`PP・規約が引用している画面の文言: ${QUOTES.length} 件とも実装にある`)
