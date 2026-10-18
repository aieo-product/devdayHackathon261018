# ハッカソン提出用資料

確認日: 2026-10-18（JST）。本資料は提出文の原稿です。フォームへの送信・受付確認は未実施です。

## 作品名

集中支援アプリ — スマホを持ったら、作業に戻るきっかけを

## 一文説明

カメラとOpenAI Decisions APIでスマホの継続保持を検出し、本人が選んだ端末から作業への復帰を促す集中支援プロトタイプです。

## 提出用の説明文

作業中、無意識にスマホを手に取ってしまう。その瞬間を、作業へ戻るきっかけに変えるアプリです。利用者が見守りを開始すると、カメラ画像をOpenAI Decisions APIに送り、「スマホを手に持っているか」「手元を判定できるか」の2つの確率を取得します。共通APIが新しい画像で2秒以上の保持を確認したときに通知し、本人は必要に応じて一時停止・終了できます。

公開デモ仕様は2秒保持・クールダウンなしです。Mac確認UIでは、仮想カメラから公開Workerと実OpenAIを経由し、同じセッションで繰り返し通知するところまで検証しました。Cloudflare WorkersとSQLite Durable Objectsでセッション・重複抑止を管理し、停止後の古い結果から通知しない制御も実装しています。

特徴は、AIによる判断を共通化し、PCの画面通知・CoreS3の音・Reachy Miniの反応へ接続する構成です。Reachyは実画像の判定からfear1の動作・音声まで実機で確認済みです。この実機記録は当時の5秒保持仕様で、現行2秒仕様での再試験とは区別しています。CoreS3はビルド・書込み・停止起動を確認し、実画像から通知音までの結合確認は残っています。

さらに、独立したEvents Workerを公開配備し、検知メタデータのMCP Events配信と、Web画面・dotsからの端末監視ON/OFF用APIを実装しました。Macでは利用者が遠隔操作を許可した間だけONを受け付けます。仮想カメラと公開APIを使い、遠隔ON→2回の検知→イベント履歴への反映→遠隔OFFと停止報告まで確認しました。実際のdotsアカウントでの接続・通知、物理カメラの遠隔操作、Reachy/CoreS3の遠隔制御アダプターは未確認または未実装です。

集中時間の改善や認識精度の統計評価はまだ行っていません。ADHDや集中力の診断ではなく、本人が開始・停止できる行動へのフィードバックを提案します。

## 提出先へ添えるリンク

| 項目 | 値・状況 |
| --- | --- |
| 公開成果物（判定API） | https://focus-shared-api-20261018.take-otani.workers.dev/ |
| 認証不要の仕様書 | https://focus-shared-api-20261018.take-otani.workers.dev/docs |
| OpenAPI | https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json |
| 公開成果物（Events MCP） | https://focus-events-20261018.take-otani.workers.dev/mcp （OAuth認証付き） |
| Events稼働確認 | https://focus-events-20261018.take-otani.workers.dev/health |
| ソース（統合ブランチ main） | https://github.com/aieo-product/devdayHackathon261018/tree/main |
| API・連携の共有仕様 | [共通API仕様書](../cloudflare/API仕様書.md)、[Events手順](../cloudflare-events/README.md) |
| 評価根拠 | [evaluation.md](evaluation.md)、[evaluation.json](evaluation.json)、[Reachy実機記録](reachy/validation.md) |
| デモ手順 | [demo.md](demo.md)、[Mac確認UI](../tools/mac-camera-check/README.md) |
| 公開操作UI URL | 未確認。`http://127.0.0.1:3000`はMac内の確認UIであり、提出用の公開URLではない |
| 公開デモ動画・スクリーンショット | 公開リンクは未確認。開発時のローカル保存画像を公開資料へ採用する場合は、仮想カメラ入力であることを表示する |
| チーム名・メンバー表記 | 提出者が最終確認。未確認のチーム名・個人名は補完しない |

## 評価者へ伝える実装・検証範囲

- Mac確認UI・2秒判定・Reachy実装・Events連携と評価資料を `main` に統合しています。実装・検証の根拠は[evaluation.md](evaluation.md)で確認し、提出時にはmainのコミットを記録してください。
- 自動テストはmain整備時の再実行で計157件通過（API・クライアント37、既存Worker 1、Events 68、Mac 51）。別途、担当記録として公開Events APIの疎通12項目、仮想カメラ＋実判定API＋公開Events WorkerのブラウザE2E 7項目が通過しています。公開環境とカメラの試験は今回再実行していません。
- E2Eでは異なる通知IDの2件がOAuthのイベント履歴に届き、画像を含まないこと、遠隔OFF後にカメラトラックと送信が止まり端末の実状態がOFFになることを確認しました。実dotsの通知確認とは区別します。
- Reachyの実機記録は当時の5秒保持で5313msを確認し、fear1の動作・音声とタイマー終了まで確認したものです。現行2秒条件や新しい遠隔ON/OFFを実機で再確認したという主張ではありません。
- `health`は設定確認です。実AIの成功は[写真による試験](https://github.com/aieo-product/devdayHackathon261018/issues/3)、[Mac仮想カメラの試験](https://github.com/aieo-product/devdayHackathon261018/pull/6)、[Eventsの検証記録](../cloudflare-events/README.md#検証と残っている確認)を参照してください。
- 生画像はアプリの永続ストレージに保存せず、実APIモードでOpenAIへ送ります。Events Workerには画像を送りません。APIキーと接続トークンはサーバーに保持します。現在の共通管理トークンは信頼するチーム内アダプター向けで、一般利用者向けの端末別認証は未実装です。

## 公式条件とチームの予定

[公式イベントページ](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo)を2026-10-18に確認しました。審査観点は「新機能の活用・使いやすさ・有用性・独創性」で、予選はAIによる自動評価の予定です。成果物のWeb公開が条件です。ページ記載の予選締切は**17:15**、本戦デモプレゼンは**3分**です。チーム内の**17:00提出目標**とは区別します。

会場で追加の提出案内がある場合は、その指示も確認してください。公開APIがあることだけで、操作体験を含む提出要件の充足を断定しません。

## 提出直前に埋める確認項目

- [ ] チーム名・メンバー表記を確定する。
- [ ] 評価者が開ける公開操作UIまたは主催者指定の体験導線を確定し、リンク先を実際に開く。
- [ ] ソースの統合先と提出コミットを確認し、評価資料の参照と揃える。
- [ ] 公開デモ動画・スクリーンショットを用意する場合、公開リンクと仮想カメラ／実機の区別を確認する。
- [ ] 実dots接続やCoreS3・Reachyの追加試験結果が出た場合、根拠と時刻を添えて完成範囲を更新する。
- [ ] 提出フォームの必須項目を入力し、送信完了と受付結果を確認する。

資料公開時に実トークン・APIキー・Wi-Fi設定を含めないでください。未実施のチェックを完了として扱わないでください。
