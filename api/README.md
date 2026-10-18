# 共通判定API

Mac・Reachy Mini Wireless・CoreS3から画像を受け取り、スマホ操作の判定、連続検出、クールダウン、セッション状態を管理する小さなNode HTTPサーバーです。各端末は撮影、API呼び出し、`notify: true`への機器別アクションを担当します。OpenAIのキーはこのサーバーだけに置きます。

## 起動

Node **22.9以上**。外部npm依存はありません。

```sh
cd api
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# 出力した値を.envのFOCUS_API_TOKENへ設定
# 最初はDECISION_PROVIDER=mockに変更して接続確認
npm start
```

`http://127.0.0.1:8787/health`は認証不要で、`{"provider":"mock","configured":true}`の2項目を返します。OpenAIキーが空の実APIモードは`configured: false`となり、画像判定は`unknown` / `provider_not_configured`になります。設定不正（トークン未設定、providerの誤記など）は起動時に停止します。

| 環境変数 | 用途・初期値 |
|---|---|
| `FOCUS_API_TOKEN` | 共通APIへのBearerトークン。mockでも必須 |
| `OPENAI_API_KEY` | OpenAI APIキー。serverだけに設定 |
| `DECISION_PROVIDER` | `openai`（初期値）または`mock` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |
| `ALLOWED_ORIGINS` | カンマ区切り完全一致。初期値は`http://localhost:3000,http://localhost:5173` |
| `MOCK_PHONE_PROBABILITY` | mock固定値。初期値`0`、通知テスト時`1` |
| `MOCK_OBSERVABLE_PROBABILITY` | mock固定値。初期値`1` |

CoreS3など同一LANの端末から試すときは`HOST=0.0.0.0`へ変更し、MacのLAN IPと8787番ポートを使います。デバイスのlocalhostはそのデバイス自身です。通常運用・公開接続はHTTPS終端のある環境へ置いてください。HTTPSのWebページからLANのHTTP APIを呼ぶ構成はブラウザーで制限されるため、公開UIはHTTPS APIへ接続します。

## HTTP契約

`/v1/*`には必ず`Authorization: Bearer <FOCUS_API_TOKEN>`を付けます。単一デモトークンを使う実装で、トークンを知る人は共有セッションへアクセスできます。一般公開用のユーザー認証ではありません。フロントへOpenAIキーを渡したり、共有トークンを公開リポジトリ・JSバンドルへ固定値で埋め込んだりしないでください。

| メソッド・パス | リクエスト | 応答 |
|---|---|---|
| `POST /v1/sessions` | JSON `{"device_type":"cores3","duration_seconds":1500}` | 201・snapshot |
| `GET /v1/sessions/{id}` | 本文なし | 200・snapshot |
| `POST /v1/sessions/{id}/frames` | JPEG/PNGのraw bytes、`X-Frame-Id`必須 | 200・snapshot |
| `POST /v1/sessions/{id}/control` | JSON `{"action":"pause"}` / `resume` / `end` | 200・snapshot |

`device_type`は`cores3`、`reachy_mini`、`mac`など。拡張用に英小文字で始まる英小文字・数字・`_`・`-`の64文字以内を受け付けます。`duration_seconds`は1〜14400の整数、省略時1500。期限は開始時からの実時間で、一時停止中も進みます。自動延長はしません。

画像は`Content-Type: image/jpeg`または`image/png`、**1 MiB以下**。JSONやmultipart、base64本文ではなく画像バイト列をそのまま送ります。`X-Frame-Id`は画像ごとに新しいID（UUIDなど）を発行し、同じ画像を通信再試行するときは同じIDを使います。IDは英数字・`_`・`.`・`:`・`-`、1〜128文字です。画像の署名を確認しますが、完全なデコード検証は行いません。

```json
{
  "session_id": "uuid",
  "state": "cooldown",
  "notify": true,
  "notification_id": "notification-uuid",
  "message": "スマホを置いて、作業に戻りませんか？",
  "phone_probability": 0.95,
  "observable_probability": 0.99,
  "consecutive_count": 0,
  "cooldown_remaining_ms": 60000,
  "next_capture_after_ms": 60000,
  "provider": "openai",
  "reason": "phone_use_confirmed"
}
```

