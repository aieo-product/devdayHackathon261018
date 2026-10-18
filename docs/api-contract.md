# 共通判定API契約

Mac・Reachy Mini Wireless・CoreS3は、自分で撮影した画像をこのAPIへ送ります。APIがスマホ操作の判定、連続回数、通知間隔、セッション状態を管理します。端末はAPIが返した`notify: true`を、自機のOS通知・音・動きに変換します。端末側に独自のしきい値を持たせません。

## 接続と認証

- 開発時の標準URL：`http://127.0.0.1:8787`。公開環境はHTTPSを使用します。
- `/v1/`以下はすべて`Authorization: Bearer <FOCUS_API_TOKEN>`が必要です。モックでも認証します。
- `OPENAI_API_KEY`はAPIサーバー専用です。ガジェット・ブラウザには渡しません。
- `FOCUS_API_TOKEN`はハッカソン用の共有アプリトークンです。ブラウザ利用者には見えるので秘密鍵として扱わず、実値をソース／バンドルへ固定しません。共有トークンを持つ利用者を相互に分離する仕組みはありません。
- WebのOriginはサーバーの`ALLOWED_ORIGINS`へ完全一致で登録します。パス・末尾スラッシュ・ワイルドカードは付けません。既定値は`http://localhost:3000,http://localhost:5173`です。
- デバイスからのHTTP通信にCORS設定は不要ですが、認証は必要です。公開HTTPSへ接続するCoreS3では証明書検証を行います。

## ルート

| メソッド | パス | 入力 | 成功 |
| --- | --- | --- | --- |
| GET | `/health` | 認証不要 | 200、プロバイダー状態 |
| POST | `/v1/sessions` | JSON：端末種別、セッション秒数 | 201、開始済みスナップショット |
| GET | `/v1/sessions/{session_id}` | なし | 200、現在のスナップショット |
| POST | `/v1/sessions/{session_id}/frames` | 生JPEG／PNGバイト列 | 200、判定後のスナップショット |
| POST | `/v1/sessions/{session_id}/control` | JSON：`pause`／`resume`／`end` | 200、操作後のスナップショット |
| OPTIONS | 各パス | ブラウザのCORSプリフライト | 許可時204 |

JSON入力は`Content-Type: application/json`、上限16 KiBです。すべてのJSON応答は`Cache-Control: no-store`です。`X-Request-Id`応答ヘッダーでリクエストを識別します。

### ヘルスチェック

```json
{"provider":"mock","configured":true}
```

`provider`は`mock`または`openai`です。`configured`は設定の有無であり、OpenAIへの接続成功・残高・モデル利用権限を保証しません。ヘルスチェックで実APIを呼び出すことはありません。

### 開始

```http
POST /v1/sessions
Authorization: Bearer <FOCUS_API_TOKEN>
Content-Type: application/json
```

```json
{"device_type":"mac","duration_seconds":1500}
```

| フィールド | 必須 | 意味 |
| --- | --- | --- |
| `device_type` | はい | 端末識別名。英小文字で始まり、英小文字・数字・`_`・`-`で64文字以内。チームでは`mac`、`reachy_mini`、`cores3`を使用 |
| `duration_seconds` | いいえ | 1〜14400の整数。省略時1500秒 |

開始時にすぐ`observing`となります。戻り値の`session_id`を後続リクエストに使います。秒数は開始時からの経過時間で、一時停止中も進みます。

### 画像送信

```http
POST /v1/sessions/{session_id}/frames
Authorization: Bearer <FOCUS_API_TOKEN>
Content-Type: image/jpeg
X-Frame-Id: cores3-000001

<JPEGのバイト列>
```

- JPEGを共通形式とします。APIはPNGも受理します。**1画像1 MiB（1,048,576バイト）以下**。
- 本文は生バイト列です。multipart、JSON、Base64文字列では送信しません。
- `X-Frame-Id`は1〜128文字、英数字または`_ . : -`で構成し、同一セッション内で一意にします。
- 同一セッションで同時に1画像だけ処理します。処理中の追加送信は409です。
- `next_capture_after_ms`まで待ってから次を撮影します。送り過ぎやクールダウン中は判定を省略し、`notify: false`で返します。
- 受理済みフレームIDを再送しても通知を再送しません。通信切断で通知応答を受け取れなかった場合の、通知の確実な再配送は実装していません。

### 一時停止・再開・終了

```json
{"action":"pause"}
```

