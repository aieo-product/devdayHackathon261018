# 評価者向け：実装・検証の根拠

この資料は、集中支援アプリの評価対象、再現手順、実際に確認した範囲をまとめたものです。本人が開始した集中セッションで、カメラ画像から「スマホを手に持っているか」と「手元を判断できるか」を判定し、継続保持を確認した場合に端末の通知・音・動きで作業への復帰を促します。

概要は[README](../README.md)、提出情報は[提出資料](submission.md)、実演順序は[デモ手順](demo.md)、機械可読な一覧は[評価用JSON](evaluation.json)を参照してください。状態の基準日は **2026年10月18日（JST）** です。

## 評価対象の版を先に確認する

公開環境と、この資料を作成したローカルチェックアウトには次の差があります。以下の試験結果を混ぜて、同じ版の実行結果として扱わないでください。

| 対象 | 識別情報 | 通知条件 | 確認方法 |
| --- | --- | --- | --- |
| 公開Worker | [公開API](https://focus-shared-api-20261018.take-otani.workers.dev/) | 継続保持 **2000ms**、通知後クールダウン **0ms** | 資料整備セッションで公開`/docs`をGETし、2000ms／0msの記載を確認 |
| Mac実装と最新API変更 | 未マージの[PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6)、`feat/mac-camera-check`、`ca2eb20d7d9c97ef23220b3d352dace8edfce0cc` | 2000ms／0ms | PR記録と担当セッションの報告。下表の試験結果は担当による実行結果 |
| このローカルチェックアウト | `feat/shared-focus-api`、`4ca4368` | **5000ms／60000ms** | ソース、既存テスト、下記のローカル再現手順 |

このチェックアウトの[API契約](api-contract.md)、[Worker仕様書](../cloudflare/API仕様書.md)、[OpenAPI YAML](../cloudflare/openapi.yaml)には旧5秒／60秒の仕様が残っています。公開環境の最新値を確認するときは[公開仕様書](https://focus-shared-api-20261018.take-otani.workers.dev/docs)と[公開OpenAPI](https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json)を参照してください。PR #6の変更は、このチェックアウトやデフォルトブランチへ統合済みとは扱いません。

## 公式の評価軸と確認できる根拠

[公式イベント案内](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo)の評価軸に沿って、判断材料を整理しています。以下は採点の指示ではなく、コードと検証記録への案内です。

| 評価軸 | このプロジェクトで確認する内容 | コード・記録 | 判断の限界 |
| --- | --- | --- | --- |
| 新機能の活用 | OpenAI Decisions APIへ画像を送り、`observable`と`phone_use`の2つのpredicateから確率を取得。APIの状態管理で通知可否を決める | [OpenAIアダプター](../api/src/provider.mjs)、[応答形式のテスト](../api/test/provider.test.mjs)、[実画像試験 issue #3](https://github.com/aieo-product/devdayHackathon261018/issues/3) | モック試験は画像認識を検証しない。`/health`の設定表示だけでは実API疎通を証明しない |
| 使いやすさ | セッションの開始・一時停止・再開・終了、確認済み保持時間の表示、停止後に届いた結果や重複通知の破棄 | [共通クライアント](../clients/focus-client.mjs)、[クライアント試験](../clients/focus-client.test.mjs)、[Mac画面・操作検証 PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6) | Mac画面の成果はPR #6側。モバイル幅での表示確認は、スマートフォン実機のカメラ・OS通知確認を意味しない |
| 有用性 | 机上のスマホと手持ちを区別し、一定時間の保持を確認して本人へ復帰を促す。仕事目的のスマホ利用時には一時停止できる | [判定質問](../api/src/provider.mjs)、[継続保持ロジック](../api/src/engine.mjs)、[実画像試験 issue #3](https://github.com/aieo-product/devdayHackathon261018/issues/3) | 集中力改善や生産性向上の効果測定は未実施。スマホ利用の目的、集中度、疾患は判定しない |
| 独創性 | Mac・CoreS3・Reachyがそれぞれ撮影し、共通の判定APIを使い、自機に合う通知・音・動きを実行する設計 | [共通HTTP契約](api-contract.md)、[CoreS3実装](../devices/cores3/cores3.ino)、[Reachy進捗 issue #2](https://github.com/aieo-product/devdayHackathon261018/issues/2) | 複数端末での設計・実装進捗を示すもの。全端末で実画像から通知まで完成したという主張ではない |

## 検証結果と証拠の種類

「実行済みテスト」「公開GETの確認」「担当報告」「未確認」を区別します。担当報告を、この資料作成セッションで同じ試験を再実行した結果とは扱いません。

| 対象 | 結果・観測値 | 証拠と対象版 |
| --- | --- | --- |
| ローカルAPI・クライアント | `npm test`：31件成功 | `4ca4368`の[テスト一式](../api/test/engine.test.mjs)と[クライアント試験](../clients/focus-client.test.mjs)。5秒／60秒仕様 |
| ローカルWorker | `npm run test:worker`：1件成功 | [Worker統合試験](../cloudflare/test/worker.integration.test.mjs)。モックでのHTTP接続・状態復元等の確認 |
| 公開Workerの設定 | `/health`は`{"provider":"openai","configured":true}`、公開`/docs`は2000ms／0ms | 資料整備セッションの公開GET確認。実画像送信はこのGET確認に含まれない |
| 実画像→実OpenAI | 机上のスマホ：`phone_probability=0`、`observable_probability=0.96`。手持ち画像6枚：各`phone_probability=1`、`observable_probability=1`。通知時の確認済み保持時間5103ms | [issue #3](https://github.com/aieo-product/devdayHackathon261018/issues/3)、15:09 JSTの旧5秒仕様の試験記録 |
| 実APIの応答時間 | 上記の手持ち画像試験は各300〜576ms。別の無地PNG試験は2810ms | [issue #3](https://github.com/aieo-product/devdayHackathon261018/issues/3)。少数試験の観測値であり、平均・p95・保証値ではない |
| Mac→公開Worker→実OpenAI | Chrome仮想カメラ入力で同一セッション内に2回通知。報告された保持時間2534ms／2386ms、`required_hold_ms=2000`、クールダウン0。pause／resume／endとモバイル幅の確認 | [PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6)と担当セッション報告。物理カメラでの再試験としては扱わない |
| 最新Mac/APIコードの自動試験 | `npm test`37件、Worker1件、Mac proxy8件成功 | [PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6)の担当報告。このチェックアウトの31件とは対象版が異なる |
| CoreS3 | ビルド・書き込み・停止／起動の成功報告 | [CoreS3実装](../devices/cores3/cores3.ino)と担当セッション。実画像→実判定→実機ビープの一連動作は未確認 |
| Reachy Mini Wireless | 端末へのインストール、カメラプレビュー、認証付きセッション、モック結合、プリセット読込の成功報告 | [issue #2](https://github.com/aieo-product/devdayHackathon261018/issues/2)。実写真→通知→`fear1`と音の一連動作、Macなしでの継続稼働は未確認。このチェックアウトにReachyコードは含まれない |

確率値の`1`はモデルの応答値です。認識精度100%の実証ではありません。同じ手持ち写真を6回送信した試験から、未知の利用者・照明・画角に対する精度、再現率、誤通知率は算出していません。PR #6のMac確認UIは画面内通知とWeb Audioのビープ音を実装し、OS通知は未実装です。

## ローカル再現：追加のAPI利用なしで確認する

以下はリポジトリ直下から実行する、`4ca4368`の**旧5秒／60秒仕様**の再現手順です。Node.js 22.9以上を使用します。APIと`npm test`には外部npm依存はありません。環境変数を明示し、既存の`api/.env`を読み込まない起動方法にしています。

まず単体・HTTP・クライアント試験を実行します。

```sh
npm test
```

次にターミナルAで、固定確率を返すローカルAPIを起動します。

```sh
env FOCUS_API_TOKEN=local-evaluation-token \
  DECISION_PROVIDER=mock OPENAI_API_KEY= \
  MOCK_PHONE_PROBABILITY=0.95 MOCK_OBSERVABLE_PROBABILITY=1 \
  HOST=127.0.0.1 PORT=18787 \
  node api/src/index.mjs
```

ターミナルBで、APIの設定状態と一連の操作を確認します。

```sh
curl --fail http://127.0.0.1:18787/health

env FOCUS_API_URL=http://127.0.0.1:18787 \
  FOCUS_API_TOKEN=local-evaluation-token \
  node scripts/smoke-test.mjs --expect-notify
```

期待結果は`provider=mock`、6フレームで5秒以上の保持を確認して1回通知、重複フレームでは通知なし、pause／resume／endの成功、最後に`PASS`です。この試験では小さな合成画像を使います。画像内容を判別する試験ではなく、接続と状態制御の確認です。

**この版のスモークスクリプトを公開Workerへ向けないでください。** [スクリプト](../scripts/smoke-test.mjs)は`required_hold_ms === 5000`と通知1回を検証するため、最新の2秒／クールダウン0仕様には一致しません。最新仕様の再現にはPR #6の対象コミットと、その版のテストを使用します。

Workerのローカル統合試験には開発依存が必要です。

```sh
npm ci
npm run test:worker
```

`npm ci`は依存の取得が必要です。Worker試験はローカル環境のモックであり、公開Workerへの配備やOpenAIへの実画像送信は行いません。

## コードで確認できる境界条件

| 確認内容 | 実装・テスト |
| --- | --- |
| 手持ち確率0.8以上かつ可視性0.7以上を条件にする。判定不能、非検出、観測間隔2500ms超で保持時間をリセット | [判定エンジン](../api/src/engine.mjs)、[エンジン試験](../api/test/engine.test.mjs) |
| 時間経過、GET、同じフレームIDの再送だけでは通知しない。しきい値到達後の新しい陽性画像が必要 | [境界値・重複試験](../api/test/engine.test.mjs) |
| pause／endの後に届いた推論結果・画像アップロードを破棄し、通知を発生させない | [HTTP試験](../api/test/http.test.mjs)、[クライアント試験](../clients/focus-client.test.mjs) |
| APIエラー、拒否、タイムアウト、不正な確率値は通知なしにする | [プロバイダー試験](../api/test/provider.test.mjs)、[エンジン試験](../api/test/engine.test.mjs) |
| `/v1/`にBearer認証、ブラウザOriginの完全一致確認、画像の形式・サイズ・IDの検証を行う | [HTTPサーバー](../api/src/server.mjs)、[HTTP試験](../api/test/http.test.mjs) |

旧版の境界値試験は4999ms／5000msを検証します。最新2秒仕様の境界値や通知後の挙動の確認はPR #6側の試験を参照してください。2秒は画像の受理時刻に基づく継続保持条件です。撮影・通信・推論の遅延があるため、物理的にスマホを持った瞬間から正確に2.000秒後に通知する保証ではありません。

## 保存・認証・運用の範囲

| 項目 | Node版 | Cloudflare Worker版 |
| --- | --- | --- |
| セッションと受理済みフレームID | [メモリ上のMap／Set](../api/src/engine.mjs)。プロセス再起動で失われる | [SQLite Durable Objects](../cloudflare/src/worker.mjs)へ永続化し、復元する |
| 推論中の再起動 | セッション自体が失われる | 復元時に`decision_interrupted`として取り消す |
| 終了・期限後の保持 | 約30分。アクセス時の清掃 | 約30分。[alarmによる削除](../cloudflare/src/worker.mjs) |
| 生画像 | アプリケーションに永続保存する処理はない | アプリケーションに永続保存する処理はない |

実APIモードでは画像をOpenAIへ送信します。「アプリケーションが生画像を保存しない」という説明は、外部サービスの保持条件を保証するものではありません。`OPENAI_API_KEY`はサーバー専用です。端末へ渡す`FOCUS_API_TOKEN`は別の共有デモトークンで、利用者ごとの認証・権限分離は未実装です。トークンや実画像はこの資料に含めません。

## 未検証・開発中の項目

- 実利用者を対象にした継続利用評価、集中力改善の効果測定、認識精度・誤通知率の統計評価。
- CoreS3とReachyの、実カメラ画像から実OpenAI判定を経て実機の音・動きまで通す一連の動作、および各端末の長時間稼働。
- PR #6のデフォルトブランチへの統合。この資料を作成したチェックアウトには最新Mac画面と2秒仕様は未統合。
- MCP Events、dots、遠隔ON／OFFは[issue #7](https://github.com/aieo-product/devdayHackathon261018/issues/7)で開発中。稼働確認済みの成果には含めない。

追加の実機試験やPR統合が完了した場合は、対象コミット、日時、入力、出力、確認した端末を記録して、この資料と[評価用JSON](evaluation.json)を更新してください。
