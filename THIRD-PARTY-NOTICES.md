# サードパーティ表示（THIRD-PARTY NOTICES）

Michizure は第三者の著作物を**再配布する**。ここはその義務を果たすための場所。
リポジトリだけでなく**利用者へ配る JavaScript にも入る**ので、このファイルを消してはいけない。

> 🔴 **2026-09-05 の監査で発見**：この表示は**同日まで存在しなかった**。
> リポジトリのどこにも MIT の許諾文（`Permission is hereby granted...`）が無く、
> MIT に触れていたのは `wordlist/source/PROVENANCE.md`・`docs/passphrase-wordlist.md`・
> `README.draft.md` の散文だけだった。
> ⚠ 「ライセンスを確認した」と「表示を運んだ」は別の作業である。前者だけを済ませて
> 後者を落としたのが今回の抜け＝MIT の**唯一の条件**は「確認」ではなく「同梱」の側にある。
>
> ⚠ **ただし「義務に違反していた」わけではない。** 監査の初稿はここに
> 「2026-08-11 の取り込み以降ずっと再配布していた」と書いたが、**これは言い過ぎで同日に訂正した**。
> MIT の条件が働くのは**複製が第三者の手元へ渡った時**で、その観測はまだ無い＝
> リポジトリは非公開のままで（`docs/before-launch-checklist.md` B-4）、
> **本番へ出した記録も無い**（README「現在の状態」・同 B-3 が未チェック）。
> 🔴 **義務が発火するのは `npm run deploy` か、リポジトリを公開にした瞬間の早いほう。**
> だからこの表示は**その前に**要る。「まだ渡していない」は「置かなくてよい」ではない。

⚠ **再配布する第三者の著作物は、現時点でこの1件だけ**（2026-09-05 実測）。
`package.json` の `@revenuecat/purchases-js` は依存に在るだけで `src/` から一度も import しておらず、
バンドルにも入らない＝**配らないので義務も無い**。`public/index.html` に外部由来の
スクリプト・フォント・スタイルは1つも無い。⇒ **依存表と再配布物は別物**。増やしたらここに足す。

---

## BIP-39 日本語ワードリスト（MIT）

### 何を再配布しているか

| | |
|---|---|
| 原著作物 | BIP-39 の日本語ワードリスト `bip-0039/japanese.txt`（2,048語） |
| 取得元 | `https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/japanese.txt` |
| 取得日 / SHA-256 | 2026-08-11 / `wordlist/source/PROVENANCE.md` に記録 |
| ライセンス | **MIT**（BIP-39 本文の Copyright 節 "This BIP falls under the MIT License."） |
| 原本の所在 | `wordlist/source/bip39-japanese.txt`（取得したまま・無改変） |
| 派生物 | `wordlist/michizure-ja-1024.txt` / `wordlist/review.md` / `src/client/wordlist-data.ts` |
| 配信物 | `src/client/wordlist-data.ts` は esbuild で `public/chunk-*.js` に入り、**利用者のブラウザへ配信される**（⚠ 遅延読み込みされるのは**部屋を作る画面だけ**＝`src/client/app.ts` の `doCreate()` 内の1箇所。入室しかしない人の手元には渡らない） |

⚠ **再配布の本体はリポジトリではなく配信物のほう**。テキストファイル1本なら「同梱した素材」で済むが、
バンドルされた JS は**部屋を作った人全員の手元へ渡る複製**になる。義務の重さはこちらで決まる。
⚠ chunk のファイル名は内容ハッシュで**ビルドのたびに変わる**ので、ここに具体名を書いてはいけない
（書くと次のビルドで黙って腐る）。`public/chunk-*.js` のままにしておくこと。

### どう派生させたか（＝なぜ義務が続くのか）

