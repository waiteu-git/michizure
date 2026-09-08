// 認証なしで叩ける面（公開面）を数えて、増えたら落とす。
//
// 🔴 なぜ要るか（2026-09-09・前身 travel-calculation の事故から）:
// 前身は `travel.waiteu.dev/api/data` が**認証なしで第三者の氏名と旅費を返したまま**
// 稼働していた。真因は「ログの不在」ではなく**「認証の不在」**。しかも発見は偶然で、
// 気づいた時には被害範囲を確定する手段が無かった（アクセスログが対象期間を覆っていない）。
//
// ⚠ この種の穴は**コードのレンズでは出ない**。「動いているサービスの露出面」だから。
// ⇒ 経路を足した人が、その経路の認証の有無を**明示的に宣言するまで**ビルドを止める。
//
// ⚠ この検査は「宣言と実装の一致」までは見ない。ふるまいの検査は
// test/public-surface.test.ts が実際に叩いて確かめる。両方が要る。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/index.ts'), 'utf8')

/**
 * 認証なしで到達できてよい経路。**増やす時は、なぜ認証が要らないかをここに書く。**
 * 「書けない」なら、それは認証が要るということ。
 */
const PUBLIC_BY_DESIGN = {
  '/api/health':
    '生存確認。部屋にも中身にも触れない。返すのは {ok:true} だけ',
  '/api/rooms(POST)':
    '部屋を作る。作る前なので認証しようがない。⚠ 誰でも作れる＝濫用の対象なので、上限と TTL で抑える',
  '/api/rooms/<id>/salt(GET)':
    'ソルトと反復回数と正規化の版。**鍵を作る前に要る**ので認証できない（設計 §7.6）。' +
    '⚠ 部屋の存在は漏れる（実在=200 / 不在=404）。部屋IDは 36^16 なので総当たりは成立しない。' +
    '⚠ ソルトだけでは何も開けない。暗号文は token 必須の /blob にしか無い',
  '/r/<id>(GET)':
    'アプリの殻を返すだけ。部屋の中身は含まない（共有された URL が開けないと製品が成立しない）',
}

/** 認証・合言葉が要る経路。ここに在るものは、認証なしで 2xx を返してはいけない */
const GUARDED = {
  '/api/rooms/<id>/blob(GET,PUT)': 'Authorization: Bearer のトークン',
  '/api/rooms/<id>/ws(GET)': 'クエリのトークン',
  '/api/rooms/<id>/enter(POST)': '合言葉から作った authKey（本文）',
  '/api/rooms/<id>(DELETE)': '合言葉から作った authKey（本文）',
}

// 実装から経路を拾う。⚠ 数え方を変えたら、この抽出も見直すこと
const literal = [...src.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1])
const matched = [...src.matchAll(/url\.pathname\.match\(\/\^([^/]*(?:\\\/[^/]*)*)\$\//g)].map(
  (m) => m[1],
)
const tested = [...src.matchAll(/\/\^([^/]*(?:\\\/[^/]*)*)\$\/\.test\(url\.pathname\)/g)].map(
  (m) => m[1],
)
const found = literal.length + matched.length + tested.length
const declared = Object.keys(PUBLIC_BY_DESIGN).length + Object.keys(GUARDED).length

if (found !== declared) {
  console.error(
    `✘ 経路の数が宣言と合わない: 実装 ${found} 件 / 宣言 ${declared} 件\n` +
      `  実装から拾った: ${[...literal, ...matched, ...tested].join(' , ')}\n` +
      `  ⇒ 経路を足したなら、scripts/check-public-surface.mjs の PUBLIC_BY_DESIGN か GUARDED へ、\n` +
      `     **なぜ認証が要らないか／何で守るか**を書いて足すこと。書けないなら認証を足す。`,
  )
  process.exit(1)
}

console.log(
  `公開面: 認証なしで到達してよい ${Object.keys(PUBLIC_BY_DESIGN).length} 件 / ` +
    `守られている ${Object.keys(GUARDED).length} 件（実装の経路 ${found} 件と一致）`,
)
