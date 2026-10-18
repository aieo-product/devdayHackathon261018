---
title: Reachy Focus
emoji: 🌱
colorFrom: green
colorTo: yellow
sdk: static
app_file: index.html
pinned: false
short_description: Gentle smartphone-holding reminders on Reachy Mini Wireless
tags:
  - reachy_mini
  - reachy_mini_python_app
---

# 集中支援アプリ — スマホを持ったら、作業に戻るきっかけを

作業中についスマホを手に取る人のための、カメラとAIを使った集中支援プロトタイプです。**OpenAI Decisions APIでスマホ保持と手元の可視性を判断し、継続保持を確認したら端末が声・画面・動きで知らせます。** 本人が開始・一時停止・終了を選べます。集中力やADHDを診断するものではありません。

現行の共通APIは **2秒保持・通知後のクールダウンなし**。Mac確認UI、Reachy Mini本体アプリ、CoreS3クライアントを同じリポジトリで開発しています。別のEvents WorkerでMCPイベントと監視ON/OFFを実装し、仮想カメラから公開APIまでの動作を確認しました。実dotsアカウントへの接続・通知は未確認です。

**評価資料:** [評価軸と検証の根拠](docs/evaluation.md) · [提出用説明文](docs/submission.md) · [3分デモ台本・起動手順](docs/demo.md) · [機械可読サマリー](docs/evaluation.json)

## 統合ブランチと収録内容

**開発・提出の基準は `main` です。** 既存の `feat/shared-focus-api` に統合された変更と評価資料をまとめています。未マージの作業ブランチや、各端末の未コミット設定は含めません。

