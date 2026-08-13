/**
 * 合言葉の単語リストを作る（設計 §7.6・2026-08-11 裁定＝1,024語×5語）。
 *
 *   node scripts/build-wordlist.mjs
 *
 * 出力:
 *   wordlist/michizure-ja-1024.txt … 製品に同梱するリスト
 *   wordlist/review.md             … 人手で全語を通すための一覧（不快語・馴染みのない語を落とす）
 *
 * 🔴 このリストは「口頭で伝えられて、聞き間違えず、書き取れる」ことが要件。
 * 条件はすべて機械で検査する。人手でしか判定できないのは【不快語】と【親しみやすさ】だけ。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 1024

// 🔴 取り込み時に NFC へ正規化する。BIP-39 の実体は NFKD で、644語が結合濁点を含む
const source = readFileSync(join(root, 'wordlist/source/bip39-japanese.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((w) => w.trim().normalize('NFC'))
  .filter(Boolean)

const SMALL = 'ゃゅょぁぃぅぇぉゎ'
const HIRAGANA = /^[ぁ-ゖ]+$/

/** 拍数。小書き仮名は前の字とセットで1拍（「っ」は1拍として数える） */
const mora = (w) => [...w].filter((c) => !SMALL.includes(c)).length

/** 濁点・半濁点を剥がした形。「かき」と「かぎ」を同居させないための鍵 */
const stripVoicing = (w) =>
  [...w.normalize('NFD')].filter((c) => c !== '゙' && c !== '゚').join('').normalize('NFC')

/** 小書き仮名を並書きに畳んだ形。「きゃく」と「きやく」を同居させないための鍵 */
const foldSmall = (w) =>
  [...w].map((c) => (SMALL.includes(c) ? String.fromCharCode(c.charCodeAt(0) + 1) : c)).join('')

/** 聞き取りで潰れる音を揃えた鍵（おう→おお・えい→ええ・ぢ→じ・づ→ず） */
const phoneticKey = (w) =>
  foldSmall(stripVoicing(w))
    .replace(/おう/g, 'おお')
    .replace(/えい/g, 'ええ')
    .replace(/ぢ/g, 'じ')
    .replace(/づ/g, 'ず')

/**
 * 人手の工程で落とした語（不快語・馴染みのない語）。
 * ⚠ 一度落とした語は二度と入れない＝このファイルは追記のみ。
 */
const rejectedPath = join(root, 'wordlist/rejected.txt')
const rejected = new Set(
  existsSync(rejectedPath)
    ? readFileSync(rejectedPath, 'utf8')
        .split('\n')
        .map((l) => l.replace(/^\s*x?\s*/, '').split('#')[0].trim().normalize('NFC'))
        .filter(Boolean)
    : [],
)

const stats = {}
const count = (name) => (stats[name] = (stats[name] ?? 0) + 1)

// --- 単語単体で判定できる条件 ---
let pool = source.filter((w) => {
  if (rejected.has(w)) return count('人手の工程で落とした'), false
  if (!HIRAGANA.test(w)) return count('ひらがな以外を含む'), false
  if (w.includes('ー')) return count('長音記号を含む'), false
  if (w.length < 3 || w.length > 5) return count('文字数が3〜5の外'), false
  if (mora(w) < 3) return count('2拍以下（聞き分けにくい）'), false
  return true
})

// --- 語どうしの関係で判定する条件 ---
// ⚠ 衝突は「どちらを残すか」で結果が変わるので、順序を固定して決定的にする。
// あいうえお順にするのは、素材の性格をそのまま引き継ぐため
pool.sort((a, b) => a.localeCompare(b, 'ja'))

const takenPrefix = new Set() // 先頭3文字（これが一意なら prefix-free も X+い の共存も自動的に消える）
const takenVoicing = new Set() // 濁点を剥がした形
const takenPhonetic = new Set() // 音韻キー

const accepted = []
for (const w of pool) {
  const p3 = w.slice(0, 3)
  if (takenPrefix.has(p3)) {
    count('先頭3文字が他語と同じ')
    continue
  }
  const v = stripVoicing(w)
  if (takenVoicing.has(v)) {
    count('濁点を取ると他語と同型')
    continue
  }
  const k = phoneticKey(w)
  if (takenPhonetic.has(k)) {
    count('聞き取りで他語と潰れる')
    continue
  }
  takenPrefix.add(p3)
  takenVoicing.add(v)
  takenPhonetic.add(k)
  accepted.push(w)
}

// --- 1,024語を選ぶ ---
// ⚠ 「短い語を優先」は採らない。打鍵は軽くなるが、**口頭では長い語のほうが聞き分けやすい**
// （冗長性が高い）ので、短さを優先する根拠が無い。どちらに寄せる証拠も無いので、
// 全体から等間隔に取って**素材の語長分布をそのまま保つ**。品質の選別は人手の工程で行う。
const stride = accepted.length / TARGET
const selectedIdx = new Set(Array.from({ length: TARGET }, (_, i) => Math.floor(i * stride)))
const selected = accepted.filter((_, i) => selectedIdx.has(i))
const spare = accepted.filter((_, i) => !selectedIdx.has(i))

writeFileSync(join(root, 'wordlist/michizure-ja-1024.txt'), selected.join('\n') + '\n')

// 機械が読む版も同じ工程で作る。⚠ 人が読む .txt と別々に作ると必ずズレるので、
// 出所を1つにして両方をここから出す（一致は scripts/check-wordlist.mjs が検査する）
writeFileSync(
  join(root, 'src/client/wordlist-data.ts'),
  `// 自動生成。直接編集しない（npm run build:wordlist で作り直す）\n` +
    `// 出所: wordlist/michizure-ja-1024.txt\n` +
    `export const WORDS = ${JSON.stringify(selected)} as const\n`,
)

const byLen = (list) =>
  [3, 4, 5].map((n) => `${n}字 ${list.filter((w) => w.length === n).length}`).join(' / ')

writeFileSync(
  join(root, 'wordlist/review.md'),
  `# 合言葉の単語リスト — 人手で通すための一覧

**機械で検査できる条件は全て通っている。ここで見るのは2つだけ。**

1. **不快語・攻撃的な語・差別的な語**（生成された5語の並びが失礼な句になる事故も含む）
2. **馴染みのない語**（読めない・意味が浮かばない語は、口頭で伝わらない）

落とす語には行頭に \`x\` を付けて、\`wordlist/rejected.txt\` に書き出してください。
再生成すると予備（下記）から自動で補充されます。

- 採用: **${selected.length}語**（${byLen(selected)}）
- 予備: ${spare.length}語（採用が減ったときの補充元）

⚠ **人・身体・病気・宗教・国籍に関する語はカテゴリごと落とすのが安い**（数百語減らすだけで
事故の面積が大きく減る。予備が${spare.length}語あるので吸収できる）。

---

${selected.map((w, i) => `${String(i + 1).padStart(4)}. ${w}`).join('\n')}

---

## 予備（採用が減ったときにここから補充される）

${spare.join(' / ')}
`,
)

console.log(`素材: ${source.length}語（NFC 正規化済み）`)
console.log('--- 落とした理由と件数 ---')
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`)
}
console.log(`--- 条件を全て満たした: ${accepted.length}語（${byLen(accepted)}）`)
console.log(`--- 採用 ${selected.length}語（${byLen(selected)}） / 予備 ${spare.length}語`)
console.log(`例: ${selected.slice(0, 5).join('・')}`)
