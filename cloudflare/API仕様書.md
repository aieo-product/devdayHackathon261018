# 共通判定API仕様書（Cloudflare Worker版・レビュー用）

> このファイルと同じチェックアウトの`openapi.yaml`は**5秒保持・60秒待機**版です。稼働中のWorkerはPR #6の**2秒保持・待機なし**版です。[現在の公開仕様書](https://focus-shared-api-20261018.take-otani.workers.dev/docs) / [版と検証の比較](../docs/evaluation.md)を参照してください。

公開URL：`https://focus-shared-api-20261018.take-otani.workers.dev`。ローカル：`http://127.0.0.1:8787`。REST + Bearer認証。仕様の実装元は`cloudflare/src/worker.mjs`と`api/src/engine.mjs`です。画面実装とは独立して、Mac・Reachy Mini・CoreS3から共通利用します。

Mac・Reachy Mini Wireless・CoreS3は、自分で撮影した画像をこのAPIへ送ります。APIがスマホを手に持つ状態の判定、5秒間の継続保持、通知間隔、セッション状態を管理します。端末はAPIが返した`notify: true`を、自機のOS通知・音・動きに変換します。端末側に独自のしきい値を持たせません。

## 公開仕様と共有

認証不要のGETルート：

| パス | 応答 | 共有URL |
| --- | --- | --- |
| `/` | API入口と仕様URLのJSON | https://focus-shared-api-20261018.take-otani.workers.dev/ |
| `/docs` | このAPI仕様書（Markdown） | https://focus-shared-api-20261018.take-otani.workers.dev/docs |
| `/openapi.json` | OpenAPI 3.1 JSON | https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json |
| `/health` | プロバイダーの設定状態 | https://focus-shared-api-20261018.take-otani.workers.dev/health |

API利用者のCloudflareメンバー登録は不要です。`FOCUS_API_TOKEN`は別経路で共有し、`OPENAI_API_KEY`はサーバー専用です。ドキュメントの公開自体は`/v1/`の認証を変更しません。`/health`の`configured`で設定状態を確認します。

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
- 同一セッションで同時に1画像だけ処理します。処理中に別のフレームIDを送ると409 `frame_in_progress`です。同じ受理済みフレームIDを再送した場合は、判定中でも200 `duplicate_frame`・`notify: false`を返します。
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
  "continuous_hold_ms": 5000,
  "required_hold_ms": 5000,
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
| `phone_probability` | number / null | 観測画像でスマホを手に持っている確率、0〜1。未判定／判定失敗時はnull |
| `observable_probability` | number / null | 対象の人・手元を判断できる可視性の確率、0〜1。未判定／判定失敗時はnull |
| `consecutive_count` | integer | 互換用の連続候補検出回数。通知条件ではない。通知時・非検出・判定不能・停止で0へ戻る |
| `continuous_hold_ms` | number | 最後の陽性画像で確認できた継続保持時間。最初は0、通知時は5000以上。GETや推論待ちだけでは増えない。cooldown中は達成時間を保持し、終了時・停止・非検出・判定不能で0へ戻る |
| `required_hold_ms` | number | 通知に必要な継続保持時間。現在は5000 |
| `cooldown_remaining_ms` | number | 通知抑制の残りミリ秒。終了済みは0 |
| `next_capture_after_ms` | number | 次の撮影まで待つ時間。0でもpaused／endedなら撮影しない |
| `provider` | string | `mock`または`openai`。UI／デモでモックを区別する |
| `reason` | string | 今回の状態／省略理由。下記一覧を参照 |

確率は集中度やADHDの診断値ではありません。GETやcontrolの応答は常に`notify: false`です。通知は新しいフレーム応答の`notify: true`を一度だけ消費し、表示用に保存されたスナップショットから繰り返し実行しません。

### 状態

| `state` | 表示例 | 撮影 |
| --- | --- | --- |
| `observing` | 見守り中 | 指定の間隔で撮影 |
| `suspected` | スマホ保持を確認中 | 指定の間隔で撮影。まだ通知しない |
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
| `phone_use_not_detected` | 判定条件を満たすスマホ保持を検出しなかった |
| `phone_use_suspected` | スマホ保持の候補だが継続時間が5秒未満 |
| `phone_use_confirmed` | 5秒の継続保持を確認して新しい通知を発行した |
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
| `decision_interrupted` | Worker再起動時に処理中だった判定を取り消した |

`reason`は補足説明です。通知の条件には必ず`notify`を使い、表示状態には`state`を使います。たとえばGETで`reason: phone_use_confirmed`が残っていても通知は再実行しません。

## サーバー内の判定設定

現在の既定値です。これらはHTTPリクエストで変更できず、調整はAPI担当がサーバーで行います。

| 設定 | 値 |
| --- | --- |
| 撮影間隔 | 目安1秒。5秒到達が先ならその時点の撮影を指定 |
| スマホ保持のしきい値 | 0.8以上 |
| 可視性のしきい値 | 0.7以上 |
| 通知までの継続保持 | 5000ms |
| 連続判定を引き継ぐ最大間隔 | 2500ms |
| 通知後の待機 | 60秒 |
| 判定タイムアウト／結果の最大経過時間 | 各10秒 |
| セッション数 | Workerは1セッション1 Durable Object。1000はエンジン内の上限で、Worker全体の上限ではない |
| セッション当たりの受理済みフレームID | 10000 |
| 終了・期限後の保持 | 約30分。Durable Object alarmで削除 |

