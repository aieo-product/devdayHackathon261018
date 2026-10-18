# 評価者向け：実装・検証の根拠

本人が開始したセッションで、カメラ画像からスマホ保持と手元の可視性を判定し、継続保持を確認した場合に端末が画面・音・動きで知らせる集中支援プロトタイプです。[概要](../README.md)、[提出情報](submission.md)、[デモ](demo.md)、[機械可読サマリー](evaluation.json)から確認できます。

基準日は **2026-10-18（JST）**。評価対象は統合ブランチ `main` です。API・Worker・Mac・Eventsの自動テストをmain整備時に再実行し、公開API試験・実機記録は担当者の結果を集約しています。カメラや実APIは今回再実行していません。

統合元のコードは `d8e95c6eb96fb4c914eb81d465294680720d1d5c`（PR #10マージ後）、再検証した資料ブランチは `b349cc95fcf062c673a3fb08e4d73dea4c72071e` です。この更新ではアプリケーションのソースを変更していません。PR #4・#5・#6・#8・#10の実装とPR #9の資料をmainに集約しています。

## 現在の評価対象

| 対象 | 現在の状態 | 根拠 |
| --- | --- | --- |
| 共通判定API | 継続保持 **2000ms**、通知後クールダウン **0ms**。公開済み | [実装](../api/src/engine.mjs)、[API契約](api-contract.md)、[公開仕様](https://focus-shared-api-20261018.take-otani.workers.dev/docs) |
| Mac確認UI | カメラ、表示・音、停止・再開、遠隔ON/OFFを実装 | [コードと手順](../tools/mac-camera-check/README.md)、[PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6) |
| Events Worker | MCP 2.0、OAuth、イベント中継・配送、監視指示と実状態管理を実装・別Workerへ公開 | [手順・仕様](../cloudflare-events/README.md)、[PR #10](https://github.com/aieo-product/devdayHackathon261018/pull/10) |
| Reachy Mini Wireless | ソース・配布設定・実機記録を収録。旧5秒条件で実画像からfear1の動作・音声まで確認 | [実装](../src/reachy_focus/)、[実機記録](reachy/validation.md) |
| CoreS3 | ビルド・書込みに加え、実画像5枚の送信と2回の保持検出を担当が報告。通知まで未達 | [実装と実機記録](../devices/cores3/README.md) |

現行のNode APIと公開Workerの通知条件は2秒・クールダウンなしです。過去の5秒試験は、その時点の実画像・実機確認の証拠としてのみ扱います。特にReachyの5313msの実機記録を、現行2秒条件で再検証した結果とは扱いません。Reachy 0.3.0は[10秒の非保持でダンスを始め、最初の保持判定で中断する処理](reachy/dance.md)を追加しています。ダンス中断は2秒の通知確定とは別の端末リアクションで、実画像を使ったダンス中の切替は未確認です。

## 審査4観点と確認できる根拠

[公式イベント案内](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo)の4観点に沿った、実装と検証記録への案内です。

| 観点 | 確認する内容 | 根拠・限界 |
| --- | --- | --- |
| 新機能の活用 | Decisions APIの `observable` / `phone_use` predicate、MCP Eventsの購読・OAuth・署名配送 | [AIアダプター](../api/src/provider.mjs)、[Events Worker](../cloudflare-events/README.md)。実dotsからの購読・通知は未確認 |
| 使いやすさ | 開始・一時停止・再開・終了、保持時間と理由の表示、停止時の遅延応答破棄。遠隔操作は端末側の許可が前提 | [Mac確認UI](../tools/mac-camera-check/README.md)、[クライアント試験](../clients/focus-client.test.mjs)。モバイル幅の確認はスマホ実機でのカメラ・OS通知確認ではない |
| 有用性 | 机上のスマホと保持を区別し、本人が作業へ戻るきっかけを作る。必要なスマホ利用には一時停止 | [判定質問](../api/src/provider.mjs)、[継続保持](../api/src/engine.mjs)。集中力・生産性改善の効果測定は未実施 |
| 独創性 | 共通のAI判断をMac、CoreS3、Reachyの表示・音・動きとイベント通知へ接続 | [HTTP契約](api-contract.md)、[Reachy実機記録](reachy/validation.md)、[CoreS3](../devices/cores3/README.md)。全端末の現行仕様E2E完了を意味しない |

## 検証結果

共通API・Worker・Mac・Eventsの自動テストは**計157件通過**しています。ReachyのPython試験は別の実機開発記録に記載し、この157件に混ぜていません。

再実行環境はNode.js 26.8.2 / npm 11.19.1 / macOS arm64です。Worker・Eventsは`npm ci`で固定lockの依存（Miniflare 5.20261012.1-beta、esbuild 0.28.2、Wrangler 4.151.1）を導入して再確認しました。ReachyのPython試験はこの環境に依存がなく今回未実行で、0.3.0の47件成功は[PR #11](https://github.com/aieo-product/devdayHackathon261018/pull/11)の担当記録です。

| 自動テスト・モック | 結果 | 根拠 |
| --- | --- | --- |
| API・共通クライアント | `npm test` **37件通過** | [API試験](../api/test/)、[クライアント試験](../clients/focus-client.test.mjs) |
| 既存Worker | `npm run test:worker` **1件通過** | [HTTP・SQLite統合試験](../cloudflare/test/worker.integration.test.mjs) |
| Mac | `npm run test:mac-check` **51件通過**（プロキシ19、遠隔制御32） | [Mac実装・試験](../tools/mac-camera-check/) |
| Events | `npm run test:events` **68件通過**（OAuth16、Webhook12、broker17、端末16、Miniflare統合7） | [Events試験](../cloudflare-events/test/) |
| 接続設定UI | モックブラウザ7項目通過 | [接続UI](../tools/mac-camera-check/public/mcp-setup.mjs)と[検証記録](../cloudflare-events/README.md#検証と残っている確認) |
| 遠隔UI | モックChrome10シナリオ通過 | ON/OFF、許可待ち中のOFF、解除、非表示、期限切れ、別端末、モバイル。121秒後の許可応答でも期限切れONから画像送信なし |

| 公開API・実推論・物理デバイス | 結果 | 入力・確認範囲 |
| --- | --- | --- |
| 公開Eventsの疎通 | `npm run smoke:events` **12項目通過** | 専用プロフィールの偽端末でOAuth・MCP・指示とACK・イベント履歴を確認。実カメラ・外部Webhook・dotsは使わない |
| Macの2秒・繰り返し通知 | 同一セッションで2回、確認済み保持2534ms / 2386ms | Chrome仮想カメラ→公開Worker→実OpenAI。required_hold_ms 2000、クールダウン0。[PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6) |
| 公開APIを通す遠隔UI E2E | **7項目通過**、通知ID2件がOAuth履歴と一致 | Chrome仮想カメラ＋実判定API＋公開Events Worker。許可確認→遠隔ON→2回検知→中継→遠隔OFF→適用確認・解除。[PR #10](https://github.com/aieo-product/devdayHackathon261018/pull/10) |
| Reachyの物理カメラ・動作 | 連続5313msで1回通知、fear1の動作・音声を利用者が確認、時間終了 | **旧5秒・60秒待機時点の試験**。本体の実画像→公開Workerの実OpenAI→本体反応。[実機記録](reachy/validation.md)。現行2秒条件の物理再試験ではない |
| CoreS3 | 実画像5枚をAPIへ送信、スマホ保持を2回検出した担当報告。試験後は停止済み | 観測間隔2500ms超で保持時間がリセットし通知は0回。画像認識の成功と通知・ビープ未達を区別。[記録](../devices/cores3/README.md) |

遠隔UI E2Eの入力は仮想映像です。通知2件は画像を含まない規定の8フィールドでEventsへ届きました。OFF後は全仮想カメラトラック終了・フレーム増加停止・registryの実状態OFFと指示適用済みを確認。画像要求8件・応答7件で、停止時に処理中の1件を取り消しました。ページエラー0、モバイル横方向はみ出しなし、試験用OAuth認可は取り消し済みです。

過去の[実画像試験 #3](https://github.com/aieo-product/devdayHackathon261018/issues/3)では、机上のスマホの保持確率0、手持ち画像の保持確率1が記録されています。ただし少数の固定画像であり、精度100%・未知の照明や画角での正解率を示しません。画面内通知とWeb Audioのビープは実装していますが、MacのOS通知は実装していません。

## ローカル再現：追加のAPI利用なしで確認する

Node.js 22.9以上。リポジトリ直下で実行します。以下は現行の2秒・クールダウンなしのコード用です。

```sh
npm ci
npm test
npm run test:worker
npm run test:mac-check
npm run test:events
```

ターミナルAで、`.env`を読み込まず固定確率を返すmock APIを起動します。トークンはローカル試験用の例です。

```sh
env -u OPENAI_API_KEY \
  DECISION_PROVIDER=mock FOCUS_API_TOKEN=local-evaluation-token \
  MOCK_PHONE_PROBABILITY=0.95 MOCK_OBSERVABLE_PROBABILITY=1 \
  HOST=127.0.0.1 PORT=18787 \
  node api/src/index.mjs
```

ターミナルB:

```sh
FOCUS_API_URL=http://127.0.0.1:18787 \
FOCUS_API_TOKEN=local-evaluation-token \
node scripts/smoke-test.mjs --expect-notify
```

期待結果はmock、3フレームで2秒以上の保持を確認して1回通知、重複抑止、pause/resume/endの成功、最後に `PASS` です。合成画像を使うため画像認識精度の試験ではありません。終了後はターミナルAをCtrl+Cで停止します。

実推論を試す手順は[Worker README](../cloudflare/README.md)、Mac起動は[Mac README](../tools/mac-camera-check/README.md)、Eventsの公開疎通は[Events README](../cloudflare-events/README.md)を参照してください。`smoke:worker` は実OpenAIへの画像送信を含みます。`smoke:events` は別の偽端末を使用し、実カメラを起動しません。

## 境界条件・データの扱い

| 確認内容 | 実装・試験 |
| --- | --- |
| 保持確率0.8以上・可視性0.7以上、新しい陽性画像で2000ms継続確認。観測間隔2500ms超・不明・非検出でリセット | [判定エンジン](../api/src/engine.mjs)、[境界値試験](../api/test/engine.test.mjs) |
| GET・同一フレームID再送・画面タイマーだけでは通知しない。pause/end後の遅延結果を破棄 | [HTTP試験](../api/test/http.test.mjs)、[共通クライアント](../clients/focus-client.test.mjs) |
| APIエラー・タイムアウト・不正確率は通知なし。画像サイズ・形式・Origin・Bearerを検証 | [provider試験](../api/test/provider.test.mjs)、[HTTPサーバー](../api/src/server.mjs) |
| 遠隔ONはonline・ローカル許可・新しい期限内指示のみ。OFFの指示と実際の停止報告を分離 | [端末registry](../cloudflare-events/src/devices.mjs)、[Mac遠隔制御](../tools/mac-camera-check/public/remote-control.mjs) |

2秒は確認済み保持時間であり、撮影・通信・推論込みの物理的な通知期限ではありません。Node APIの状態はプロセスメモリー、Workerのセッション状態はSQLite Durable Objectsで、終了・期限後は約30分で削除します。Eventsは別のDurable ObjectにOAuth・購読・配送待ち・端末状態を保存します。

アプリケーションに生画像を永続保存する処理はありませんが、実APIモードではOpenAIへ送信し、外部サービスの保持条件は別途適用されます。判定APIは共有のデモBearerトークンで、利用者別分離はありません。EventsのOAuth読み取り・操作はsourceに分離しますが、管理用共通トークンはsourceを指定できるため信頼するアダプター専用です。

## 未確認・今後の検証

- 実dotsアカウントでのOAuth同意、購読、実Webhook配送、通知。実装・公開配備・仮想カメラE2Eとは別の確認です。
- 物理カメラを用いたMac遠隔操作、Reachyの現行2秒条件での再試験、ページ/Macを閉じた単独継続、CoreS3の実画像からビープまでの結合。
- Reachy/CoreS3のEvents監視ON/OFFアダプター。既存の判定API接続とは別途実装が必要です。
- 長時間稼働、認識精度・誤通知率・遅延分布、集中時間改善や継続利用の効果測定。
- 公開操作UI、チーム名、デモ動画、提出受付。[提出チェックリスト](submission.md)で確定します。

試験を追加した場合は、対象版、日時、入力が実物か仮想映像か、APIのモード、実際に確認した出力を記録し、この資料と[評価用JSON](evaluation.json)を更新してください。
