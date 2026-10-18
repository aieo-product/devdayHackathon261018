# Focus MCP Events / dots・遠隔監視

**チーム全体への周知は[共通API仕様書](../cloudflare/API仕様書.md)を共有してください。** 冒頭に今回の追加点、2つのWorkerの使い分け、認証、担当別の対応をまとめています。本書は追加Workerの配備・運用・MCP Eventsの詳細です。

スマホ保持の検知を `focus.phone_held` イベントとしてChatGPT Work / dotsへ届け、Web画面やdotsから同じプロフィールに登録した端末の監視をON/OFFするための独立Workerです。既存の[共通判定API](../cloudflare/README.md)のコード・設定・配備は変更しません。

判定APIは画像を解析し、端末は撮影と実際の停止を担当します。このWorkerはイベント配送と監視指示・実際の端末状態を保存します。監視OFFはカメラ撮影・画像送信の停止であり、端末本体の電源OFFではありません。

- 作業Issue: [#7 MCP Events / dots連携](https://github.com/aieo-product/devdayHackathon261018/issues/7)
- MCP接続先: `https://focus-events-20261018.take-otani.workers.dev/mcp`
- 稼働確認: `https://focus-events-20261018.take-otani.workers.dev/health`
- Mac確認UI: [起動・操作手順](../tools/mac-camera-check/README.md)

Events Workerは上記URLへ配備済みで、認証を含む公開APIの疎通試験を確認しました。`/health`の応答だけではdotsからの購読・通知や実機制御まで確認できません。検証範囲は末尾を参照してください。

## 構成と権限

```text
Macカメラ → ローカルプロキシ → 既存の共通判定API → OpenAI
                  │ 新しい notify:true の応答からメタデータだけ複製
                  └→ このWorker → 署名付きWebhook → dots

Web画面 / dots → このWorkerに監視指示を保存
端末アダプター → heartbeatで指示を取得 → 撮影開始・停止 → 実際の状態を報告
```

Macの即時通知は従来どおり判定APIの応答で動きます。イベント配送を待ちません。Events Workerには画像・OpenAIキー・判定APIトークンを送りません。

| 設定 | 保存場所・用途 |
| --- | --- |
| `INGEST_TOKEN` | このWorkerのSecret。信頼するサーバーからのイベント登録・端末操作・ペアリング発行用。32文字以上のランダム値 |
| `FOCUS_EVENTS_TOKEN` | Macローカルサーバーの環境変数。`INGEST_TOKEN`と同じ値。ブラウザに渡さない |
| `FOCUS_EVENTS_URL` | Events WorkerのHTTPS Origin。末尾に `/mcp` を付けない |
| `FOCUS_SOURCE_ID` | ひとつのプロフィールを表す固定UUID。OAuthの接続先・イベント・端末一覧の所有者を識別 |
| `FOCUS_DEVICE_ID` | 端末ごとの固定ID。同じプロフィール内で重複させない |
| `PUBLIC_ORIGIN` | 配備したEvents WorkerのHTTPS Origin。OAuthのissuerとresourceを決める |
| `MCP_CALLBACK_HOSTS` | Webhook送信先の完全一致ホスト名リスト。既定はOpenAIの信頼するホストのみ |

複数端末をひとつのWeb画面・dots接続から操作する場合は、各サーバーで同じ `FOCUS_SOURCE_ID` と異なる `FOCUS_DEVICE_ID` を設定します。別の利用者は別の `FOCUS_SOURCE_ID` にします。再起動ごとにIDを作り直さないでください。

OAuthで接続した利用者からは自分のsourceだけが見えます。ただし、`INGEST_TOKEN`はsourceを指定できる管理用の共通資格情報です。端末ごとに権限を分ける仕組みではありません。信頼するアダプターだけで扱い、ブラウザや一般配布するアプリには埋め込みません。第三者へ配布する端末には、別途端末別の認証・登録フローが必要です。

## Workerの起動・配備

Node.js 22.9以上を使い、リポジトリ直下で実行します。既存APIの `cloudflare/wrangler.jsonc` と、このWorkerの `cloudflare-events/wrangler.jsonc` を取り違えないでください。

```sh
npm install
npm run test:events
npm run check:events
```

ローカル用の `cloudflare-events/.dev.vars` に管理用トークンを設定します。実値のファイルはGit管理対象外です。

```dotenv
INGEST_TOKEN=replace-with-a-random-secret-of-at-least-32-characters
```

```sh
npm run start:events
```

ローカルのテストはMiniflareと偽のWebhook受信先を使います。ChatGPTがアクセスするOAuth/MCP接続には公開HTTPSが必要です。

本番配備時は `wrangler.jsonc` のWorker名・`PUBLIC_ORIGIN`を配備先に合わせ、Secretを入力します。

```sh
npx wrangler secret put INGEST_TOKEN -c cloudflare-events/wrangler.jsonc
npm run deploy:events
```

`/health` は認証不要で構成の有無を返します。カメラやOpenAIへの疎通確認は行いません。SQLite Durable ObjectにOAuth認可・購読・配送待ち・端末状態を保存します。既存の判定APIとは別の名前空間です。

配備後の疎通試験は、Macと同じ `cloudflare/.env.connection` のEvents設定を使います。

```sh
npm run smoke:events
```

設定したsourceから派生する試験専用プロフィールと偽端末を使い、OAuth・MCP・監視指示と応答・イベント登録を確認します。実端末、カメラ、OpenAI推論、dots購読、外部Webhookは使いません。実端末の撮影成功やdotsへの配信を証明する試験ではありません。

## Macとdotsの接続

1. [Mac確認UIの設定](../tools/mac-camera-check/README.md)にEvents用の環境変数を追加し、ローカルサーバーを再起動します。
2. `http://127.0.0.1:3000/mcp/setup` を開きます。この画面だけではカメラは起動しません。
3. ChatGPTのPluginsからカスタムMCPサーバーを追加し、上記 `/mcp` URLとOAuth認証を指定します。クライアント登録はDCRです。
4. ローカル画面でペアリングコードを発行し、WorkerのOAuth画面で入力して、表示された権限を許可します。コードは10分間有効・1回限りです。
5. 接続したFocusをdotsで有効にし、例えば次のように依頼します。

> Focusのfocus.phone_heldを購読して、イベントが届いたらスマホを置いて集中に戻るよう一言で知らせて。解除するまで監視して。

カメラ確認画面へ戻り、画面を表示したまま検知を行います。dotsへの配送は非同期で、Macの表示と時間差があります。継続購読にはクライアントが `refreshBefore` より前に購読を更新する必要があります。

停止するときはdotsへ購読解除を依頼します。撮影自体を止める場合は、Macで終了するか監視OFFを指示してください。イベントの購読解除とカメラ停止は別の操作です。OAuth接続の解除は、その認可に属するイベント配送も無効にします。

### OAuthの範囲

| scope | 許可される操作 |
| --- | --- |
| `focus:read` | プロフィール・履歴・配送状態・端末一覧の取得 |
| `focus:events` | イベント定義の取得、購読、購読解除 |
| `focus:control` | 指定端末への監視ON/OFF指示 |

Authorization Code + PKCE S256を使います。resourceは公開Originに `/mcp` を付けた完全一致URLです。アクセストークンは最大15分、認可は30日間で、refresh tokenは使用ごとにローテーションします。再使用を検知すると認可を取り消します。古い接続に `focus:control` は自動追加されないため、制御を使う場合は再接続して権限を許可します。

対応redirect URIはChatGPTの公式HTTPSコールバックのみです。任意のOAuthクライアント・CIMD・旧MCP初期化フローを網羅した認証サービスではありません。

## MCPの呼び出し

MCP 2.0の `2026-07-28` を使う `POST /mcp` です。1回に1件のJSON-RPCを送り、`MCP-Protocol-Version`、`Mcp-Method`、`tools/call`の場合は `Mcp-Name` を本文と一致させます。本文の `params._meta` にはプロトコルバージョンとclient capabilitiesを含めます。旧式の `initialize`、常設SSE、GETによるイベント受信は実装していません。

| メソッド / ツール | 用途 |
| --- | --- |
| `server/discover` / `tools/list` | プロトコル・ツールの発見 |
| `get_profile` | OAuth接続先の安定したプロフィールID |
| `get_focus_status` | 購読・配送成功/失敗・待ち件数 |
| `get_focus_events` | 最近のイベント。任意の `session_id`、`limit` 1〜100 |
| `list_focus_devices` | 同じプロフィールの端末一覧・実際の監視状態 |
| `set_device_monitoring` | `{ "device_id": "mac-demo-1", "enabled": false }` で監視指示 |
| `events/list` | `focus.phone_held` の定義 |
| `events/subscribe` / `events/unsubscribe` | Webhook購読・解除 |

`set_device_monitoring`は状態変更ツールです。成功応答は指示の保存を意味し、端末での停止完了を保証しません。実行後は端末一覧の `observed_state` と `applied_revision` を確認します。

## 検知イベント

新しい画像の判定で `notify:true` になったときだけ生成します。既存APIの条件は継続保持2秒、通知後のクールダウンなしです。GETした状態や重複画像の応答から新しいイベントを作りません。

```json
{
  "eventId": "notification-example-001",
  "name": "focus.phone_held",
  "timestamp": "2026-10-18T06:00:00.000Z",
  "data": {
    "notification_id": "notification-example-001",
    "session_id": "session-example-001",
    "device_type": "mac",
    "continuous_hold_ms": 2400,
    "required_hold_ms": 2000,
    "phone_probability": 0.98,
    "observable_probability": 0.99,
    "provider": "openai"
  },
  "cursor": null
}
```

購読の `arguments` は空オブジェクト、または `session_id` / `device_type` の完全一致フィルターです。両方指定した場合は両条件に合うイベントを配送します。`eventId`と`notification_id`は同じ値です。画像、自由文、端末からの命令文をペイロードに含めません。

購読時は署名したchallengeをWebhookへ送り、正しい応答を確認してから有効にします。通常配送もStandard Webhooks形式で署名します。HTTPS・完全一致ホストのみ許可し、リダイレクト、IPリテラル、ローカル宛先は拒否します。既定の許可先は `chatgpt.com`、`chat.openai.com`、`api.openai.com` です。実際のChatGPT callbackが別ホストなら、公式の送信先を確認して設定を更新します。

任意の外部ホストを安全に中継するサービスではありません。Cloudflare fetchでDNS解決後の宛先IPを固定する処理はなく、許可リストは管理者が信頼するホストだけに限定します。

### 配送・保存の上限

- 購読期限は既定・最大24時間、最小60秒。`ttlMs:null`も無期限にはなりません。過去イベントのcursor再送は未対応です。
- 同じsourceの同じ通知IDは24時間重複排除します。Webhook再試行では同じIDを使うため、受信側もIDで重複を除いてください。厳密な一度だけの配信は保証しません。
- 配送待ちは永続化し、最大5回試行します。一時的な失敗を再試行し、410は購読を無効化、413はそのイベントを破棄します。
- 上限はsourceあたり64購読、全体256購読、配送待ち1,000件、重複排除ID10,000件。容量不足は429で拒否し、既存IDを追い出して重複防止を崩しません。
- 履歴は全体で最新100件・最大24時間です。読み取りはsourceごとに分離しますが、各sourceに100件ずつ保持する保証はありません。
- Mac側の送信待ちはメモリー上64件、通知IDの重複排除は1,024件、最大3回試行です。ローカルプロセス終了や長い障害では配送できない場合があります。画像判定とローカル通知は継続します。

## 遠隔監視API

Web UIはON/OFF操作を送り、APIが望まれる状態と指示番号を保存し、実機アダプターが撮影を開始・停止します。`desired_state` と `observed_state` を分けることで、未接続の端末に停止指示を出しただけで「停止済み」と表示することを防ぎます。

以下は信頼するサーバー・端末アダプター用REST APIです。すべてJSONのPOST、`Authorization: Bearer <INGEST_TOKEN>` が必要です。Webフロントエンドから共通Secretを直接送らず、認証済みの自分のバックエンドを経由してください。Mac確認UIはローカルプロキシが資格情報とsourceを補います。

| パス | 入力 | 応答 |
| --- | --- | --- |
| `/admin/pairing` | `{source_id}` | 一度限りの `code`, `expires_at` |
| `/events/ingest` | `{source_id, event}` | `accepted`, `duplicate`, `eventId`, `queued` |
| `/devices/heartbeat` | `{source_id, device_id, device_type, name?, observed_state, remote_enabled, applied_revision, session_id?}` | 端末状態 |
| `/devices/list` | `{source_id}` | `{devices: [...]}` |
| `/devices/control` | `{source_id, device_id, enabled}` | 更新後の端末状態 |

`source_id` は16〜80文字の英数字・`_`・`-`（MacアダプターではUUID）。`device_id` は英数字で始まる1〜128文字で、英数字と `_.:-` を使用できます。`device_type` は `mac`、`reachy_mini`、`cores3` などの小文字名です。端末名は80文字までです。`observed_state` は `on` / `off` / `blocked` / `error` です。

端末状態の応答例です。入力の `device_type` に対応する応答フィールド名は `type` です。

```json
{
  "device_id": "mac-demo-1",
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
  "session_id": "session-example-001"
}
```

この例はOFFを指示済みですが、端末はまだ指示4を処理していません。撮影停止を確認した後、端末は `observed_state:"off", applied_revision:4` でheartbeatします。エラーや開始を拒否した場合も、処理した指示番号と `blocked` / `error` を報告します。`applied_revision`だけでON成功と判断しません。

- 初回登録は指示OFF・revision 0。端末は現在の状態を正直に報告します。
- 最終heartbeatから10秒以内をonlineとします。目安として2秒ごとにheartbeatします。
- 遠隔ONはonlineかつ端末側 `remote_enabled:true` の場合だけ受け付けます。OFFはofflineや遠隔許可なしでも保存できます。
- ON指示を120秒以内に処理しなければ、次の状態取得時に新しいOFF指示へ切り替えます。処理済みONにはこの配達期限は適用されません。
- 端末側で遠隔許可を解除すると、残っているON指示を取り消します。再許可しただけでは古いONを再実行しません。
- 指示のたびにrevisionが増えます。同じOFFを再送しても新しい指示になるため、ローカルで再開した端末を再度停止できます。
- 古い指示への応答で新しい状態を上書きしません。未発行のrevisionは409で拒否します。
- 登録上限はsourceあたり20台、全体200台です。端末削除・無期限の履歴管理・組織向け権限管理は未実装です。

### アダプターの最小疎通例

以下はHTTPの疎通例であり、実際のカメラ開始・停止は行いません。管理トークンは自分の端末・サーバーの環境変数から読み込みます。

```sh
EVENTS_URL='https://focus-events-20261018.take-otani.workers.dev'
# INGEST_TOKEN は保護した環境変数で設定済みとする
curl --fail-with-body "$EVENTS_URL/devices/heartbeat" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"source_id":"00000000-0000-4000-8000-000000000001","device_id":"reachy-demo-1","device_type":"reachy_mini","name":"Reachyデモ","observed_state":"off","remote_enabled":false,"applied_revision":0,"session_id":null}'

curl --fail-with-body "$EVENTS_URL/devices/list" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"source_id":"00000000-0000-4000-8000-000000000001"}'

curl --fail-with-body "$EVENTS_URL/devices/control" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"source_id":"00000000-0000-4000-8000-000000000001","device_id":"reachy-demo-1","enabled":false}'
```

実装するアダプターは、新しいrevisionだけを処理し、ONではローカルの許可・期限を確認し、OFFではまず撮影タイマーとカメラを停止してください。その後に既存APIのセッション終了とheartbeatを行います。ネットワークが切れている間は新しい遠隔指示を受け取れません。Mac UIは、ページを開いて表示し、利用者が遠隔操作を許可した間だけONできます。Reachy Mini / CoreS3のこの制御プロトコル用アダプターはまだ実装・実機検証していません。

## 検証と残っている確認

2026-10-18の検証結果です。変更後の最終結果はPRの検証欄も確認してください。

| 試験 | 結果・範囲 |
| --- | --- |
| `npm run test:events` | 68件通過。OAuth 16、Webhook 12、イベントbroker 17、端末registry 16、Miniflare統合7 |
| 既存API・クライアントのテスト | 37件通過 |
| 既存Workerのテスト | 1件通過 |
| `npm run test:mac-check` | 51件通過。ローカルプロキシ19、遠隔制御32 |
| `npm run smoke:events` | 公開Workerで12項目通過。OAuth・MCP・試験専用の偽端末・イベント登録 |
| 接続設定UI | モックブラウザ試験7項目通過 |
| 遠隔操作UI | モックChrome試験10シナリオ通過。ON/OFF、許可待ち中のOFF、許可解除、非表示、期限切れ、複数端末、モバイル等 |
| 公開APIを使うブラウザE2E | Chrome仮想カメラ＋実判定API＋公開Events Workerで7項目通過。遠隔ON、2回の検知、メタデータ中継、遠隔OFF・停止報告まで確認 |

署名・callback検証、購読・重複・再試行・解除、source分離、端末状態のrevision、Workers/SQLiteでの再起動を自動テストで確認しています。期限切れのONで121秒後にカメラ許可が返る試験でも、API呼び出し・画像送信が発生しないことを確認しました。

公開APIのブラウザE2Eでは、許可確認だけでは画像を送らず、新しいONで撮影を開始しました。継続保持2秒・クールダウン0で異なる通知IDを2件受信し、OAuthの `get_focus_events` から同じ2件・規定の8フィールド・画像なしを確認しました。OFF後は全カメラトラック終了、フレーム送信停止、端末registryの実状態OFF・指示適用済みを確認しています。画像要求8件・応答7件で、OFF時に処理中の1件を取り消しました。ページエラー0、モバイルの横方向はみ出しなし、試験用OAuth認可は終了後に取り消しました。カメラ入力には仮想映像を使っています。

実際のdotsアカウントでのOAuth同意・購読・通知、実カメラ・Reachy Mini/CoreS3を使った遠隔ON/OFFは未確認です。公開Workerの疎通試験とモックの成功を、dots実接続や実機制御の成功として扱いません。

公式仕様: [MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[Plugin OAuth](https://developers.openai.com/plugins/build/auth)、[ChatGPTへの接続](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。