`action`は`pause`、`resume`、`end`のいずれかです。終了済みセッションは再開できず、現在の`ended`状態を返します。一時停止・終了でサーバー内の処理世代を更新し、処理中の判定をキャンセルします。古い結果が戻っても通知しません。

**端末側でも**停止操作と同時に撮影タイマー・カメラを停止し、処理中のローカル取得を中止してください。コントロール要求が失敗しても、利用者が停止を指示した後に撮影を続けないようにします。開始・停止操作は必ず完了を待ち、連打を防ぎます。

## スナップショット全フィールド

```json
{
  "session_id": "a038a096-960c-4a0a-b5e2-0f407fe3d071",
  "state": "cooldown",
  "notify": true,
  "notification_id": "a30cd823-84c8-4718-a001-a91c14d20e34",
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

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `session_id` | string | このセッションの識別子 |
| `state` | string | 下記6状態のいずれか |
| `notify` | boolean | この応答を受けた端末が新しい通知を実行するか |
| `notification_id` | string / null | `notify: true`のときの通知ID。端末でも重複実行を防ぐ |
| `message` | string / null | `notify: true`のときの通知文 |
| `phone_probability` | number / null | 観測画像でスマホを操作している確率、0〜1。未判定／判定失敗時はnull |
| `observable_probability` | number / null | 対象の人・手元を判断できる可視性の確率、0〜1。未判定／判定失敗時はnull |
| `consecutive_count` | integer | 連続した候補検出回数。通知時・非検出・判定不能・停止で0へ戻る |
| `cooldown_remaining_ms` | number | 通知抑制の残りミリ秒。終了済みは0 |
| `next_capture_after_ms` | number | 次の撮影まで待つ時間。0でもpaused／endedなら撮影しない |
| `provider` | string | `mock`または`openai`。UI／デモでモックを区別する |
| `reason` | string | 今回の状態／省略理由。下記一覧を参照 |

確率は集中度やADHDの診断値ではありません。GETやcontrolの応答は常に`notify: false`です。通知は新しいフレーム応答の`notify: true`を一度だけ消費し、表示用に保存されたスナップショットから繰り返し実行しません。

### 状態

| `state` | 表示例 | 撮影 |
| --- | --- | --- |
| `observing` | 見守り中 | 指定の間隔で撮影 |
| `suspected` | スマホ操作の可能性 | 指定の間隔で撮影。まだ通知しない |
| `cooldown` | 通知後の待機 | 指定の待ち時間は撮影を休む |
| `unknown` | 判定できません | 指定の間隔で再試行。通知しない |
| `paused` | 一時停止 | 撮影停止 |
| `ended` | 終了 | 撮影停止。再開は新規セッション |

### `reason`一覧

| 値 | 意味 |
| --- | --- |
| `session_started` | 開始した |
| `session_paused` | 一時停止した／一時停止中の送信 |
| `session_resumed` | 再開した |
| `session_ended` | 終了操作を受けた |
| `session_expired` | 設定時間に達した |
| `session_changed` | 判定中に停止・終了などが起き、古い結果を破棄した |
| `phone_use_not_detected` | 判定条件を満たすスマホ操作を検出しなかった |
| `phone_use_suspected` | スマホ操作の候補だが連続回数が不足 |
| `phone_use_confirmed` | 連続条件を満たして新しい通知を発行した |
| `insufficient_visibility` | 人・手元が十分見えず判定できない |
| `cooldown_active` | 通知後の待機中なので判定しない |
| `cooldown_finished` | 通知後の待機が終了した |
| `capture_too_soon` | 撮影間隔が短すぎるため判定しない |
| `duplicate_frame` | 受理済みのフレームIDなので判定しない |
| `decision_timeout` | 判定の時間制限を超えた |
| `decision_refused` | 判定APIが回答を拒否した |
| `stale_result` | 返ってきた判定が古すぎる |
| `invalid_decision` | 判定API応答の形式・確率が不正 |
| `provider_not_configured` | 実APIキーが未設定 |
| `provider_error` | 上記以外の判定APIエラー |

`reason`は補足説明です。通知の条件には必ず`notify`を使い、表示状態には`state`を使います。たとえばGETで`reason: phone_use_confirmed`が残っていても通知は再実行しません。

## サーバー内の判定設定

現在の既定値です。これらはHTTPリクエストで変更できず、調整はAPI担当がサーバーで行います。

| 設定 | 値 |
| --- | --- |
| 撮影間隔 | 最短3秒 |
| スマホ操作のしきい値 | 0.8以上 |
| 可視性のしきい値 | 0.7以上 |
| 通知までの連続検出 | 3回 |
| 連続判定を引き継ぐ最大間隔 | 10秒 |
| 通知後の待機 | 60秒 |
| 判定タイムアウト／結果の最大経過時間 | 各10秒 |
| 最大保持セッション | 1000 |
| セッション当たりの受理済みフレームID | 10000 |
| 終了後のメモリ保持 | 30分。アクセス時に清掃 |

スマホが机に置いてあるだけの画像は操作として扱わず、手持ち・注視・タッチなど見えている行動で判定するよう問い合わせます。仕事目的かどうかを画像だけでは判断しないため、必要なスマホ操作には本人が一時停止を使います。

## HTTPエラー

```json
{
  "error": {"code":"unauthorized","message":"有効なBearerトークンが必要です。"},
  "request_id":"1bc054a3-54f3-4c08-8e7a-ac7d1b352640"
}
```

| HTTP | `error.code` | 対処 |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_json_object` | JSONオブジェクトを送る |
| 400 | `invalid_device_type`, `invalid_duration`, `invalid_action` | 入力値を修正する |
| 400 | `invalid_image`, `invalid_frame_id` | 画像形式・フレームIDを修正する |
| 400 | `request_interrupted` | 送信中断。現在の状態を確認する |
| 401 | `unauthorized` | アプリトークンを確認する |
| 403 | `origin_not_allowed`, `preflight_not_allowed` | Origin・送信ヘッダー・メソッドを確認する |
| 404 | `not_found`, `session_not_found` | URLを確認。再起動などで失効した場合は新規セッション |
| 405 | `method_not_allowed` | GET／POSTを契約どおりに使う |
| 409 | `frame_in_progress` | 進行中の送信完了を待つ |
| 413 | `body_too_large` | 画像は1 MiB以下、JSONは16 KiB以下にする |
| 415 | `unsupported_media_type` | 正しいContent-Typeを付ける |
| 429 | `session_limit`, `frame_limit` | 不要なセッションを終え、時間をおく／新規セッションを作る |
| 500 | `internal_error` | 通知せず、通信状態を表示する |

