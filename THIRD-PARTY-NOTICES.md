# サードパーティ表示（THIRD-PARTY NOTICES）

Michizure は第三者の著作物を**再配布する**。ここはその義務を果たすための場所。
リポジトリだけでなく**利用者へ配る JavaScript にも入る**ので、このファイルを消してはいけない。

このリポジトリ自体のライセンスは `LICENSE`（Apache License 2.0・未改変）、
短い帰属表示は `NOTICE` に在る。このファイルは `NOTICE` から参照される、
再配布物の詳細な一覧（原著作物・取得元・ライセンス全文・派生させた理由）。

> 🔴 **2026-09-05 の監査で発見**：この表示は**同日まで存在しなかった**。
> リポジトリのどこにも MIT の許諾文（`Permission is hereby granted...`）が無く、
> MIT に触れていたのは `wordlist/source/PROVENANCE.md`・`docs/passphrase-wordlist.md`・
> 当時の README 下書き（のち `README.md` へ差し替え）の散文だけだった。
> ⚠ 「ライセンスを確認した」と「表示を運んだ」は別の作業である。前者だけを済ませて
> 後者を落としたのが今回の抜け＝MIT の**唯一の条件**は「確認」ではなく「同梱」の側にある。
>
> ⚠ **ここは「義務に違反していなかった」わけではなくなった。** 監査の初稿は
> 「2026-08-11 の取り込み以降ずっと再配布していた」と書いて一度訂正されたが、それは
> **非公開・未デプロイの間だけ正しかった判断**。MIT の条件が働くのは**複製が第三者の
> 手元へ渡った時**で、**2026-09-18 の初回本番デプロイでその観測が発生した**
> （`https://michizure.y2studyabout.workers.dev`）。
> 🔴 **義務は `npm run deploy` の瞬間に発火した。** その時点の配信物には、下の
> qrcode-generator・RevenueCat の著作権表示が**欠落していた**（Capacitor は esbuild が
> ソースの `/*!` コメントを自動保持していたため運良く残っていた）。同日中に
> `build:client` の esbuild へ `--banner:js` を足して全出力ファイルに3件とも同梱する形に直し、
> `scripts/check-license-banner.mjs`（`pretest` に追加）で実物を検査するようにした。
> **ただし本番の配信物はまだ直前の版のまま＝この修正を含む再デプロイが必要。**

⚠ **再配布する第三者の著作物は、現時点で3件**（2026-09-18 実測で更新）。
このうち **qrcode-generator と @revenuecat/purchases-capacitor の JS 側ブリッジは
「依存として存在するだけ」ではなく、esbuild が実際に `public/chunk-*.js` へバンドルしている**
＝2026-09-16 時点の「依存表と再配布物は別物」という整理は、この2件については誤りだった。
`@capacitor/*`（`android/` `ios/` のネイティブプロジェクトテンプレート）と
iOS 側の SPM 依存（`Package.resolved` に記録・RevenueCat 5.88.0 ほか）は、
引き続きネイティブのビルド成果物側だけの話で、**Web 配信の `public/*.js` には出てこない**。
足すのは、配信物に**コードの実体が入っているもの**だけ。増やしたらここに足す。

---

## Gradle Wrapper（Apache-2.0）

### 何を再配布しているか

| | |
|---|---|
| 原著作物 | Gradle Wrapper（`gradlew`・`gradlew.bat`・`gradle-wrapper.jar`・`gradle-wrapper.properties`） |
| 取得元 | `npx cap add android`（Capacitor CLI）がプロジェクト生成時に同梱 |
| ライセンス | **Apache License 2.0**（`android/gradlew` 冒頭のコメントに `Copyright © 2015-2021 the original authors` `SPDX-License-Identifier: Apache-2.0` と明記・実測） |
| 原本の所在 | `android/gradle/wrapper/gradle-wrapper.jar`・`gradle-wrapper.properties`・`android/gradlew`・`android/gradlew.bat`（無改変） |
| 配信物 | Android ビルド時にのみ使用。**利用者のブラウザ／アプリ本体には含まれない**（ビルドツールチェーンの一部） |

⚠ ライセンス表示は各ファイル自身のヘッダコメントに同梱済み（Apache-2.0 は NOTICE 転記までは求めない）。
ここに載せるのは「何を・どこから・どのライセンスで」再配布しているかの一覧としての記載。

---

## Capacitor プロジェクトテンプレート（MIT）

### 何を再配布しているか

| | |
|---|---|
| 原著作物 | Capacitor の iOS/Android プロジェクトテンプレート一式 |
| 取得元 | `npx cap add ios` / `npx cap add android`（Capacitor CLI・`@capacitor/ios` `@capacitor/android` 由来のテンプレート） |
| ライセンス | **MIT**（Capacitor 本体・Ionic（旧 Drifty Co.）が公開する OSS プロジェクトのテンプレート） |
| 原本の所在 | `android/app/src/main/java/dev/waiteu/michizure/MainActivity.java`・`android/app/src/androidTest/**`・`android/app/src/test/**`・
  `android/build.gradle`・`android/app/build.gradle`・`android/variables.gradle`・
  `ios/App/App/AppDelegate.swift`・`ios/App/App/SceneDelegate.swift`・`ios/App/App/Base.lproj/**`・`ios/App/App/Assets.xcassets/**/Contents.json`（いずれも生成後ほぼ無改変） |
