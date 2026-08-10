# IPアドレスのログ保持 — 調査結果と方針案

調査日: 2026-08-10
目的: 設計 §16 の未決事項「IPアドレスのログ保持方針」を決める。プライバシーポリシーに保持期間を書くための前提。

> ⚠ **推測を観測の語で書かないこと。** 以下は Cloudflare の公式文書で裏を取った事実と、
> 裏が取れなかった事項を分けて記載している。「たぶん残らない」は書いていないし、書いてはならない。

## 要点

1. **アプリが IP を一切読まなくても、Cloudflare の zone 側にリクエスト単位の IP を含むデータが残る。**
   無料プランで Security Events が24時間、Security Analytics が7日間。**無料プランでこれを無効化する手段は公式文書に見当たらない（＝未確認。「無効化している」とは書けない）。**
2. **Workers Logs は新規 Worker では既定で有効だった。** 書かなければログが残る（無料プランで3日保持）。
   ⇒ `wrangler.toml` に `[observability] enabled = false` を明示した（実装済み・`npm test` の pretest で検査）。
3. **Cloudflare 自身のエッジログの保持日数は公表されていない。** 「limited period of time」までしか書かれていない。
   ⇒ **「N日で破棄される」とポリシーに書いてはならない。**
4. **Cloudflare Web Analytics は 2025-10-15 以降、無料ドメインで既定オン（オプトアウト方式）。**
   「有効化しなければ何も入らない」という前提は現在は成立しない。⇒ **ダッシュボードでの実状確認が要る（ユーザーの手）。**

## 確定事項（ポリシーに書ける）

| 項目 | 事実 | 出典 |
|---|---|---|
| アプリ側 | Worker / DO は IP を含むヘッダ（`CF-Connecting-IP` 等）を読まない。DO のストレージにはアプリが明示的に書いたものだけが入る | 本リポジトリの実装。`scripts/check-privacy-config.mjs` が検査 |
| Workers Logs | 無効化済み。有効時の保持は無料3日・有料7日 | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Logpush / Logpull | **Enterprise 限定**＝無料プランでは HTTP リクエストログの外部保存は発生しない。既定で保持もされない | [Logpush](https://developers.cloudflare.com/logs/logpush/)／[Enabling log retention](https://developers.cloudflare.com/logs/logpull/enabling-log-retention/) |
| Security Events | リクエスト単位・`clientIP` を含む。無料プラン**24時間** | [Security Analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/) |
| Security Analytics | 同上。無料プラン**7日** | 同上 |
| Cloudflare のエッジログ | 「限定された期間のみ保持する」と公表。**日数は非公表** | [Privacy Policy](https://www.cloudflare.com/privacypolicy/)／[Transparency Report](https://www.cloudflare.com/transparency/h1-2022/) |

## 書けない事項（未確認）

- 「Cloudflare のエッジログは N 日で破棄される」— 日数は非公表。第三者情報の「72時間」は一次情報で確認できず**使用不可**
- 「Workers Logs の invocation log に IP は含まれない」— 公式のフィールド一覧が非公開。同じトレース基盤の tail handler では**リクエストヘッダが載り**、redaction 対象は cookie/auth/key/secret/token/jwt のみで `cf-connecting-ip` は**対象外**。⇒ 含まれない保証はない。**ログ自体を取らない**のが唯一の確定手段（採用済み）
- 「Durable Objects は IP を記録しない」— 「記録する」記述が無いだけで、明示的な保証文は存在しない
- zone 側の Security Events / Security Analytics の収集を**無効化できるか** — 公式に手段の記述なし

## 方針案（ユーザーの選択待ち）

いずれも「アプリは IP を読まない」「Workers Logs は無効」を前提にした**書き方**の選択である。

### 案A: 事実をそのまま書く（推奨）

ポリシーに「当サービスは IP アドレスを取得・保存しません。ただし配信基盤である Cloudflare 側に、セキュリティ目的でリクエスト情報（IPアドレスを含む）が最大7日間保持されます。これは基盤側の機能であり当方では変更できません」と書く。

- 利点: **検証されても崩れない。** 設計 §7.5 の「証明できない安全性を売り文句にしない」と整合する
- 欠点: 説明が長くなる。「IPが残る」と明記することになる

### 案B: 「当方は取得しない」だけ書き、基盤側に触れない

- 利点: 短い
- 🔴 **推奨しない。** 「何も残らない」と読まれる。§7.5 が戒めているのはまさにこれ（一度崩れると信用がまとめて失われる）

### 案C: 独自ドメインを Cloudflare の zone に載せない構成を探す

- zone 側の収集そのものを避ける案だが、Workers を独自ドメインで出す以上は zone に載る。**現実的な回避策は見つかっていない**
- 実質、案A か案B の選択になる

## 残1件: invocation log に IP が実際に載るかの確認（推測でなく実機で）

これが取れると、法務照会 Q3 を「たぶん」でなく断定形にできる。**Cloudflare の認証が要るのでユーザーの手。**

⚠ 現在の実装は `[observability] enabled = false` なのでログは出ない。**確認のときだけ一時的に有効化する**。

```bash
cd ~/dev/michizure
# 1. 一時的にログを有効化（この編集はコミットしない）
#    wrangler.toml の [observability] を enabled = true にする
# 2. Cloudflare のエッジで動かす（デプロイせずに実行できる）
npx wrangler dev --remote
```

別のターミナルで、tail の生データを見る:

```bash
npx wrangler tail --format=json
```

そのうえで `curl` でリクエストを1本投げ、tail に流れる JSON の中に
`cf-connecting-ip` / `x-forwarded-for` / IPアドレスそのもの が現れるかを見る。

- **現れた場合**: 「Workers Logs を有効にすると IP が保存される（無料3日）。当サービスは無効化している」と断定形で書ける
- **現れなかった場合**: 「有効化しても IP は載らないことを実機で確認した」と書ける
- ⚠ **確認が終わったら `enabled = false` に戻す**（戻し忘れは `npm test` の pretest が検知する）
- ⚠ `wrangler tail` が見せるのは trace event であって Workers Logs の保存内容そのものではない。**同じトレース基盤だが完全な同一性は保証されない**ので、結論にはその但し書きを付ける

## ユーザーがやる必要のあること（Cloudflare の認証が要る＝エージェントは実行しない）

1. **Web Analytics の有効/無効をダッシュボードで確認する**（既定オンの可能性が高い）。無効にするなら公開前に
2. GraphQL の `settings` ノードで `httpRequestsAdaptive` / `firewallEventsAdaptive` の `notOlderThan` を実測し、ポリシーに書く日数の根拠にする
3. 決めた方針を**法務照会（ビジネスハブ）へ渡す**。照会の前提が「暗号文＋メタデータを保持する事業者」であり、メタデータの中身がここで確定する
