# 3分デモ台本と再現手順

対象: **2秒保持・クールダウン0秒の公開判定API、Mac確認UI、独自DOTSフロント、公開Events Worker**。ソースと試験根拠は[評価ガイド](evaluation.md)、設定の詳細は[Mac手順](../tools/mac-camera-check/README.md)、[DOTS手順](../focus-dopa-preview/README.md)、[Events手順](../cloudflare-events/README.md)を参照してください。以下の3分台本はMac確認UIで進行し、DOTSの演出は独立した約33秒のショーケースで追加できます。

## 公開Web画面で試す

[DOTS公開画面](https://focus-web-20261018.take-otani.workers.dev/)はインストールなしで開けます。通常画面にはデモパネル・テストボタンを表示しません。演出は[認証不要のデモ専用画面](https://focus-web-20261018.take-otani.workers.dev/?demo=1&pattern=fever&character=green)へ分けています。`?showcase=1`も従来の別名として利用できます。デモはカメラ・APIを使わない設計ですが、匿名アクセスから全シーンを再生するE2Eは修正・確認中です。

実APIを試す場合は、チームが個別に共有するコードでログインし、通常の共有API画面を使います。本人が「カメラを有効にする」を押してカメラを許可し、セッションを開始してください。ログインだけでは撮影しません。認証は12時間のHttpOnly Cookieで保持し、APIキー・共通判定APIのトークンはWorker側に置きます。コードをURLや公開資料へ載せないでください。

公開版ではローカルmacOS補助アプリを使用できません。ページ内の表示と、対応ブラウザで利用できる小窓（Picture-in-Picture）を使います。小窓が利用できない場合は通常のWeb画面を表示します。公開版の使用にMac内のサーバー起動は不要です。

公開URLのHTTP 200、`/.env`・`/server.mjs`の404、ログイン、openai providerのhealth、セッション作成HTTP 201は確認済みです。公開Webのブラウザ試験も、**仮想カメラ**から7フレームを実OpenAIへ送り、2秒以上の保持による通知2件を確認しました。一時停止・終了、ログアウトによる認証失効、モバイル表示も確認済みです。これは物理カメラ・実物スマホでの一連動作の確認ではありません。匿名デモの全シーン再生は別途確認中です。

## Macで判定デモを起動する

前提: Node.js 22.9以上、対応ブラウザとカメラ、ネット接続、チームが共有する`FOCUS_API_TOKEN`。画像はMac内のローカルサーバーから公開Workerを経由してOpenAIへ送られます。カメラは本人が開始するまで有効になりません。

既存の作業を変更しないよう、別ディレクトリへ提出版を取得します。以下はMac確認UI・DOTSフロント・Events連携・Reachy実装を統合した `main` 向けの手順です。

```sh
git clone --branch main https://github.com/aieo-product/devdayHackathon261018.git focus-demo
cd focus-demo
```

Git管理対象外の`cloudflare/.env.connection`を作り、次の例のトークン部分をチームから受け取った値に置き換えます。`OPENAI_API_KEY`はUIには不要です。

```dotenv
FOCUS_API_URL=https://focus-shared-api-20261018.take-otani.workers.dev
FOCUS_API_TOKEN=replace-with-worker-token
```

```sh
npm run start:mac-check
```

ChromeまたはSafariで`http://127.0.0.1:3000`を開きます。ポート使用中なら`MAC_CAMERA_PORT=3001 npm run start:mac-check`で変更できます。UIの起動はNode組み込み機能のみを使い、Workerのローカル試験・ビルド検証には別途`npm ci`が必要です。localhostのURLを公開操作UIとして提出しないでください。

1. 「確認開始」を押し、カメラを許可します。手元とスマホが画面に入る位置へ調整します。
2. `provider: openai`、`required_hold_ms: 2000`相当の表示・ログを確認します。
3. スマホを机上に置いた状態と、手に持った状態を比べます。
4. 新しい画像で2秒以上の保持を確認すると画面通知が出ます。音はUIの設定で切り替えます。通知回数と確認済み保持時間を見せます。
5. 通知後も新たな保持判定で再通知することを示します。一時停止・終了ではカメラと送信が止まります。

既定の確認時間は3分です。タブが非表示になる場合も停止するため、デモ中はUIを表示したままにします。このMac確認UIの通知は画面内表示とWeb Audioのビープ音です。OS通知は未実装です。

## DOTSの音つき10シーンを約33秒で見せる

[公開デモ専用画面](https://focus-web-20261018.take-otani.workers.dev/?demo=1&pattern=fever&character=green)を用意しています。匿名アクセスからの全シーン再生は修正・確認中で、成功済みの試験として扱いません。ローカルで動かす場合はリポジトリ直下で次を実行します。ローカルのショーケース起動には外部npmパッケージやAPIトークンは不要です。

```sh
npm run start:front
```

[DOTSショーケース](http://127.0.0.1:4327/?demo=1&pattern=fever&character=green)を開き、「音つきで一通り再生」を押します。トースト、開始、ジャンプ、一時停止、再開、休憩、節目、警告、完了、終了の10シーンを約33秒で再生します。停止ボタンまたはEscで音と動きを止められます。

**ショーケースはカメラ・共有APIを使わない演出のデモです。** 実セッションや通知件数は変更せず、スマホ認識や実通知の成功を示しません。クリックで音声再生を開始し、OS・ブラウザの消音設定に従います。`127.0.0.1`のURLはローカル用です。提出先には上記の公開URLを使います。

このリポジトリの**独自DOTSフロント**は `focus-dopa-preview/` にあるブラウザ画面です。キャラクター、トースト、警告音、小窓などを実装しています。一方、下記の**ChatGPT dots**はEvents WorkerへOAuth/MCP接続する外部の利用先です。独自DOTSの演出成功をChatGPT dotsの接続・購読・通知成功として扱いません。独自DOTSはOpenAIの公式製品ではありません。

### ローカル版DOTSで実共有APIを使う

Git管理対象外の `.env.focus-api.local` を**リポジトリ直下**に作り、チームから受け取った値を設定します。Mac確認UIの `cloudflare/.env.connection` とは別ファイルです。

```dotenv
FOCUS_API_URL=https://focus-shared-api-20261018.take-otani.workers.dev
FOCUS_API_TOKEN=replace-with-worker-token
```

```sh
chmod 600 .env.focus-api.local
npm run start:front
```

起動中ならサーバーを再起動します。ブラウザは同一オリジンの `/api/focus` を呼び、ローカルNodeサーバーが認証付きで共有APIへ中継します。共有トークンをHTML・JavaScript・URLに埋め込まず、`OPENAI_API_KEY`もフロントには設定しません。

1. [DOTS通常画面](http://127.0.0.1:4327/?pattern=fever&character=green)を開き、モードを「共有API」にして接続状態を確認します。
2. 「カメラを有効にする」を押して本人がカメラ利用を許可し、セッションを開始します。進行中かつカメラ有効時にだけ画像を送ります。
3. スマホなし・机上・保持の場面を試し、APIの判定状態と通知を確認します。2秒保持・クールダウン0秒はAPIが管理し、フロントは新しい `notify: true` と未処理の `notification_id` だけを通知に使います。次の送信は `next_capture_after_ms` に従います。
4. 一時停止・休憩・終了で撮影と後続通知を止めます。共有APIモードの期限は一時停止・休憩中も進みます。

DOTS通常画面はタブ非表示だけでは撮影を止めず、終了には画面上の停止操作が必要です。元のタブ・ブラウザ・ローカルサーバーを開いたまま使います。上のMac確認UIは非表示時に停止するため、両者の挙動を区別してください。DOTSには保持ミリ秒の数値表示が未実装なので、3分台本で保持進捗を見せる場合はMac確認UIを使います。

実装担当は実カメラ画像の送信と `unknown` → `observing` の応答を確認していますが、**スマホの実物保持→陽性判定→DOTS通知は未確認**です。ページ内トースト、Chrome小窓、macOS補助アプリの全画面警告は個別に確認済み。ブラウザ経由のOS通知は実装済みですが、**OSトーストの実表示は未確認**です。各表示を同じ受入結果として扱いません。詳細は[引き継ぎ記録](../focus-dopa-preview/docs/HANDOFF.md#確認済みと未確認)を参照してください。

演出用の操作・手動検知ボタンはデモ専用画面に分けています。通常画面には表示しません。演出による通知を、共有APIの2秒保持条件による通知として説明しないでください。

## Events・遠隔操作を追加する

この節は `tools/mac-camera-check/` のMac確認UIを対象とします。`cloudflare/.env.connection`へ以下を追加し、そのローカルサーバーを再起動します。値はチームの保護された共有経路で受け取り、トークンをソースへ書き込まないでください。

```dotenv
FOCUS_EVENTS_URL=https://focus-events-20261018.take-otani.workers.dev
FOCUS_EVENTS_TOKEN=replace-with-events-worker-ingest-token
FOCUS_SOURCE_ID=replace-with-your-fixed-profile-uuid
FOCUS_DEVICE_ID=mac-demo-1
```

判定APIの`FOCUS_API_TOKEN`とEvents用の`FOCUS_EVENTS_TOKEN`は別です。複数端末をまとめて操作する場合は同じ`FOCUS_SOURCE_ID`と端末ごとに異なる`FOCUS_DEVICE_ID`を設定します。Events Workerへの送信は検知メタデータだけで、画像は送りません。

1. 監視されるMacで確認画面を表示し、「このMacの遠隔操作を許可」を押します。カメラ権限の確認後にすぐ停止し、この操作だけでは画像を送信しません。
2. 操作側のWeb画面で同じプロフィールの端末を選び、監視ONを指示します。端末一覧の「実状態: ON」を確認します。
3. 画面で通知回数が増えることを確認します。イベント履歴を調べる場合は、OAuth接続済みMCPクライアントの`get_focus_events`を使います。確認UI内にイベント履歴画面はありません。
4. OFFを指示し、対象端末の撮影・送信が止まり、端末一覧が「実状態: OFF」になることを確認します。APIで検証する場合は`observed_state: off`と、`applied_revision`が指示の`revision`に追いついたことも確認します。
5. 終了時は「許可を解除・停止」を押します。

ONは接続中かつローカルで遠隔操作を許可した端末だけが対象です。OFF指示の受付と実際の停止は別で、offlineの端末に指示を保存しても停止完了とは表示しません。ページを隠す・閉じる・遠隔許可を解除すると撮影を止め、再開にはローカル許可と新しいON指示が必要です。操作するのは監視であり、Mac本体の電源ではありません。Reachy/CoreS3の遠隔制御アダプターは未実装です。

### ChatGPT dotsの接続手順と確認範囲

公開MCP URLは`https://focus-events-20261018.take-otani.workers.dev/mcp`です。ローカルの`http://127.0.0.1:3000/mcp/setup`を開き、ChatGPTのPluginsでカスタムMCPサーバーとOAuth認証を設定します。ローカル画面で10分間・1回限りのペアリングコードを発行し、OAuth画面へ入力して接続します。コードは公開画面や資料に載せません。

ChatGPT dotsへ依頼する例:

> Focusのfocus.phone_heldを購読して、イベントが届いたらスマホを置いて集中に戻るよう一言で知らせて。

> Focusの監視デバイス一覧を取得して、mac-demo-1の監視をOFFにして。実際に停止したか状態も確認して。

**実ChatGPT dotsアカウントによるOAuth接続・購読・通知は未確認です。** 上記は実施手順であり、成功済みのデモではありません。公開Events APIと仮想カメラのE2E成功を、ChatGPT dotsからの通知成功として説明しないでください。購読解除とカメラ停止は別操作です。

## 3分の進行

| 時間 | 見せるもの | 話す内容 |
| --- | --- | --- |
| 0:00–0:25 | UIと手元 | 「作業中についスマホへ手が伸びる。その瞬間を作業に戻るきっかけに変えます。」 |
| 0:25–0:50 | 開始、カメラ許可、机上のスマホ | 「本人が開始します。机にあるだけか、手に持っているかをAIが判定します。」 |
| 0:50–1:20 | スマホを持ち、保持時間と通知回数を表示 | 「Decisions APIが保持と可視性を返し、APIが新しい画像で2秒以上を確認したら通知します。」 |
| 1:20–1:45 | 再通知と一時停止 | 「通知後も再検知できます。必要なスマホ利用のときは一時停止。撮影と送信も止まります。」 |
| 1:45–2:20 | 構成図と端末一覧 | 「同じ判定を画面・音・ロボットの反応へつなぎます。APIが遠隔指示を保存し、端末が撮影と停止を実行します。」 |
| 2:20–2:45 | 検証表 | 「公開画面とAPIを用意しました。公開Web追加の116件の自動試験が通過し、別の仮想カメラ試験では遠隔ONから検知、履歴反映、OFFまで確認しました。公開Webでも仮想カメラで2回通知を確認しました。物理カメラとChatGPT dots接続は未確認です。」 |
| 2:45–3:00 | 終了、カメラ停止 | 「本人が自分の作業へ戻るための、端末を選べるフィードバックを目指します。」 |

台本の期待どおりにならない場合、観測した結果をそのまま説明します。Reachyの実演や動画を差し込む場合は、[実機記録](reachy/validation.md)の5秒保持・5313msでfear1動作＋音声を確認した結果と、現行2秒条件での実演を区別してください。CoreS3は担当報告で実画像5枚を送信し、スマホ保持を2回検出しましたが、観測間隔が2500msを超えて保持時間がリセットし、通知は0回でした。実画像から音までの結合は未達です。ChatGPT dotsの通知、物理カメラの遠隔ON/OFF、独自DOTSの実物保持からの通知・OSトースト実表示も、確認が取れるまで実証済みとして説明しません。

## 評価者が確認する項目

| 操作・状況 | 見る値・期待する動作 |
| --- | --- |
| スマホを机に置く | スマホ保持の検出対象外。実画像の有限試験で確認し、常に成功すると保証しない |
| 手に持つ | `continuous_hold_ms`が新しい画像で進み、2000ms以上を確認した応答で`notify: true` |
| 通知後も保持 | `cooldown_remaining_ms: 0`、次の新しい陽性画像から新たな保持判定、別の通知IDで再通知 |
| 手元が見えない | `unknown` / `insufficient_visibility`、通知なし |
| 一時停止・終了 | カメラ・送信停止、停止後に届く古い結果から通知しない |
| GET・同じフレームID再送 | 新しい通知を発行しない |
| 遠隔許可前のON | ON拒否。ローカルの許可だけでも画像送信を開始しない |
| 遠隔OFF | 対象端末が停止し、`observed_state: off`と指示の適用済みrevisionを確認 |
| Eventsの履歴 | 同じsourceに通知IDごとのメタデータが届く。画像は含まれない |

2秒は確認済み画像の受理時刻差です。物理的な持ち上げから通知までの厳密な2秒保証ではありません。観測間隔が2.5秒を超えると保持をリセットします。

## 通信・機器が使えない場合

- カメラ許可がない: ブラウザとOSのカメラ権限を本人が確認します。撮影できないまま画像判定の成功を示しません。
- `401`: 接続先に対応するアプリトークンを確認します。HTTP 200でも`provider_error` / `unknown`なら推論成功ではありません。
- 保持時間が進まない: 可視性・応答時間・観測間隔を表示し、通知条件が成立しているか確認します。
- 遠隔ONできない: 対象端末の表示状態、遠隔許可、heartbeat、online判定を確認します。OFFの受付だけで停止済みと判断しません。
- EventsやChatGPT dotsが使えない: Macの判定・画面通知は独立して動作します。Events中継やChatGPT dotsの成功は未確認のままにします。
- DOTSの実API設定がない: デモ専用画面で演出を試せます。公開版の匿名全シーン再生は確認中です。「カメラ・APIを使わない演出」と説明し、実物保持からの通知成功へ読み替えません。
- 会場回線が使えない: [READMEのローカルmock検証](../README.md)へ切り替え、「画像を解析しない状態遷移のデモ」と明示します。mockの成功を実画像認識の根拠にはしません。

## 参照できる試験結果とコマンド

2026-10-18の結果です。main整備時の自動テスト236件と、公開Web追加時に実行したフロント99件・公開Web Worker17件を区別しています。公開API、ブラウザE2E、実機の記録は実装担当によるものです。過去の試験を今回の公開Webカメラ試験の結果として扱いません。

| 試験 | 確認結果 |
| --- | --- |
| `npm test` | API・クライアント37件通過 |
| `npm run test:worker` | 既存Worker 1件通過 |
| `npm run test:events` | Events 68件通過。Webhook受信先はモック |
| `npm run test:mac-check` | Mac 51件通過。プロキシ19・遠隔制御32 |
| `npm run test:front` | 公開Web追加時に99件通過（既存79・認証15・表示モード4・再生回帰1）。カメラ・実APIは使わない |
| `npm run test:web` | 公開Web Worker17件通過 |
| 公開Web配備後の疎通 | 公開画面200、`/.env`・`/server.mjs`404、ログイン、openai providerのhealth、セッション作成201 |
| 公開Webブラウザ試験 | 仮想カメラ7フレームで実OpenAI通知2件・保持2秒以上、一時停止・終了・ログアウト失効・モバイル表示を確認。物理カメラは未確認 |
| 公開の匿名デモ | 通常画面から分離。全シーン再生のE2Eは修正・確認中 |
| `npm run smoke:events` | 公開Events APIの12項目通過。試験専用プロフィール・偽端末を使用 |
| 公開APIブラウザE2E | 仮想カメラ＋実判定API＋公開Events Workerで7項目通過。遠隔ON、通知2件、履歴反映、遠隔OFF・停止報告 |
| Reachy実機 | 当時の5秒条件で5313ms保持→fear1動作＋音声→時間終了を確認。現行2秒条件の再試験と遠隔制御は未確認 |
| CoreS3実機 | 担当報告で実画像5枚を送信・保持を2回検出。観測間隔2500ms超で保持がリセットし通知0回、ビープまで未達。試験後は停止済み |
| 独自DOTSフロント | 実カメラ送信と `observing` 応答、ショーケース・ページ内トースト・小窓・デスクトップ警告の個別確認を担当が報告。実物保持からの通知とOSトースト実表示は未確認 |

現在の自動テスト内訳は計273件（37＋1＋68＋51＋99＋17）です。main整備時の236件に認証15件・表示モード4件・再生回帰1件・公開Web Worker17件を追加した内訳で、全273件を今回一括再実行した結果ではありません。ローカルで再現する場合はリポジトリ直下で依存をインストールします。

```sh
npm ci
npm test
npm run test:worker
npm run test:events
npm run test:mac-check
npm run test:front
npm run test:web
npm run check:worker
npm run check:events
npm run check:web
```

`check:*`は配備せずにWorkerをビルド検証します。公開Eventsの疎通は接続設定後に`npm run smoke:events`で確認できます。この試験は実カメラ・OpenAI推論・ChatGPT dots購読・外部Webhookを使いません。既存の公開判定APIへ画像を送る試験は`npm run smoke:worker`です。画像1枚を実OpenAIへ送るため料金が発生する場合があり、既定の無地画像は認識精度の検証にはなりません。

[PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6)の初回Mac試験では、Chrome仮想カメラから公開Worker・実OpenAIへ6フレームを送り、保持2534msと2386msで2回通知しました。追加の公開Events E2Eでは、異なる通知2件のメタデータ到達とOFF後の全カメラトラック終了を確認しました。これらは用意した仮想映像の試験であり、物理カメラの遠隔操作、一般的な実環境の認識精度、ChatGPT dotsへの通知を証明するものではありません。