| 配信物 | ネイティブアプリのビルド成果物（iOS/Android バイナリ）に組み込まれる。Web 配信（`public/`）には含まれない |

⚠ これらのファイル自体には個別の著作権ヘッダが付いていない（テンプレート生成時点の慣習）。
再配布の根拠は Capacitor 本体（ionic-team/capacitor 等）が MIT で公開しているプロジェクトテンプレートに
由来すること。

🔴 **アイコン・スプラッシュ画像は、2026-09-25 まで Capacitor の雛形（白地に水色のグリッドと青い×印）が
そのまま入っていた。** コードのライセンス（MIT）はロゴを含まないので、雛形の同梱物を製品の顔に流用してはいけない。
同日、`public/icons/michizure.svg`（自前の意匠・commit `fef4ef7`）から `scripts/build-native-assets.mjs` が
全サイズを描き起こす形に置き換え、上の表から外した。雛形のバイト列は `scripts/check-icons.mjs` が
sha256 で見張っている（`npm test` の前段）。⚠ `npx cap add` を再実行すると雛形へ戻る＝その後は
`npm run build:native-assets` を必ず走らせる（`npm run build:shell` は自動で走らせる）。

⚠ **これとは別に、`@capacitor/core` の JS ランタイム本体は Web 配信にも含まれる。**
`src/client/` がプラグイン呼び出し（Filesystem・Share）に使っており、esbuild が
`public/chunk-*.js` へバンドルする（2026-09-18 の監査で実測：`chunk-IARVSCW3.js` に実体あり）。
上の表の「Web 配信には含まれない」は**このテンプレート一式についてのみ**正しい。
`@capacitor/core` 自体の著作権表示は、esbuild がソースの `/*!` コメントを自動保持するため
運良く配信物に残っている（`Capacitor: https://capacitorjs.com/ - MIT License`）が、
念のため下の共通バナー（`--banner:js`）にも含めてある。

---

## qrcode-generator（MIT）

### 何を再配布しているか

| | |
|---|---|
| 原著作物 | `qrcode-generator`（QRコード生成ライブラリ・v2.0.4） |
| 取得元 | npm（`qrcode-generator`・著者 Kazuhiko Arase） |
| ライセンス | **MIT** |
| 原本の所在 | `node_modules/qrcode-generator/`（npm 経由・リポジトリには同梱していない） |
| 配信物 | `src/client/qr.ts` が import し、esbuild が `public/chunk-*.js` へバンドルする |

⚠ npm パッケージの `dist/qrcode.js` 自体にヘッダコメントは無い（実測）。著作権表示は
`package.json` の `author: "Kazuhiko Arase"` と `license: "MIT"` から確認し、下の共通バナーに含めた。
**2026-09-18 の監査で発見**：配信物にこの表示が入っておらず、初回本番デプロイの時点では未達だった。

---

## @revenuecat/purchases-capacitor（MIT）

### 何を再配布しているか

| | |
|---|---|
| 原著作物 | RevenueCat の Capacitor プラグイン JS ブリッジ（v13.5.1） |
| 取得元 | npm（`@revenuecat/purchases-capacitor`） |
| ライセンス | **MIT**（`Copyright (c) 2023 RevenueCat, Inc.`・パッケージ同梱の `LICENSE` に実測） |
| 原本の所在 | `node_modules/@revenuecat/purchases-capacitor/`（npm 経由・リポジトリには同梱していない） |
| 配信物 | `src/client/billing.ts` が import する JS ブリッジ部分が `public/chunk-*.js` へバンドルされる
  （ネイティブ側の RevenueCat SDK 本体はアプリバイナリに別途組み込まれ、こちらは対象外） |

⚠ **2026-09-18 の監査で発見**：配信物にこの表示が入っておらず、初回本番デプロイの時点では未達だった。
著作権表示は下の共通バナーに含めた。

---

## 共通の許諾表示（esbuild `--banner:js`）

上の qrcode-generator・RevenueCat（および運良く自動保持されている Capacitor）の3件を、
`package.json` の `build:client` が esbuild の `--banner:js` で `public/app.js` と
`public/chunk-*.js` の**全出力ファイルの先頭**に焼き込む。`scripts/check-license-banner.mjs`
（`pretest` から実行）が、ビルド済みの `public/` に実際に3件とも含まれているかを検査する。

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

**① ✅ 実装済み・2026-09-18。ただし本番への反映（再デプロイ）はまだ。**
`build:client` の esbuild に `--banner:js` を足し、qrcode-generator・RevenueCat・Capacitor
の3件の著作権表示を全出力ファイルの先頭へ焼き込むようにした。`scripts/check-license-banner.mjs`
（`pretest` に追加）が実物を検査する。**ただし初回本番デプロイ（同日・この修正より前）の
配信物にはまだ入っていない**＝この修正を含めて再デプロイするまで、本番は未達のまま。

**② `package.json` の `"license"` は現在 `"Apache-2.0"`（2026-09-17 のユーザー裁定）。**
UNLICENSED だった頃の懸念（「このリポジトリの中身に一切の許諾が無い」と読まれ、MIT 派生物が
入っていることが伝わらない）はもう当てはまらない。Apache-2.0 は自分のコードの話で、
他人の MIT 素材を条件付きで再配布すること自体は引き続き両立する。GitHub の About 欄は
Apache-2.0 として検出済み＝リポジトリ全体のライセンス表示としては解決している。
