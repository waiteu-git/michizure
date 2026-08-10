# Michizure（道連れ）

旅行の費用を記録して精算まで見届けるアプリ。合言葉つきの「部屋」を作り、URL と合言葉を知っている人だけが入れる。

設計: [`docs/superpowers/specs/2026-08-09-michizure-phase1-design.md`](docs/superpowers/specs/2026-08-09-michizure-phase1-design.md)
実装計画: [`docs/superpowers/plans/2026-08-09-michizure-phase1a-backend.md`](docs/superpowers/plans/2026-08-09-michizure-phase1a-backend.md)

現在の状態: **Phase 1a（バックエンド）完了。フロントエンドは未着手（Phase 1b）。**

## 開発

```
npm install
npm test          # 全テスト（pretest で privacy 設定も検査される）
npm run typecheck # wrangler types + tsc
npm run dev       # ローカル起動（http://localhost:8787）
```

ローカルサーバーを起動してから、ブラウザがやることを一通り叩く通し確認:

```
node scripts/e2e-local.mjs
```

## API

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| GET | `/api/health` | なし | 死活確認 |
| POST | `/api/rooms` | なし | 部屋を作る（`{salt, authKey, blob}`）|
| GET | `/api/rooms/:id/salt` | なし | 鍵導出に要るソルト。秘密ではない |
| POST | `/api/rooms/:id/enter` | `authKey` | 入室してトークンを得る |
| GET/PUT | `/api/rooms/:id/blob` | Bearer | 暗号文の取得・更新 |
| GET | `/api/rooms/:id/ws?token=` | トークン | WebSocket で中継を受ける |
| DELETE | `/api/rooms/:id` | `authKey` | 部屋ごと破棄する |

## デプロイ

⚠ **公開はリタス初版公開後**（設計 §1）。それまで本番へデプロイしない。公開には4つのゲートがあり、そのうち3つはこのリポジトリの外で決まる（リタス初版公開・法務照会を踏まえた規約類・IPログ保持方針・ユーザーの承認）。

本番のトークン署名鍵は wrangler のシークレットとして設定する（`wrangler.toml` の `[vars]` は開発用）。

```
wrangler secret put TOKEN_SECRET
npm run deploy
```

`[vars]` の値は `wrangler types` の生成物にそのまま埋め込まれるため、本番の鍵をそこへ書いてはならない（`npm test` の pretest が検査する）。

## PBKDF2 の反復回数を決める

`src/keys.ts` の `PBKDF2_ITERATIONS`。**入室のたびに1回だけ、利用者の端末のブラウザで走る。**

```
node scripts/bench-pbkdf2.mjs   # Mac での基準値（速い側の下限）
```

実機の値は `bench/pbkdf2.html` を端末で開いて測る。**判断は実機の値で行う。** サーバー側や Mac の数値は参考にならない（一番遅い端末が体験を決める）。

⚠ このページは端末にダウンロードして直接開く（`file://`）か `https://` で開くこと。Mac で簡易サーバーを立てて `http://192.168.x.x:8000/` のように LAN の IP で開くと、安全なコンテキストにならず `crypto.subtle` が使えない。

## 設計上の注意

- サーバーは**暗号文とメタデータのみ**を保持する。合言葉も復号鍵も持たない
- ⚠ ただし**この暗号化を利用者は検証できない**（配信している JavaScript は運営者のもの）。
  「運営者にも中身が見えない」等を対外的に謳ってはならない。設計 §7.5 を必ず読むこと
- **メタデータは暗号化されない**（部屋の存在・時刻・暗号文のサイズ・更新頻度・IPアドレス）。
  「何も持たない」ではなく「暗号文とメタデータを持つ」である
- メンバー20人上限は**クライアント側でのみ強制**される。サーバーは検証できない
- 合言葉を紛失するとデータは復旧できない
- Workers Logs は `wrangler.toml` で明示的に無効化している。**新規 Worker では既定で有効**なので、
  この設定を消すとログが Cloudflare 側に残る（無料プランで3日）。`npm test` の pretest が検知する