スマホを手に持っていれば、見ていない・操作していない場合も対象です。机上に置いてあるだけの画像は対象外です。仕事目的かどうかは判定しないため、必要なスマホ利用には本人が一時停止を使います。

最初の陽性画像を受理した時刻を0msとし、以降の新しい陽性画像の受理時刻との差が5000ms以上なら、その判定応答で直ちに`notify: true`を返します。受理時刻は推論待ちの前に記録し、期限・停止は判定後にも確認します。4999msでは通知せず、5000msで陽性を新たに確認した場合に通知します。GET・同じフレームIDの再送・時間経過だけでは通知しません。

非検出・判定不能・providerエラー・pause・end、または受理画像の間隔が2500msを超えた場合は保持開始時刻と進捗を0に戻します。cooldown終了後も新たに5秒間の確認が必要です。`continuous_hold_ms`は確認済みの画像時刻に基づく値で、画面側で経過時間を足しません。

`next_capture_after_ms`は直前の受理時刻から1秒後と5秒到達予定時刻の早い方を基準にし、推論中に経過した時間を差し引きます。クライアントは応答からさらに固定1秒待つ処理を追加しません。

画像間の連続保持はサンプリングによる推定です。物理的に持った瞬間から通知まで正確に5.000秒とは保証できません。画像取得・通信・推論の遅延は実環境で計測します。とくに推論が遅く観測間隔が2500msを超える場合は継続保持が成立しません。未確認のローカルタイマーで通知を補いません。**旧「3秒間隔・3回連続」より、この5秒仕様を優先します。**

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
| 401 | `unauthorized` | アプリトークンを確認する |
| 403 | `origin_not_allowed`, `preflight_not_allowed` | Origin・送信ヘッダー・メソッドを確認する |
| 404 | `not_found`, `session_not_found` | URLを確認。再起動などで失効した場合は新規セッション |
| 405 | `method_not_allowed` | GET／POSTを契約どおりに使う |
| 409 | `frame_in_progress` | 進行中の送信完了を待つ |
| 413 | `body_too_large` | 画像は1 MiB以下、JSONは16 KiB以下にする |
| 415 | `unsupported_media_type` | 正しいContent-Typeを付ける |
| 429 | `frame_limit` | セッション当たりの画像数上限。現在のセッションを終えて新規セッションを作る |
| 500 | `internal_error` | 通知せず、通信状態を表示する |
| 503 | `service_not_configured` | FOCUS_API_TOKEN・Durable Object binding等の設定を確認する |
| 409 | `session_exists` | 作成済みセッションへの重複作成（通常の公開ルートでは新規IDが発行される） |

本文読取中断はWorkerでは汎用500 `internal_error`となります。`session_limit`は共有エンジン内部の制限ですが、1セッション1 Durable ObjectのWorker公開API全体の上限ではなく、通常の公開操作では到達しません。

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

`remainingMs`は開始リクエスト時からの端末側タイマーです。API応答にセッションの残り時間フィールドはありません。保持進捗の`continuous_hold_ms` / `required_hold_ms`とは別の値です。端末側の期限が来ると`active`がfalseになり、保存されたスナップショットが`ended`／`reason: local_session_expired`に変わります。この理由はJavaScriptクライアントが付ける値で、HTTP APIの理由ではありません。

全体の作業・進捗・結合条件は[issue #1](https://github.com/aieo-product/devdayHackathon261018/issues/1)に集約します。

## 運用上の範囲

Worker版はセッション状態・受理済みフレームIDをSQLite Durable Objectsへ保存し、Worker再起動後も復元します。処理中の再起動は判定を取り消し、`decision_interrupted`を返します。生画像は永続保存しません。openaiモードではOpenAIへ送信します。終了・期限後は約30分で状態を削除します。公開環境はCloudflareのHTTPS URLを利用します。利用者別認証は未実装です。

実APIの問い合わせは`gpt-6-luna`のDecisions APIで、`phone_use`と`observable`の2つのpredicate質問を使います。実キー・利用権限・実画像の認識精度は結合時に検証してください。

- [Decisions APIガイド](https://developers.openai.com/api/docs/guides/decisions)
- [Decisions APIリファレンス](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create)

## 配備設定とレビュー事項

- Secrets：`FOCUS_API_TOKEN`、`OPENAI_API_KEY`（実値は仕様書・ソースに記載しない）。
- `DECISION_PROVIDER`：`mock` / `openai`。配備の既定はopenai。ローカル`.dev.vars`例はmock。mockは画像を解析しない。
- `ALLOWED_ORIGINS`：カンマ区切りの完全一致Origin。既定は`http://localhost:3000,http://localhost:5173`。
- 共有トークンはデモ用。今後、端末別キー・scope・rate limit・利用者分離を設計する。
- レビュー重点：各端末の停止時の撮影中止と古い応答破棄、通知IDの一度だけの実行、実推論で観測間隔2500msを満たせるか、実画像の精度、公開URLとWeb Originの確定。
- 物理的な保持開始から正確に5秒後の通知を保証する仕様ではない。APIが確認済み画像に基づく継続時間と通知判断を返す。端末で不足時間を補完しない。
