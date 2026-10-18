# 共通判定API仕様書（MCP Events・遠隔監視を含む）

最終更新：2026-10-18（JST）。チーム共有・レビュー用。追加実装は [Issue #7](https://github.com/aieo-product/devdayHackathon261018/issues/7) / [PR #10](https://github.com/aieo-product/devdayHackathon261018/pull/10)（配備済み）です。

## 今回追加したこと

| 追加した機能 | できること | 担当者が対応すること |
| --- | --- | --- |
| **MCP Events / dots連携** | スマホ保持の検知を `focus.phone_held` として購読し、dotsへ届ける | dots接続はOAuthで認可。Mac以外の端末では新しい通知のメタデータ送信を実装 |
| **デバイスの監視ON/OFF** | Web画面・dotsから、同じプロフィールの別端末へ開始・停止を指示 | フロントは指示と状態表示、APIは状態管理、端末は実際の撮影・停止と報告を担当 |
| **Macの確認画面** | 端末一覧、遠隔操作の許可、ON/OFF、dots接続コード発行 | Events用設定を追加して起動。対象Macの画面で遠隔操作を許可 |

**既存の判定APIのURL・認証・応答はそのまま使えます。保持2秒、クールダウンなしも変更していません。** 追加機能を使わないクライアントに移行作業は不要です。

監視OFFはカメラ撮影・画像送信の停止です。端末本体の電源は切りません。OFF要求の成功と実際の停止完了は別で、端末からの報告を確認します。

### 最初に読む場所

- フロント・デバイス担当：[追加した端末制御REST](#追加した端末制御rest)
- dots担当：[追加したMCPとイベント配信](#追加したmcpとイベント配信)
- 結合・レビュー担当：[担当別の実装と確認状況](#担当別の実装と確認状況)
- 従来の画像判定：[判定APIの接続と認証](#判定apiの接続と認証)以降
- 配備・詳細な配送仕様：[Events WorkerのREADME](https://github.com/aieo-product/devdayHackathon261018/blob/feat/mcp-events-dots/cloudflare-events/README.md)

### 接続先は2つ

| 用途 | ベースURL | 認証 |
| --- | --- | --- |
| 既存：画像判定・セッション操作 | `https://focus-shared-api-20261018.take-otani.workers.dev` | `Bearer <FOCUS_API_TOKEN>` |
| 追加：端末登録・遠隔操作・イベント登録 | `https://focus-events-20261018.take-otani.workers.dev` | サーバー専用の `Bearer <INGEST_TOKEN>` |
| 追加：dotsのMCP接続 | `https://focus-events-20261018.take-otani.workers.dev/mcp` | OAuthアクセストークン |
| Mac確認画面 | `http://127.0.0.1:3000` | ローカルプロキシが上流用資格情報を補う |

`/devices/*` を既存の判定Workerへ送っても動きません。`FOCUS_API_TOKEN` と `INGEST_TOKEN` は別の値です。Mac側の `FOCUS_EVENTS_TOKEN` には `INGEST_TOKEN` と同じ値を設定します。`OPENAI_API_KEY` は従来どおり判定Worker専用です。

`INGEST_TOKEN` は全sourceを操作できる管理用の共通Secretです。**WebのJavaScriptに埋め込まず、利用者を認証したバックエンドで保持し、sourceをサーバー側で固定してください。** Events Workerには任意のWeb Origin向けCORSプリフライトの実装がありません。Webからは自分のバックエンドを経由します。OAuthのsource分離を、管理トークンにも適用される制限と取り違えないでください。

### 最新版を共有するURL

[この仕様書のGitHub版](https://github.com/aieo-product/devdayHackathon261018/blob/feat/mcp-events-dots/cloudflare/API仕様書.md)を共有してください。既存Workerの `/docs`・`/openapi.json` はそのWorkerを配備した時点の内容で、今回の文書更新だけでは置き換わりません。`openapi.yaml` / `openapi.json` は**既存の判定APIのみ**を記述し、追加Workerの仕様は本書とEvents READMEに記載しています。

---

判定APIはMac・Reachy Mini・CoreS3から画像を受け取り、スマホ保持とセッション状態を管理します。以下の既存判定APIの実装元は `cloudflare/src/worker.mjs` と `api/src/engine.mjs` です。

Mac・Reachy Mini Wireless・CoreS3は、自分で撮影した画像をこのAPIへ送ります。APIがスマホを手に持つ状態の判定、2秒間の継続保持、通知間隔、セッション状態を管理します。端末はAPIが返した`notify: true`を、自機のOS通知・音・動きに変換します。端末側に独自のしきい値を持たせません。

## 公開仕様と共有

認証不要のGETルート：

| パス | 応答 | 共有URL |
| --- | --- | --- |
| `/` | API入口と仕様URLのJSON | https://focus-shared-api-20261018.take-otani.workers.dev/ |
| `/docs` | このAPI仕様書（Markdown） | https://focus-shared-api-20261018.take-otani.workers.dev/docs |
| `/openapi.json` | OpenAPI 3.1 JSON | https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json |
| `/health` | プロバイダーの設定状態 | https://focus-shared-api-20261018.take-otani.workers.dev/health |

API利用者のCloudflareメンバー登録は不要です。`FOCUS_API_TOKEN`は別経路で共有し、`OPENAI_API_KEY`はサーバー専用です。ドキュメントの公開自体は`/v1/`の認証を変更しません。`/health`の`configured`で設定状態を確認します。

## 判定APIの接続と認証

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
- `next_capture_after_ms`まで待ってから次を撮影します。送り過ぎの場合は判定を省略し、`notify: false`で返します。既定では通知後のクールダウンはありません。
- 受理済みフレームIDを再送しても通知を再送しません。通信切断で通知応答を受け取れなかった場合の、通知の確実な再配送は実装していません。

### 一時停止・再開・終了

```json
{"action":"pause"}
```

`action`は`pause`、`resume`、`end`のいずれかです。終了済みセッションは再開できず、現在の`ended`状態を返します。一時停止・終了でサーバー内の処理世代を更新し、処理中の判定をキャンセルします。古い結果が戻っても通知しません。

**端末側でも**停止操作と同時に撮影タイマー・カメラを停止し、処理中のローカル取得を中止してください。コントロール要求が失敗しても、利用者が停止を指示した後に撮影を続けないようにします。開始・停止操作は必ず完了を待ち、連打を防ぎます。

## スナップショット全フィールド

通知時の例です。`next_capture_after_ms`は推論にかかった時間を差し引くため、実際の応答では0〜1000msになります。

```json
{
  "session_id": "a038a096-960c-4a0a-b5e2-0f407fe3d071",
  "state": "observing",
  "notify": true,
  "notification_id": "a30cd823-84c8-4718-a001-a91c14d20e34",
  "message": "スマホを置いて、作業に戻りませんか？",
  "phone_probability": 0.95,
  "observable_probability": 0.99,
  "consecutive_count": 0,
  "continuous_hold_ms": 2000,
  "required_hold_ms": 2000,
  "cooldown_remaining_ms": 0,
  "next_capture_after_ms": 1000,
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
| `continuous_hold_ms` | number | 最後の陽性画像で確認できた継続保持時間。最初は0、通知応答は2000以上。次の新しい陽性画像から新たな2秒の確認を始める。GETや推論待ちだけでは増えない。停止・非検出・判定不能で0へ戻る |
| `required_hold_ms` | number | 通知に必要な継続保持時間。現在は2000 |
| `cooldown_remaining_ms` | number | 互換用の通知抑制残り時間。既定では常に0 |
| `next_capture_after_ms` | number | 次の撮影まで待つ時間。0でもpaused／endedなら撮影しない |
| `provider` | string | `mock`または`openai`。UI／デモでモックを区別する |
| `reason` | string | 今回の状態／省略理由。下記一覧を参照 |

確率は集中度やADHDの診断値ではありません。GETやcontrolの応答は常に`notify: false`です。通知は新しいフレーム応答の`notify: true`を一度だけ消費し、表示用に保存されたスナップショットから繰り返し実行しません。

### 状態

| `state` | 表示例 | 撮影 |
| --- | --- | --- |
| `observing` | 見守り中 | 指定の間隔で撮影 |
| `suspected` | スマホ保持を確認中 | 指定の間隔で撮影。まだ通知しない |
| `cooldown` | 通知後の待機（互換用） | 既定では使わない。待機を設定したサーバーでは指定時間だけ撮影を休む |
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
| `phone_use_suspected` | スマホ保持の候補だが継続時間が2秒未満 |
| `phone_use_confirmed` | 2秒の継続保持を確認して新しい通知を発行した |
| `insufficient_visibility` | 人・手元が十分見えず判定できない |
| `cooldown_active` | 互換用。待機を設定したサーバーで通知後の待機中なので判定しない |
| `cooldown_finished` | 互換用。待機を設定したサーバーで通知後の待機が終了した |
| `cooldown_disabled` | 設定変更により以前の通知後待機を解除した |
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
| 撮影間隔 | 目安1秒。2秒到達が先ならその時点の撮影を指定 |
| スマホ保持のしきい値 | 0.8以上 |
| 可視性のしきい値 | 0.7以上 |
| 通知までの継続保持 | 2000ms |
| 連続判定を引き継ぐ最大間隔 | 2500ms |
| 通知後の待機 | 0秒（クールダウンなし） |
| 判定タイムアウト／結果の最大経過時間 | 各10秒 |
| セッション数 | Workerは1セッション1 Durable Object。1000はエンジン内の上限で、Worker全体の上限ではない |
| セッション当たりの受理済みフレームID | 10000 |
| 終了・期限後の保持 | 約30分。Durable Object alarmで削除 |

スマホを手に持っていれば、見ていない・操作していない場合も対象です。机上に置いてあるだけの画像は対象外です。仕事目的かどうかは判定しないため、必要なスマホ利用には本人が一時停止を使います。

最初の陽性画像を受理した時刻を0msとし、以降の新しい陽性画像の受理時刻との差が2000ms以上なら、その判定応答で直ちに`notify: true`を返します。受理時刻は推論待ちの前に記録し、期限・停止は判定後にも確認します。1999msでは通知せず、2000msで陽性を新たに確認した場合に通知します。GET・同じフレームIDの再送・時間経過だけでは通知しません。

非検出・判定不能・providerエラー・pause・end、または受理画像の間隔が2500msを超えた場合は保持開始時刻と進捗を0に戻します。通知後のクールダウンはなく、通常の撮影間隔で判定を続けます。通知応答は`state: observing`、`cooldown_remaining_ms: 0`となり、達成した保持時間を含みます。次の新しい陽性画像から新たに2秒間の確認を始めるため、持ち続けた場合も繰り返し通知できます。`continuous_hold_ms`は確認済みの画像時刻に基づく値で、画面側で経過時間を足しません。

`next_capture_after_ms`は直前の受理時刻から1秒後と2秒到達予定時刻の早い方を基準にし、推論中に経過した時間を差し引きます。クライアントは応答からさらに固定1秒待つ処理を追加しません。

画像間の連続保持はサンプリングによる推定です。物理的に持った瞬間から通知まで正確に2.000秒とは保証できません。画像取得・通信・推論の遅延は実環境で計測します。とくに推論が遅く観測間隔が2500msを超える場合は継続保持が成立しません。未確認のローカルタイマーで通知を補いません。**旧「3秒間隔・3回連続」より、この2秒仕様を優先します。**

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

上流の非2xx応答はサーバーログの `openai_decision_error` でHTTPステータスと許可した `code` / `type` だけを診断できます。未知の分類は `unknown`。キー・画像・上流メッセージ・ヘッダーはログに残さず、公開レスポンスは `provider_error` のままです。`401 / invalid_api_key` はOpenAI側でキーが認証されていないことを示します。Secretを更新後、`npm run smoke:worker` で両確率が数値として返ることまで確認してください。`/health` の `configured:true` だけでは認証成功を確認できません。

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
- 物理的な保持開始から正確に2秒後の通知を保証する仕様ではない。APIが確認済み画像に基づく継続時間と通知判断を返す。端末で不足時間を補完しない。

## 追加した端末制御REST

この節は **Events Worker** 向けです。全操作がJSONのPOSTで、`Content-Type: application/json` と `Authorization: Bearer <INGEST_TOKEN>` が必要です。JSONは64 KiB以下。OAuthのアクセストークンや判定APIのトークンでは呼び出せません。

疎通確認用の `GET /health` だけは認証不要で、`{"service":"focus-events","protocol_version":"2026-07-28","configured":true}` を返します。既存判定Workerの `provider` 形式とは異なり、カメラ・dotsへの接続成功を保証しません。

| メソッド・パス | JSON入力 | 成功応答 |
| --- | --- | --- |
| `POST /devices/heartbeat` | `source_id, device_id, device_type, observed_state, remote_enabled, applied_revision`、任意の `name, session_id` | 200、端末状態。初回は登録も行う |
| `POST /devices/list` | `{source_id}` | 200、`{devices: [...]}` |
| `POST /devices/control` | `{source_id, device_id, enabled}` | 200、指示保存後の端末状態 |
| `POST /admin/pairing` | `{source_id}` | 201、`{code, expires_at}`。OAuth接続用、10分・1回限り |
| `POST /events/ingest` | `{source_id, event}` | 202、`{accepted, duplicate, eventId, queued}`。外部配信完了を意味しない |

### IDと端末登録

| フィールド | 契約 |
| --- | --- |
| `source_id` | プロフィール／所有者グループの固定ID。16〜80文字、英数字・`_`・`-`。Macでは固定UUIDを使う |
| `device_id` | source内で一意の固定端末ID。英数字で始まる1〜128文字、英数字・`_.:-` |
| `device_type` | 英小文字で始まる64文字以内の英小文字・数字・`_`・`-`。例：`mac`, `reachy_mini`, `cores3` |
| `name` | 任意の表示名。空白だけ・制御文字は不可、80文字以内。初回省略時はdevice ID、以後の省略時は既存名を維持 |
| `observed_state` | 実際の状態：`on` / `off` / `blocked` / `error` |
| `remote_enabled` | 端末の利用者が遠隔操作を許可しているか。boolean |
| `applied_revision` | 処理した指示番号。0以上の整数。初回登録は0 |
| `session_id` | 任意。判定APIの稼働中セッションID。未稼働時はnull。省略してもnullに戻る |

同じWeb画面・dotsから複数端末を操作する場合、各アダプターで**同じsource ID、異なるdevice ID**を使います。IDを起動ごとに変えないでください。`source_id` は利用者の識別、`device_id` は端末の識別、既存APIの `session_id` は1回の監視の識別です。相互に代用しません。

Macの `FOCUS_DEVICE_ID` は省略すると `FOCUS_SOURCE_ID` と同じ値になります。複数端末を接続するときは端末ごとの値を明示します。保存済みより小さい `applied_revision` のheartbeatは状態・許可の更新に使わず、最終接続時刻だけを更新します。

初回heartbeat例です。これは登録・状態報告であり、カメラを起動する指示ではありません。

```json
{
  "source_id": "00000000-0000-4000-8000-000000000001",
  "device_id": "mac-demo-01",
  "device_type": "mac",
  "name": "デモ用Mac",
  "observed_state": "off",
  "remote_enabled": false,
  "applied_revision": 0,
  "session_id": null
}
```

### ON/OFFと完了確認

`POST /devices/control` に送るJSONです。ONは `true`、OFFは `false` を指定します。これは信頼するバックエンドからの呼び出しです。

```json
{
  "source_id": "00000000-0000-4000-8000-000000000001",
  "device_id": "mac-demo-01",
  "enabled": false
}
```

OFF要求直後の応答例：

```json
{
  "device_id": "mac-demo-01",
  "name": "デモ用Mac",
  "type": "mac",
  "desired_state": "off",
  "observed_state": "on",
  "remote_enabled": true,
  "revision": 4,
  "applied_revision": 3,
  "last_seen_at": "2026-10-18T06:00:00.000Z",
  "online": true,
  "command_issued_at": "2026-10-18T06:00:01.000Z",
  "command_expires_at": null,
  "session_id": "a038a096-960c-4a0a-b5e2-0f407fe3d071"
}
```

**この例は「停止指示済み・反映待ち」です。** 入力の `device_type` は応答では `type` になります。

| 応答フィールド | フロントでの扱い |
| --- | --- |
| `desired_state` | 最後の遠隔指示。`on` / `off` |
| `observed_state` | 端末が報告した実状態。オフライン時は過去の報告として表示 |
| `revision` / `applied_revision` | 最新指示番号／端末が処理した番号。不一致なら反映待ち |
| `online` / `last_seen_at` | 最終heartbeatから10秒以内がonline。切断中は現在の撮影状態を断定しない |
| `command_issued_at` / `command_expires_at` | 指示時刻／未処理ONの期限。ISO UTC文字列またはnull |
| `remote_enabled` | 端末側の遠隔操作許可。falseならONを案内せず、対象端末で許可してもらう |

端末が撮影停止後、`observed_state:"off", applied_revision:4` をheartbeatで報告すれば、指示4への停止確認が取れます。`applied_revision` は「処理済み」で、成功とは限りません。ONの成功表示には `observed_state:"on"` も確認し、`blocked` / `error` は別表示にしてください。手動操作で状態が変わることもあるため、指示と実状態は両方表示します。

1. 端末は約2秒ごとにheartbeatを送信し、返った最新指示を確認します。リクエストを重ねず、古い応答で新しい状態を上書きしません。
2. 新しいONは `online:true` かつ `remote_enabled:true` の端末にだけ受け付けます。端末側でも許可・期限を確認して撮影を開始します。
3. OFFはオフラインでも保存します。指示を受け取った端末がまずカメラ・撮影タイマーを止め、その後に既存セッション終了とheartbeatを行います。
4. 未処理ONは120秒で期限切れです。次のheartbeat・一覧・制御アクセス時に新しいOFF指示へ切り替わります。処理済みONを120秒後に自動停止する機能ではありません。
5. 端末側で許可を解除するとON指示を取り消します。Macではページを隠す・閉じる場合も停止・許可解除します。
6. 同じON/OFFを再送しても新しいrevisionになります。成功済み要求を自動で繰り返さず、タイムアウト時は状態を確認します。

### MacローカルUIから呼ぶ場合

Mac確認サーバーを起動した同一Originからのみ利用します。上の公開RESTと似ていますが、**ブラウザはsourceやSecretを渡しません**。ローカルプロキシが注入します。

ローカルJSONの上限は16 KiBです。上流への端末操作は8秒、ペアリングは10秒でタイムアウトします。タイムアウトしても指示が保存済みの可能性があるため、一覧で確認します。

| ローカルのパス | ブラウザから送るJSON |
| --- | --- |
| `POST /devices/list` | `{}` |
| `POST /devices/control` | `{"device_id":"mac-demo-01","enabled":false}` |
| `POST /devices/heartbeat` | `{"observed_state":"off","remote_enabled":false,"applied_revision":0,"session_id":null}`（任意のnameも可） |
| `POST /mcp/pairing` | `{}`。成功200で接続コードを返す |

ブラウザからheartbeatの `source_id` / `device_id` / `device_type` を指定すると拒否します。別端末の操作はcontrolの `device_id` で指定します。このlocalhost用プロキシは一般公開Webの認証サーバーではありません。

### 追加RESTのエラー

Events Workerのエラー形式は、既存判定APIの `error.code` と異なります。例：HTTP 409 `{"error":"remote_disabled","message":"Enable remote control on the device before remote start."}`。messageは付かない場合があります。`request_id` を返す契約はありません。

| HTTP | `error` | 対処 |
| --- | --- | --- |
| 400 | `invalid_source_id`, `invalid_device_request`, `invalid_request` | JSON・ID・型・余分なフィールドを確認 |
| 401 | `unauthorized` | Events用の管理トークンを確認 |
| 404 | `device_not_found` | 同じsourceで端末がheartbeat登録されているか確認 |
| 409 | `device_offline` | 対象端末を接続し、heartbeatを確認 |
| 409 | `remote_disabled` | 対象端末で遠隔操作を許可 |
| 409 | `future_revision` | 未発行の指示番号を報告している。最新状態と端末の処理を確認 |
| 413 / 415 | `body_too_large` / `invalid_request` | 64 KiB以下のJSON・Content-Typeに修正 |
| 429 | `device_capacity`, `capacity_exceeded` | 登録・配送上限を確認。端末はsourceあたり20台、全体200台 |
| 503 | `service_not_configured`, `service_unavailable` | Events Workerの設定・稼働状態を確認 |

ローカルプロキシでは `{"error":{"code":"...","message":"..."}}` 形式へ変換され、上流エラーが502へ変換される場合もあります。MCPは次節の `result.isError` / JSON-RPCエラーも確認してください。

## 追加したMCPとイベント配信

接続先は `https://focus-events-20261018.take-otani.workers.dev/mcp` です。dotsは管理用Secretではなく、ペアリング式OAuth（Authorization Code + PKCE S256）で接続します。

1. [Mac起動手順](https://github.com/aieo-product/devdayHackathon261018/blob/feat/mcp-events-dots/tools/mac-camera-check/README.md)に従い、`FOCUS_EVENTS_URL`、`FOCUS_EVENTS_TOKEN`、`FOCUS_SOURCE_ID`、必要なら `FOCUS_DEVICE_ID` を設定します。
2. `http://127.0.0.1:3000/mcp/setup` で接続コードを発行します。
3. ChatGPTのカスタムMCP接続に上記URLとOAuthを設定し、認可画面で接続コードと表示された権限を確認して接続します。DCRでクライアント登録し、コードは10分間・一度だけ使えます。
4. dotsでこの接続を有効にし、イベント購読や端末操作を依頼します。

| OAuth scope | 使えるメソッド・ツール |
| --- | --- |
| `focus:read` | `server/discover`, `tools/list`, `get_profile`, `get_focus_status`, `get_focus_events`, `list_focus_devices` |
| `focus:events` | `events/list`, `events/subscribe`, `events/unsubscribe` |
| `focus:control` | `set_device_monitoring` |

`list_focus_devices` の引数は `{}`、`set_device_monitoring` は `{"device_id":"mac-demo-01","enabled":false}` です。sourceはOAuthの接続から決まり、引数に指定しません。成功しても停止済みとは限らないため、端末一覧で実状態を再確認します。ツールの失敗はHTTP 200でも `result.isError:true` と `result.structuredContent.error` に入る場合があります。認証・scope不足はHTTP 401/403、MCPプロトコルの失敗はJSON-RPC `error` です。

| 読み取りツール | 引数 | `result.structuredContent` |
| --- | --- | --- |
| `get_profile` | `{}` | `{id, name}`。idはOAuthのsource |
| `get_focus_status` | `{}` | `{subscriptions, pending_deliveries, limits}` |
| `get_focus_events` | `{session_id?, limit?}` | `{events, cursor:null}`。limitは既定20、1〜100。session_idフィルターは英数字・ハイフンの1〜80文字 |
| `list_focus_devices` | `{}` | `{devices: [...]}`。前節の端末状態 |

履歴は全source合計で最新100件・最大24時間から、認可されたsourceの分だけを返します。各sourceに100件ずつ保持する契約ではありません。`events/subscribe` 等はJSON-RPCのmethod名であり、RESTの `/events/subscribe` というURLはありません。

MCP 2.0（`2026-07-28`）を実装しています。手書きクライアントでは `MCP-Protocol-Version` / `Mcp-Method` / tools呼び出しの `Mcp-Name` と本文 `params._meta` の一致が必要です。旧 `initialize` フローやGETによる常設SSEには対応していません。[詳細なMCP・OAuth仕様](https://github.com/aieo-product/devdayHackathon261018/blob/feat/mcp-events-dots/cloudflare-events/README.md)を参照してください。

### 検知イベントの中身

イベント名は `focus.phone_held`。新しいフレームの応答が `notify:true` の場合だけ、画像を含まないメタデータを送ります。以下を `POST /events/ingest` の `event` に指定し、外側に `source_id` を付けます。Webhookでもこのイベント形式を使用します。

```json
{
  "eventId": "notification-example-001",
  "name": "focus.phone_held",
  "timestamp": "2026-10-18T06:00:00.000Z",
  "data": {
    "notification_id": "notification-example-001",
    "session_id": "a038a096-960c-4a0a-b5e2-0f407fe3d071",
    "device_type": "mac",
    "continuous_hold_ms": 2300,
    "required_hold_ms": 2000,
    "phone_probability": 0.95,
    "observable_probability": 0.99,
    "provider": "openai"
  },
  "cursor": null
}
```

`eventId` と `data.notification_id` は同じ値にします。dataは上記8項目のみです。画像・任意の通知文・APIキーは送らず、GETや保存済みスナップショットから再発行しません。購読は `session_id` / `device_type` で絞れます。個別の `device_id` は現在のイベントに含まず、device IDでの購読フィルターも未対応です。

署名付きWebhookで配送し、sourceと通知IDで24時間重複排除します。受信側も通知IDで重複実行を防いでください。購読期限は最大24時間で更新が必要です。Workerの配送は最大5回試行、Macの中継は最大3回試行します。Macの中継はメモリー上なのでプロセス終了などで未配送イベントを失う場合があります。**配信失敗で既存の画像判定・Mac通知を停止しません。**

現状の自動中継はMac確認UIのローカルサーバーに実装済みです。Reachy/CoreS3や別のWeb画面が判定APIへ直接接続するだけでは、dotsイベントは発行されません。その呼び出し元のサーバー／アダプターにも中継が必要です。

dotsへの依頼例：

> Focusのfocus.phone_heldを購読して、届いたらスマホを置くよう一言で知らせて。

> Focusの端末一覧を見せて。mac-demo-01の監視をOFFにして、停止したか確認して。

イベントの購読解除とカメラ停止は別です。OAuth接続を解除しても、動作中端末の撮影が自動で止まる契約ではありません。撮影を止める場合はOFF指示または対象端末の停止操作を使います。

## 担当別の実装と確認状況

| 担当 | 今回の対応 |
| --- | --- |
| フロント | 認証済みバックエンド経由で端末一覧・controlを呼ぶ。ON/OFF指示、反映待ち、online、実状態、遠隔許可を別々に表示 |
| 端末・ガジェット | 固定IDでheartbeat。新しい指示を処理してACK。OFFを受けたらカメラを先に止める。検知のdots連携にはメタデータ中継も実装 |
| dots | OAuth接続、必要scopeの同意、イベント購読・更新・解除、操作後の状態確認 |
| API | 既存判定WorkerとEvents Workerを別々に運用。資格情報・source設定、許可されたWebhook送信先、配送状態を管理 |

| 項目 | 2026-10-18時点 |
| --- | --- |
| Events Worker・端末制御REST・MCP | 実装・配備済み。変更内容はPR #10を参照 |
| Mac確認UIの遠隔ON/OFF・イベント中継 | 実装済み。画面を開いて表示し、端末側で許可した間だけ遠隔ON可能 |
| 公開APIでの検証 | 仮想カメラでON→2秒検知2回→同じ通知IDの履歴保存→OFF・全track停止・ACKを確認 |
| 自動テスト | 157件成功（既存37＋1、Events68、Mac51）。公開Worker smoke12項目成功 |
| 実dotsの購読・通知 | アカウントでOAuth接続した後の確認が残る |
| Reachy Mini / CoreS3 | 遠隔制御用の撮影・停止・heartbeatアダプターは未実装・実機未検証 |
| 端末本体の電源操作・端末別管理キー・端末削除 | 未実装 |

今回の仕様書更新はPRに反映し、既存の判定Workerを再配備せず共有します。実装・配備の手順と詳細な試験範囲は[Events WorkerのREADME](https://github.com/aieo-product/devdayHackathon261018/blob/feat/mcp-events-dots/cloudflare-events/README.md)を参照してください。