| 統合済みの変更 | 内容 |
| --- | --- |
| [PR #4](https://github.com/aieo-product/devdayHackathon261018/pull/4)・[PR #5](https://github.com/aieo-product/devdayHackathon261018/pull/5) | Cloudflare共通API、永続化、実推論の診断 |
| [PR #6](https://github.com/aieo-product/devdayHackathon261018/pull/6) | Mac確認UI、2秒保持、通知後も繰り返し検知 |
| [PR #8](https://github.com/aieo-product/devdayHackathon261018/pull/8) | Reachy Mini本体アプリ、反応・音声、配布設定 |
| [PR #10](https://github.com/aieo-product/devdayHackathon261018/pull/10) | 独立Events Worker、MCP Events、Mac監視の遠隔ON/OFF |
| [PR #11](https://github.com/aieo-product/devdayHackathon261018/pull/11) | Reachyの集中中ダンスと保持判定による即時中断 |
| [PR #9](https://github.com/aieo-product/devdayHackathon261018/pull/9) | 評価根拠、提出原稿、デモ台本、機械可読JSON |

```sh
git clone --branch main https://github.com/aieo-product/devdayHackathon261018.git
cd devdayHackathon261018
```

既存の作業ディレクトリを更新するときは、未コミット変更を保存してから `git fetch origin`、`git switch main`、`git pull --ff-only` を使います。mainを初めて取得する場合は `git switch --track origin/main` で作成します。

## 公開成果物と評価の入口

| 入口 | 確認できる内容 |
| --- | --- |
| [共通判定API](https://focus-shared-api-20261018.take-otani.workers.dev/) | APIと仕様への入口。操作画面ではありません |
| [公開仕様書](https://focus-shared-api-20261018.take-otani.workers.dev/docs) / [OpenAPI](https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json) | 認証不要で閲覧できるHTTP契約・状態・2秒判定条件 |
| [Events MCP](https://focus-events-20261018.take-otani.workers.dev/mcp) / [Events手順](cloudflare-events/README.md) | OAuthで接続するイベント・端末制御API。ブラウザで開く操作画面ではありません |
| [Mac確認UI](tools/mac-camera-check/README.md) | カメラ→共通API→画面通知、遠隔ON/OFF。起動後は `http://127.0.0.1:3000` |
| [Reachy本体アプリ](src/reachy_focus/) / [実機検証記録](docs/reachy/validation.md) | 本体カメラと公式fear1の動作・音声。導入手順は本README後半 |
| [公開リポジトリ](https://github.com/aieo-product/devdayHackathon261018) | ソース、テスト、評価資料 |

MCP・遠隔監視の追加仕様は[リポジトリの共通API仕様書](cloudflare/API仕様書.md)が最新です。公開 `/docs` はWorkerの最終配備時点の文書であり、資料更新だけでは差し替わりません。

`/v1/*`の画像判定にはチームから受け取るアプリトークンが必要です。OpenAIキーはサーバー専用です。**公開操作UI・デモ動画・提出受付のURLは未確認**で、localhostやReachyのLAN内URLは外部の評価者が直接開ける提出URLにはなりません。公開APIのhealthは設定状態の確認であり、画像認識精度を証明しません。

## 利用体験と審査観点

1. 利用者が監視を開始し、カメラに手元を映します。
2. AIが画像ごとにスマホ保持と可視性を判定します。机上に置かれただけのスマホは対象外です。
3. 新しい画像で2秒以上の保持を確認すると、APIが `notify:true` と一意の通知IDを返します。
4. 端末が画面・音・動きに変換します。必要なスマホ作業中は一時停止できます。

Reachyのダンス中は例外として、最初の新しいスマホ保持判定でダンスを止めてfear1へ切り替えます。この端末側の即時リアクションは、共通APIの2秒通知とは区別します。

2秒は画像の受理時刻に基づく継続保持条件です。通信・推論の遅延があるため、実際に持った瞬間から正確に2秒後の通知は保証しません。判定不能時は通知せず、停止後に遅れて戻った結果も通知しません。

| [公式イベント](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo)の観点 | 実装・評価材料 |
| --- | --- |
| 新機能の活用 | Decisions APIの保持・可視性predicate、MCP Eventsの購読・署名配送・OAuthを実装。[AIアダプター](api/src/provider.mjs)、[Events実装](cloudflare-events/README.md) |
| 使いやすさ | 開始・一時停止・終了、判定理由と保持時間の表示。遠隔操作では指示と実状態を分け、端末の許可がある間だけON。[Mac手順](tools/mac-camera-check/README.md) |
| 有用性 | スマホを手に取った本人へ作業に戻るきっかけを提供。集中時間の改善や継続利用効果は未測定。[デモ](docs/demo.md) |
| 独創性 | 共通のAI判断をPCの表示、小型端末の音、ロボットの反応、イベント連携へ接続。[API契約](docs/api-contract.md)、[Reachy実機記録](docs/reachy/validation.md) |

## 実装・検証済みの範囲

確認日: **2026-10-18（JST）**。API・Worker・Mac・Eventsの自動テストはmain整備時にも再実行しています。公開API・仮想カメラ・物理端末の結果は実装担当の記録であり、今回再撮影したものではありません。

| 対象 | 確認済み | 残っている確認 |
| --- | --- | --- |
| API・Worker・Mac・Events | 自動テスト計157件（API/クライアント37、既存Worker1、Mac51、Events68）通過 | 実環境の遅延分布・認識精度の統計評価 |
| Macの2秒・繰り返し通知 | Chrome仮想カメラ＋実OpenAIで同一セッション2回通知。保持2534ms / 2386ms | 仮想入力の結果を物理カメラの再試験と混同しない |
| MCP Events・監視ON/OFF | 公開Events疎通12項目、仮想カメラ＋実APIのブラウザE2E 7項目通過。通知2件の履歴一致、遠隔OFF後の撮影停止・適用確認 | 実dotsのOAuth接続・購読・通知、Reachy/CoreS3の遠隔監視アダプター |
| Reachy Mini Wireless | 本体実画像→公開API→5313ms保持検知→fear1の動作・音声→時間終了を確認 | この実機記録は旧5秒条件。現行2秒の実機再試験、ページ/Macを閉じた単独継続は未確認 |
| Reachy 0.3.0の追加機能 | 10秒の非保持でdance1、最初の保持判定でダンス中断・fear1へ切替。cheerful1、日本語声かけ、基準姿勢復帰も収録。担当記録にPython47件成功 | ダンス中の実画像検知と動きの見た目は未確認。[変更と試験範囲](docs/reachy/dance.md)。Python試験は今回の157件に含まない |
| CoreS3 | ビルド・USB書込み・起動に加え、実画像5枚を送りスマホ保持を2回検出した担当報告あり。HTTPS接続再利用の改善を統合 | 観測間隔が2.5秒を超えて保持時間がリセットし、通知・ビープまで未達。[最新試験記録](devices/cores3/README.md#実画像試験の担当報告2026-10-18) |

詳しい試験条件・制約は[評価資料](docs/evaluation.md)、端末ごとの記録は[Reachy](docs/reachy/validation.md)・[CoreS3](devices/cores3/README.md)を参照してください。検知確率1.0はモデルの出力値であり、認識精度100%を意味しません。

## Mac・共通APIの起動とテスト

Node.js **22.9以上**。リポジトリ直下で実行します。

```sh
npm ci
npm test
npm run test:worker
npm run test:mac-check
npm run test:events
```

通常の自動テストは外部のOpenAIや実カメラを使いません。MacデモはGit管理外の `cloudflare/.env.connection` に `FOCUS_API_URL` と `FOCUS_API_TOKEN` を設定し、次を実行します。Eventsの追加設定とペアリングは[Mac手順](tools/mac-camera-check/README.md)にあります。

```sh
npm run start:mac-check
```

`http://127.0.0.1:3000` を開き、本人が開始・カメラ許可を選びます。実APIモードでは画像をOpenAIへ送信します。[APIキー不要のモック試験](docs/evaluation.md#ローカル再現追加のapi利用なしで確認する)、[公開APIの疎通手順](cloudflare/README.md)、[Events疎通手順](cloudflare-events/README.md)も利用できます。

## DOTSフロントの起動とレビュー

PCブラウザ向けの追加フロントを `focus-dopa-preview/` に用意しました。DOTS1体、動くトースト、警告音、全画面リリック、Chromeの小窓、macOS用のデスクトップ表示補助アプリを含みます。

```sh
npm run test:front
npm run start:front
```

[音つき10シーンデモ](http://127.0.0.1:4327/?pattern=fever&character=green&showcase=1)で「音つきで一通り再生」を押すと、カメラ・実APIを使わず約33秒で確認できます。[通常画面](http://127.0.0.1:4327/?pattern=fever&character=green)で共有APIを使う場合は、[設定手順](focus-dopa-preview/README.md#共有apiを設定する)に従ってチームのトークンをローカルに設定してください。

現行の共通APIは2秒保持・通知クールダウンなしです。[API仕様書](cloudflare/API仕様書.md)と[引き継ぎ文書](focus-dopa-preview/docs/HANDOFF.md)を参照してください。このフロントは `notify` と `next_capture_after_ms` に従い、保持時間や通知待機時間を独自に追加しません。

実カメラの送信と `observing` 応答は確認済みですが、スマホの実物保持からの陽性通知は未確認です。詳細は [フロントREADME](focus-dopa-preview/README.md)、[引き継ぎとマージ手順](focus-dopa-preview/docs/HANDOFF.md)、[アセットの由来](focus-dopa-preview/ASSETS.md)に記載しています。

## データ・認証・制約

- アプリケーションは生画像を永続保存しません。実判定ではCloudflare経由でOpenAIへ送信し、外部サービスの保持条件・料金は別途適用されます。
- 判定APIの共有BearerトークンとOpenAIキーは別です。Macのローカルプロキシは秘密値をブラウザへ渡しません。
- EventsのOAuthはsourceごとにデータを分離します。アダプター用の共通管理トークンは信頼するサーバー専用で、製品向けの端末別認証は未実装です。
- Eventsへ送るのは通知ID・セッション・保持時間・確率などのメタデータで、画像は含めません。Mac側の送信待ちはメモリー、Worker受理後の配送待ちは永続化します。
- 遠隔OFFは監視停止であり物理電源操作ではありません。端末がofflineなら実際の停止を即時に確認できません。Macはページを表示し、ローカルで遠隔操作を許可した間だけONできます。
- スマホ利用の目的・集中度・感情・医学的診断は判定しません。効果や精度の統計評価は未実施です。

## 開発者向け資料

- [Node API](api/README.md) / [HTTP契約](docs/api-contract.md)
- [Cloudflare Worker](cloudflare/README.md) / [API仕様書](cloudflare/API仕様書.md)
- [Mac確認UI](tools/mac-camera-check/README.md) / [MCP Events・遠隔監視](cloudflare-events/README.md)
- [CoreS3の導入と実機記録](devices/cores3/README.md)

## Reachy Mini本体アプリ：導入・運用

Reachy Mini Wirelessの本体カメラから**共通判定API**へ画像を送り、サーバーが返す新しい `notify: true` を本体の公式の😨 Fearプリセット（fear1）・音声に変換するPythonアプリです。監視処理は本体で動作する構成です。操作ページとMacを閉じた単独継続の実測は未確認です。

### 接続・導入

既定URLは `https://focus-shared-api-20261018.take-otani.workers.dev`。
API担当から渡された **FOCUS_API_TOKEN** を本体の設定画面へ入力します。
OpenAI APIキーは共通APIサーバーだけが保持し、Reachyへ設定しません。

1. Controlで `reachy_focus` をインストール・起動（初回公開前は下記の開発インストール）。
2. `http://reachy-mini.local:8042` または `http://本体のIP:8042` を開く。
3. API URL・共有アプリトークンを保存し、「カメラを1枚確認」と「通知をテスト」を行う。
4. 集中時間と音声の有無を選び、共通API・OpenAIへの画像送信に同意して開始する。
5. いつでも一時停止・再開・終了できる。設定変更は進行中のセッションを終了し、新たに開始する。

### 判定と停止の契約

- スマホを**手に持つ状態が設定時間続いたか**、しきい値は共通APIが判断する（現行の共通API既定値は2秒、クールダウンなし）。本体はサーバーが指定する間隔で次の保持確認へ進む。公開APIのクールダウン撤去はAPI担当者が対応済み。見ていない・操作していない保持も対象。置いてあるだけなら対象外。
- 本体に独自の3回連続判定やローカルの5秒タイマーはない。スマホ保持を一度検知した後、可視性0.7以上・保持確率0.2以下の新しい非検出応答で、公式 `cheerful1` を1回再生する。手元が隠れた場合や停止後の遅延応答では喜ばない。
- `next_capture_after_ms` に従い、応答後に固定1秒や3秒を追加しない。長辺640px以下の生JPEG、1MiB以下、一意の `X-Frame-Id` で送信する。同時送信は1件のみ。
- 通常の通知は**新しいフレーム応答**の `notify: true` を消費し、`notification_id` で二重実行を防ぐ。ダンス中の即時中断は新しい保持判定からも実行する。GET・control・画面再描画からは通知しない。
- `continuous_hold_ms` はサーバーの確認済み値だけを表示する。時間経過で画面側の進捗を増やさない。
- 一時停止・終了はHTTPの完了を待つ前に、本体の撮影・通知リアクション・予約音声を止める。停止要求が失敗しても観測停止を維持し、遅延した画像応答を捨てる。待機中の小さな動作はアプリ停止まで続く。
- 集中タイマーは開始リクエスト時から計測し、一時停止中も進む。期限で本体を停止し、サーバーへ終了要求を送る。終了済みセッションは新規に開始する。
- APIの `provider: mock` は画像解析を行わない。操作画面にmock/openaiを明示する。HTTP 200でも `state: unknown` なら判定失敗として扱い、通知しない。
- 起動時にモーターを有効にし、2秒かけて顔を起こす。アプリ実行中は、アンテナと頭の小さな呼吸動作を続ける（モーションのチェックボックスなし）。
- 手元が見えてスマホを持っていない判定が10秒続くと、公式 `dance1` を繰り返す。ダンス中は最初の保持判定（保持確率0.8以上・可視性0.7以上）で、サーバーの通知確定を待たずダンスを中断し `fear1` へ切り替える。検知までには撮影・通信・推論の遅延がある。スマホ保持・判定不能・通信失敗・10秒以上の判定欠落・一時停止・終了で穏やかな動きへ戻る。集中そのものを推定する機能ではない。
- 通知時は公式 `pollen-robotics/reachy-mini-emotions-library` の `fear1` を再生する。0.8秒で先頭姿勢へ移り、公式の軌跡を再生して1秒で待機姿勢へ戻る。音声ONならプリセット付属音を再生し、終了後に「スマホ、今すぐ置いて！」と日本語で声をかける。喜ぶときはcheerful1の付属音を使う。停止・一時停止で待機中の声かけも破棄する。プリセット未ロード時は画面に明示する。
- 一時停止・セッション終了は観測と通知リアクションを停止する。待機中の小さな動作は続く。アプリ停止時には待機動作も停止する。サーバーから任意のスクリプトや動作を受け取らない。

仕事でスマホを使うときは本人が一時停止する。集中度・意図・感情・医学的診断は行わない。物理的な保持開始から正確に2秒後の通知は、通信・推論遅延があるため保証しない。

### 設定とプライバシー

共有トークンは本体の `~/.config/reachy-focus/settings.json` に0600で保存する。`XDG_CONFIG_HOME` があればその下。ソース・URL・ブラウザのlocalStorage・応答・イベントへ実値を出さない。以前の直接OpenAI接続設定は読み込み時に無視し、共有トークンへ流用しない。次回保存時に旧設定も除去する。

本人が開始したセッション中だけ画像を共通APIへ送る。共通APIはopenaiモードでOpenAIへ送信する。本体と共通サービスは生画像を永続保存しない。API提供側の保持条件と利用料金は別途適用される。明示操作による確認画像はローカル画面だけに表示し、共通APIへ送信しない。送信済みのリクエストは停止後も処理される場合があるが、古い結果で本体は反応しない。

本体イベントログは当該セッションの最新500件までメモリに保持する。新規セッションとアプリ終了で消える。共通API側のセッション情報は終了・期限後約30分で削除される仕様であり、本体とは別管理。

操作画面は信頼するLAN用のHTTPで、ユーザー認証はない。ポート8042をインターネットへ公開しない。異なるサイトからの操作はOrigin/専用ヘッダーで拒否する。共有トークンはハッカソン用で、利用者ごとの分離はない。

### 開発・実機導入

Python 3.10以上、Reachy SDK 1.12系を対象とする。

```sh
uv venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check src/reachy_focus tests/reachy
.venv/bin/python -m build
.venv/bin/python scripts/check-reachy-package.py
.venv/bin/reachy-mini-app-assistant check .
```

Wireless本体上の既存アプリ用環境へインストールする。SDKを渡すのはデーモンで、独自のハードウェア接続やデーモン変更はしない。同時に実行する本体アプリは1つ。

```sh
/venvs/apps_venv/bin/python -m pip install /path/to/repository
# Controlから起動するか、開発時は以下を実行（同時実行しない）
/venvs/apps_venv/bin/python -m reachy_focus.main
```

### モノレポと配布

```text
README.md / pyproject.toml / index.html / style.css  # HF Spaceの配布契約
src/reachy_focus/                                  # Reachy実装・画面・音声
tests/reachy/                                     # Reachy専用テスト
docs/reachy/                                      # Reachy専用資料
api/ / clients/ / devices/cores3/                   # 既存チーム実装
apps/mac/ / apps/cores3/                           # 他機器の独立置き場
```

GitHubとHF Spaceへ**同一コミット**を直接pushする。HFには全ソースが公開されるが、Pythonのwheel/sdistには `reachy_focus` と必要な画面・音声だけを含む。切り出しやコピーは不要。他機器の依存関係は各プロジェクト内に閉じる。

[API接続仕様](docs/reachy/shared-api.md) / [実機検証記録](docs/reachy/validation.md) / [直接公開手順](docs/reachy/release.md) / [Issue #2](https://github.com/aieo-product/devdayHackathon261018/issues/2)

[公式アプリ仕様](https://github.com/pollen-robotics/reachy_mini/blob/main/docs/source/SDK/apps.md) / [共通API公開仕様](https://focus-shared-api-20261018.take-otani.workers.dev/docs)
