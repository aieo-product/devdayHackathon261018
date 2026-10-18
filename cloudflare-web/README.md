# 公開DOTSフロント：Cloudflare Worker

[公開画面](https://focus-web-20261018.take-otani.workers.dev/)へ配備済みです。[カメラ不要の表示デモ](https://focus-web-20261018.take-otani.workers.dev/?demo=1&pattern=fever&character=green)はログイン不要で、カメラ・実APIを使いません。

実判定を使う場合は画面でチーム用コードを入力し、本人がカメラを明示的に有効化します。コードはチーム内の別経路で共有し、公開資料・URL・ソースへ書きません。ブラウザへOpenAIキーや共通APIトークンを入力する必要はありません。

## 通常画面とデモモード

通常の公式URLはクエリなしの `/` です。通常画面ではデモパネル・テストボタンを表示しません。演出確認だけを行うときは `?demo=1&pattern=fever&character=green` を指定します。従来の `?showcase=1` もデモモードの別名として扱います。公開デモの表示検証14項目が通過しました。実判定の成功とは区別します。

## 構成・セッション

`focus-dopa-preview/` のブラウザ資産を `cloudflare-web/public/` へ選別してビルドします。サーバーソース、設定ファイル、テスト、ローカル専用デスクトップ補助資産は公開対象に含めません。

公開Worker `focus-web-20261018` は、service binding `FOCUS_API` で既存の `focus-shared-api-20261018` を呼び出します。API仕様・2秒保持・クールダウンなしの判定は既存Workerに従います。既存判定Workerの変更・再配備は行いません。

- チームコードのログイン後、署名した12時間の `HttpOnly; Secure; SameSite=Strict` Cookieを発行します。
- ブラウザの認証単位ごとにDurable Objectでセッション所有を保存し、別ブラウザのセッションIDによる読取・画像送信・停止を拒否します。同じCookieを共有するタブは同じ認証単位です。
- セッション登録上限は32件です。終了済み記録を整理しても上限に達する場合は、新規作成を拒否します。
- ログアウトはCookieとサーバー側の認証を失効させ、所有セッションの終了を試みます。撮影を止めるときは画面の停止操作を使い、終了表示も確認してください。
- 共通APIトークンはWorker Secretだけに保持します。許可したAPIパス・メソッド・画像形式とサイズだけを中継します。

公開版はネイティブmacOS補助アプリへ接続できません。Web画面内の表示と、対応ブラウザの小窓を使います。小窓が利用できない環境ではページ内表示に戻ります。ローカル版の補助アプリ機能とは区別してください。

## 開発・配備

Node.js 22.9以上、リポジトリ直下で実行します。

```sh
npm ci
npm run build:web
npm run test:front
npm run test:web
npm run check:web
```

| コマンド | 用途 |
| --- | --- |
| `build:web` | 公開可能なブラウザ資産を生成 |
| `test:web` | 認証・所有権・プロキシ・Workers統合試験 |
| `check:web` | 資産生成と配備なしのビルド検証 |
| `start:web` | 資産生成後にWrangler開発サーバーを起動 |
| `deploy:web` | 資産生成後、この公開フロントWorkerだけを配備 |

必要なSecretをCloudflareへ設定します。値は対話入力し、コマンド・Gitへ実値を残しません。

```sh
npx wrangler secret put FOCUS_API_TOKEN -c cloudflare-web/wrangler.jsonc
npx wrangler secret put TEAM_ACCESS_CODE -c cloudflare-web/wrangler.jsonc
npx wrangler secret put COOKIE_SECRET -c cloudflare-web/wrangler.jsonc
npm run deploy:web
```

`FOCUS_API_TOKEN` は既存判定APIに接続するトークン、`TEAM_ACCESS_CODE` は8〜128文字のチーム用コード、`COOKIE_SECRET` は32文字以上のランダムな署名秘密値です。`OPENAI_API_KEY` は既存判定Workerが保持し、このWorkerには設定しません。`COOKIE_SECRET` の変更で既存Cookieは無効になります。

ローカル開発時はGit管理外の `cloudflare-web/.dev.vars` に同じ変数名を設定します。`start:web` でAPIを試す場合は、対応するservice bindingの接続環境も必要です。自動テストはモック上流を使うため実画像を送信しません。

配備元の変更は `main` 向けPRでレビューして反映します。公開環境へ先行配備したことと、PRがmainへ統合済みであることは別です。更新時は統合コミットと配備元を揃えてください。

## 検証済み・未確認

2026-10-18の公開化作業では、フロント99件（従来79＋認証15＋表示モード4＋再生回帰1）と公開Worker17件が通過しました。過去のmain整備時の236件はAPI等157＋旧フロント79です。今回の新しい内訳を合わせると273件相当ですが、今回273件すべてを再実行した結果ではありません。

公開URLのHTTP 200、`/.env` と `/server.mjs` の404、チームログイン、`provider:openai, configured:true` のhealth、セッション作成HTTP 201を確認済みです。さらに公開ブラウザ＋仮想カメラで、ログイン・API接続・7画像から実OpenAI通知2回（保持2秒以上）・一時停止・終了・ログアウト失効・モバイル表示を確認しました。物理カメラの再試験ではありません。公開デモの表示検証14項目も通過し、全10シーン完走・ページエラー0・デモ実行によるAPI/カメラ呼び出し0を確認しました。ショーケースは演出の確認であり、画像認識の試験ではありません。


公開デモの最終表示検証は14/14成功です。通常画面のデモ・テスト表示0、ログイン・カメラ・開始UIの維持、モバイル横はみ出し0、`?demo=1` の全10ステップ完走、ページエラー0、デモ実行によるAPI・カメラ呼び出し0、通常画面へ戻る操作、旧 `?showcase=1` を確認しました。この表示試験では `/api/access/status` だけ匿名モックを使っています。実ログイン・画像判定・停止・ログアウト失効は、前述の別の公開実接続試験で確認済みです。

実ChatGPT dotsのOAuth接続・購読・通知は引き続き未確認です。このDOTSキャラクター画面とは別機能です。Reachy/CoreS3のEvents遠隔監視アダプターも未実装です。

[フロント実装](../focus-dopa-preview/README.md) · [共通API](../cloudflare/README.md) · [評価資料](../docs/evaluation.md)
