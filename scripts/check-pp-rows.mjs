// 保存項目の宣言（src/server-stored-fields.ts / src/client/device-stored-fields.ts）が指す PP の行と、
// プライバシーポリシーの表に実在する行が、過不足なく一致するかを見る。
//
// 🔴 なぜ要るか（2026-09-11）: 宣言は「実装が何を持つか」を実物と照合できるが、宣言と PP の対応は
// 自由文の注記だったので誰も照合していなかった。実際に、PP 側が直った（cb7a683）あとも
// 宣言の注記は「PP に未記載・要修正」と言い続け、逆向きにも起きうる形だった:
// - 実装から消した項目の行が PP に残る（1de692b の時点で「作成日時・最後に入室した日時」の行が残っていた）
// - 実装に足した項目の行が PP に無い（8a7e12f の時点で「書き込み回数を表す番号」の行が無かった）
// どちらも、ここを通すと落ちる（上の2つの版の PP で実際に落ちることを確かめてある）。
//
// ⚠ 見ているのは**行名の一致まで**。行の中身の文言が実装と合っているかは見られない＝人が読む。
// ⚠ PP の文言はビジネスハブ所管。ここが落ちたら宣言を直すか、PP の直しを BH へ頼む（勝手に PP を直さない）。
//
// 使い方: node scripts/check-pp-rows.mjs [PP のパス]   ※パスの指定は対照（別の版の PP）を当てる時だけ
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ppPath = process.argv[2] ?? join(root, 'docs/legal/privacy-policy.draft.md')
// ⚠ PP の下書きは公開リポジトリに含めない（履歴からも除外済み）＝公開クローンには無い。
// その時だけ「見られなかった」と明示して通す。パスを**明示した**のに無い場合は誤りなので落とす
if (process.argv[2] === undefined && !existsSync(ppPath)) {
  console.log('PP の行の照合: 省略（docs/legal/privacy-policy.draft.md は公開リポジトリに含まれない）')
  process.exit(0)
}
const { SERVER_STORED } = await import(join(root, 'src/server-stored-fields.ts'))
const { DEVICE_STORED } = await import(join(root, 'src/client/device-stored-fields.ts'))

/** PP の見出し `## <節>` から次の `## ` までにある表の1列目（太字を外す・見出し行と区切り行は除く） */
function rowsOf(md, section) {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${section} `))
  if (start < 0) return null
  const rows = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    const cell = line.split('|')[1].replaceAll('**', '').trim()
    if (cell === '保存するもの' || /^-+$/.test(cell)) continue
    rows.push(cell)
  }
  return rows
}

const md = readFileSync(ppPath, 'utf8')
const targets = [
  { section: '2.', label: 'PP §2（サーバー）', decl: SERVER_STORED.room, file: 'src/server-stored-fields.ts' },
  { section: '2.1', label: 'PP §2.1（端末）', decl: DEVICE_STORED, file: 'src/client/device-stored-fields.ts' },
]

let bad = false
const fail = (msg) => {
  console.error(`✘ ${msg}`)
  bad = true
}
const known = []

for (const t of targets) {
  const rows = rowsOf(md, t.section)
  if (rows === null || rows.length === 0) {
    fail(`${t.label} の見出しか表が見つからない（${ppPath}）＝節番号か表の形が変わった。この検査を直す`)
    continue
  }
  const claimed = new Map() // 行名 → それを指す宣言のキー
  for (const [key, item] of Object.entries(t.decl)) {
    const pp = item.PP ?? []
    if (pp.length === 0 && !item.PP未記載) {
      fail(`${t.file} の ${key} が PP のどの行も指していない＝PP に行を足すか、PP未記載 に理由を書く`)
    }
    if (item.PP未記載) known.push(`${key}: ${item.PP未記載}`)
    for (const row of pp) claimed.set(row, [...(claimed.get(row) ?? []), key])
  }
  for (const [row, keys] of claimed) {
    if (!rows.includes(row)) {
      fail(
        `${t.file} の ${keys.join(', ')} が ${t.label} の行「${row}」を指しているが、PP にその行が無い\n` +
          `  ⇒ 行名が変わっただけなら宣言の PP を追従させる。行が消えたなら**過少申告**の恐れ＝BH へ報告`,
      )
    }
  }
  for (const row of rows) {
    if (!claimed.has(row)) {
      fail(
        `${t.label} に行「${row}」があるが、どの保存項目もそれを指していない\n` +
          `  ⇒ 実装が持つなら ${t.file} の該当項目の PP へ足す（PP未記載 に書いていたなら移して消す）。\n` +
          `     持たないなら PP の**過大申告**＝BH へ報告`,
      )
    }
  }
}

if (bad) process.exit(1)
console.log(
  `PP の行と保存項目の宣言: 一致（§2・§2.1）` +
    (known.length ? `\n  ⚠ 既知の未記載 ${known.length} 件（PP に行が無いと分かっていて残しているもの）:\n` +
      known.map((k) => `    - ${k}`).join('\n') : ''),
)