判定API自体の失敗は、多くの場合HTTP 200の`state: unknown`・`notify: false`として返します。HTTP成功を判定成功とみなさず、状態と理由を確認してください。

## JavaScriptクライアントの約束

`clients/focus-client.mjs`の`FocusClient({baseUrl, token})`を使用できます。

| メソッド／プロパティ | 用途 |
| --- | --- |
| `await start({deviceType: 'mac', durationSeconds: 1500})` | セッション開始 |
| `await frame(blob)` | JPEG／PNG Blobを送信。無効・古い・重複した処理ならnullになり得る |
| `await pause()` / `await resume()` / `await end()` | 操作完了を待つ。UIの操作連打を防ぐ |
| `await get()` | 最新の状態を取得 |
| `active` | falseなら撮影しない |
| `snapshot` | 最後の状態の表示用。保存済み通知を再実行しない |
| `remainingMs` | 残り時間の表示用 |

クライアントはカメラやOS通知を操作しません。呼び出し元が停止時の撮影停止と、通知IDの一度だけの実行を担当します。CoreS3など別実装でも、停止後の遅い結果の破棄と1回1送信を同じように守ります。

`remainingMs`は開始リクエスト時からの端末側タイマーです。API応答に残り時間フィールドはありません。端末側の期限が来ると`active`がfalseになり、保存されたスナップショットが`ended`／`reason: local_session_expired`に変わります。この理由はJavaScriptクライアントが付ける値で、HTTP APIの理由ではありません。

## 運用上の範囲

セッションは単一プロセスのメモリのみで、サーバー再起動で失われます。複数レプリカでの運用や利用者別認証はこの契約の範囲外です。生画像のファイル保存は行いませんが、実APIモードではOpenAIへ送信します。HTTPS終端・ホスティング設定・実機確認は配備時に別途実施します。

実APIの問い合わせは`gpt-6-luna`のDecisions APIで、`phone_use`と`observable`の2つのpredicate質問を使います。実キー・利用権限・実画像の認識精度は結合時に検証してください。

- [Decisions APIガイド](https://developers.openai.com/api/docs/guides/decisions)
- [Decisions APIリファレンス](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create)