端末は**`notify`がtrueのときだけ通知**し、`notification_id`を記憶して同じ通知を重複実行しません。通常応答の通知IDとメッセージはnullです。GETや同じ画像IDの再送は通知を再発行しません。通知が必要だった最初のHTTP応答が通信障害で失われた場合、再送応答で通知を復元する機能はありません（重複抑止を優先）。端末の中断・終了後に届いた古い応答も無視してください。

次の撮影まで`next_capture_after_ms`以上待ち、`paused` / `ended`なら撮影と送信を止めます。エラー直後の連打を避けるため、APIに接続できない場合も少なくとも3秒待ちます。HTTPエラーは`{"error":{"code":"...","message":"..."},"request_id":"..."}`です。400は入力不正、401は認証失敗、403はCORS拒否、404は未存在、409は同一セッションの他画像を判定中、413はサイズ超過、415は形式不正、429は保存件数上限です。

## 判定と状態

- 3秒以上の間隔で撮影した画像を判定します。早すぎる画像は推論せず`capture_too_soon`を返します。
- `phone_probability >= 0.8`かつ`observable_probability >= 0.7`が**3回連続**すると一度だけ注意します。最短では最初の撮影から約6秒＋通信・推論時間です。
- 注意後60秒は`cooldown`で推論・新しい注意を抑止します。終了後は新しい3回の連続検出が必要です。
- 机上に置かれただけのスマホは対象外です。操作の仕事目的かどうかやADHD、集中力そのものは判定しません。
- 見えにくい画像、拒否、不正なAPI応答、通信エラーは`unknown`になり連続回数をリセットします。最後の撮影から10秒超の空白も連続回数をリセットします。
- OpenAIへの呼び出しは10秒で打ち切り、自動再試行はしません。10秒超で返った古い判定も採用しません。
- `pause` / `end`で進行中の判定をキャンセルし、世代番号でも結果を破棄します。セッション期限を過ぎた判定で注意することはありません。
- 同一セッションでは同時に1画像だけ推論します。同じ画像IDは再課金せず、異なる画像の同時送信は409になります。

状態は`observing`（観察中）、`suspected`（連続確認中）、`cooldown`、`paused`、`ended`、`unknown`です。閾値はハッカソン用の初期値で、効果や精度を保証する値ではありません。

## CoreS3の先行確認

1. `mock`でまず`GET /health`、セッション開始、実画像送信まで通します。
2. `MOCK_PHONE_PROBABILITY=1`でサーバーを再起動し、**新しいセッション**を作って3秒間隔で別の画像IDを3回送ります。3回目だけ`notify: true`になり、端末の表示・音を確認できます。
3. `DECISION_PROVIDER=openai`と有効な`OPENAI_API_KEY`をサーバーに設定し、通常作業・机上のスマホ・実際の操作で確認します。**ここから実APIの利用料金が発生します。**
4. 一時停止、終了、Wi-Fi切断を確認し、画像やAPIキーをログへ出さないことを確認します。

mockは画像内容を判定しません。応答の`provider`は必ず`mock`と表示されます。実APIの利用可否、精度、CoreS3の実機動作はこのリポジトリ作成時点で未検証です。

## 保持・デプロイ・検証

画像や秘密はディスク・アクセスログへ保存しません。実APIモードでは画像がOpenAIへ送信されるため、完全ローカル処理ではありません。セッションと処理済みIDはメモリーに保持し、終了・期限切れ30分後に次のAPIアクセスで回収します。最大1000セッション、各10000画像IDです。**再起動すると状態は消えます。単一プロセス・1レプリカで運用してください。** 複数インスタンスへの負荷分散には外部共有ストレージ等が必要です。

```sh
cd api
npm test
docker build -t focus-api .
docker run --rm -p 8787:8787 --env-file .env -e HOST=0.0.0.0 focus-api
```

テストはHTTP認証・CORS・サイズ制限、連続検出・クールダウン、重複抑止、セッション分離、停止中の応答、期限・タイムアウト、不正な判定応答を確認します。テストから実OpenAI APIは呼びません。Dockerファイルは用意していますが、Dockerビルド・公開デプロイは未検証です。

参照：[OpenAI Decisionsガイド](https://developers.openai.com/api/docs/guides/decisions)、[Decisions create API](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create)。