`scripts/build-wordlist.mjs` が、2,048語を NFC へ正規化したうえで機械的な条件
（ひらがなのみ／長音記号を含まない／3〜5文字／3拍以上／先頭3文字が他語と重複しない／
濁点を剥がして同型にならない／聞き取りの音韻キーが衝突しない）で絞り、
残った語から等間隔に **1,024語**を選び、不快語・馴染みのない語を人手で落として穴埋めする。
（⚠ 人手の工程はまだ走っていない＝`wordlist/rejected.txt` は存在せず、現物の 1,024語は
等間隔選抜そのもの。README「残っているもの」の**単語リストの目視確認**がこれ。
どちらにせよ**語は上流のまま**なので、義務の話はこの工程の前後で変わらない。）

🔴 **語は1語も書き換えていない。やったのは選別と並べ替えだけで、収録語はすべて BIP-39 の語そのもの。**
（⚠ 唯一の変換が上の NFKD→NFC 正規化で、これは**正準等価**＝同じ語の別の書き表し方であって
別の語ではない。**上流とバイト列は一致しないが、それは「改変」ではなく「表記形の統一」**である。
上流が NFKD であることの罠は `wordlist/source/PROVENANCE.md` に書いてある。）
つまりこれは「参考にした」ではなく **substantial portion の再配布**であり、MIT の条件はそのまま続く。
（新しく語を作ったのなら義務は切れる。切れていないのは、語が丸ごと元のものだからである。）

### 権利者の表示

⚠ 上流の `japanese.txt` は**ヘッダコメントを持たない**（実測：語だけの行が 2,048行、`#` 始まりの行は 0）。
`Copyright (c) <年> <氏名>` の形の行は上流に存在せず、許諾は BIP-39 本文の Copyright 節で与えられている。
**年は上流に無いので書かない**（推測で年を入れると、後から誰も直せない嘘になる）。

本リポジトリで裏が取れている**唯一の氏名は dabura667**。根拠は2つで、どちらも記録済み：
Monero の `src/mnemonics/japanese.h` が
`// Word list originally created by dabura667 and released under The MIT License (MIT)` と書いており
**[実測]**（`docs/passphrase-wordlist.md` §1.1 の表）、
その **Monero 日本語リストは BIP-39 日本語リストの部分集合**（積集合 1,626・和集合 2,048、
同 §1.2 (b) の実測）である。
⚠ ただし「BIP-39 側の日本語リストの著作権者が dabura667 **だけ**である」ことまでは一次情報で確認していない
（`bitcoin/bips` PR #92 の作成者名までは本リポジトリに記録が無い）。よって他の寄与者を含む形で表示する。

```
Copyright (c) dabura667 and the BIP-39 (bitcoin/bips) contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ⚠ 残件（このファイルを置いただけでは閉じない）

**① 配信物にこの表示が入っていない＝デプロイの前に閉じる。** `public/chunk-*.js` を受け取った人の手元には、
リポジトリのこのファイルは届かない。MIT が求めているのは「複製に**同行する**こと」なので、
リポジトリに置くだけでは、**JS だけを受け取る経路に対しては未達になる**。
埋め方の候補は (a) アプリ画面のどこかからこのファイルへリンクする、
(b) バンドルの先頭に許諾文をバナーコメントとして焼き込む（esbuild の `--banner:js`。
`--splitting` の出力すべてに付く）、の2つ。
⚠ **どちらも `public/` と `package.json` の build 手順に触るので、ここでは実施していない。**
🔴 **`docs/before-launch-checklist.md` にこの項目はまだ無い**（2026-09-05 実測）。
どこにも紐づいていない予定は無言で落ちるので、**B-3（デプロイ）の前に置く項目として足すこと。**
上の 🔴 の通り、義務が発火するのはデプロイかリポジトリ公開の早いほうで、**①はその期限を持つ**。

**② `package.json` の `"license": "UNLICENSED"` と、MIT 素材の再配布が同居している。**
これ自体は矛盾ではない（自分のコードを公開しないことと、他人の MIT 素材を条件付きで再配布することは両立する）。
ただし **UNLICENSED は「このリポジトリの中身に一切の許諾が無い」と読まれる**ので、
中に MIT の派生物が入っていることが読み手に伝わらない。
`wordlist/` 配下だけは MIT 由来である、と明示するかどうかは**所有者の判断**であり、
エージェントの側で `license` フィールドを変えたり `LICENSE` を置いたりはしていない。**要判断として残す。**
