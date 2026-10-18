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

# Reachy Focus — いまの作業へ、そっと戻ろう

Reachy Mini Wirelessの本体カメラから**共通判定API**へ画像を送り、サーバーが返す新しい `notify: true` を本体の公式の😨 Fearプリセット（fear1）・音声に変換するPythonアプリです。操作ページとMacを閉じても本体が動作を続けます。

## 接続・導入

既定URLは `https://focus-shared-api-20261018.take-otani.workers.dev`。
API担当から渡された **FOCUS_API_TOKEN** を本体の設定画面へ入力します。
OpenAI APIキーは共通APIサーバーだけが保持し、Reachyへ設定しません。

1. Controlで `reachy_focus` をインストール・起動（初回公開前は下記の開発インストール）。
2. `http://reachy-mini.local:8042` または `http://本体のIP:8042` を開く。
3. API URL・共有アプリトークンを保存し、「カメラを1枚確認」と「通知をテスト」を行う。
4. 集中時間と音声の有無を選び、共通API・OpenAIへの画像送信に同意して開始する。
5. いつでも一時停止・再開・終了できる。設定変更は進行中のセッションを終了し、新たに開始する。

## 判定と停止の契約

- スマホを**手に持つ状態が設定時間続いたか**、しきい値は共通APIが判断する（このリポジトリのAPI既定値は5秒）。本体はサーバーが指定する間隔で次の保持確認へ進む。公開APIのクールダウン撤去はAPI担当者が対応済み。見ていない・操作していない保持も対象。置いてあるだけなら対象外。
- 本体に独自の3回連続判定やローカルの5秒タイマーはない。スマホ保持を一度検知した後、可視性0.7以上・保持確率0.2以下の新しい非検出応答で、公式 `cheerful1` を1回再生する。手元が隠れた場合や停止後の遅延応答では喜ばない。
- `next_capture_after_ms` に従い、応答後に固定1秒や3秒を追加しない。長辺640px以下の生JPEG、1MiB以下、一意の `X-Frame-Id` で送信する。同時送信は1件のみ。
- **新しいフレーム応答**の `notify: true` だけを消費し、`notification_id` で二重実行を防ぐ。GET・control・画面再描画からは通知しない。
- `continuous_hold_ms` はサーバーの確認済み値だけを表示する。時間経過で画面側の進捗を増やさない。
- 一時停止・終了はHTTPの完了を待つ前に、本体の撮影・通知・待機アクションを止める。停止要求が失敗しても本体は停止を維持し、遅延した画像応答を捨てる。
- 集中タイマーは開始リクエスト時から計測し、一時停止中も進む。期限で本体を停止し、サーバーへ終了要求を送る。終了済みセッションは新規に開始する。
- APIの `provider: mock` は画像解析を行わない。操作画面にmock/openaiを明示する。HTTP 200でも `state: unknown` なら判定失敗として扱い、通知しない。
- 起動時にモーターを有効にし、2秒かけて顔を起こす。アプリ実行中は、アンテナと頭の小さな呼吸動作を続ける（モーションのチェックボックスなし）。
- 手元が見えてスマホを持っていない判定が続くと、10秒・20秒・30秒の3段階で首・アンテナのリズムが活発になる。スマホ保持・判定不能・通信失敗・10秒以上の判定欠落・一時停止・終了で穏やかな動きへ戻る。集中そのものを推定する機能ではない。
- 通知時は公式 `pollen-robotics/reachy-mini-emotions-library` の `fear1` を再生する。0.8秒で先頭姿勢へ移り、公式の軌跡を再生して1秒で待機姿勢へ戻る。音声ONならプリセット付属音を再生し、終了後に「スマホ、今すぐ置いて！」と日本語で声をかける。喜ぶときはcheerful1の付属音を使う。停止・一時停止で待機中の声かけも破棄する。プリセット未ロード時は画面に明示する。
- 一時停止・セッション終了は観測と通知リアクションを停止する。待機中の小さな動作は続く。アプリ停止時には待機動作も停止する。サーバーから任意のスクリプトや動作を受け取らない。

仕事でスマホを使うときは本人が一時停止する。集中度・意図・感情・医学的診断は行わない。物理的な保持開始から正確に5秒後の通知は、通信・推論遅延があるため保証しない。

## 設定とプライバシー

共有トークンは本体の `~/.config/reachy-focus/settings.json` に0600で保存する。`XDG_CONFIG_HOME` があればその下。ソース・URL・ブラウザのlocalStorage・応答・イベントへ実値を出さない。以前の直接OpenAI接続設定は読み込み時に無視し、共有トークンへ流用しない。次回保存時に旧設定も除去する。

本人が開始したセッション中だけ画像を共通APIへ送る。共通APIはopenaiモードでOpenAIへ送信する。本体と共通サービスは生画像を永続保存しない。API提供側の保持条件と利用料金は別途適用される。明示操作による確認画像はローカル画面だけに表示し、共通APIへ送信しない。送信済みのリクエストは停止後も処理される場合があるが、古い結果で本体は反応しない。

本体イベントログは当該セッションの最新500件までメモリに保持する。新規セッションとアプリ終了で消える。共通API側のセッション情報は終了・期限後約30分で削除される仕様であり、本体とは別管理。

操作画面は信頼するLAN用のHTTPで、ユーザー認証はない。ポート8042をインターネットへ公開しない。異なるサイトからの操作はOrigin/専用ヘッダーで拒否する。共有トークンはハッカソン用で、利用者ごとの分離はない。

## 開発・実機導入

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

## モノレポと配布

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

## DOTSフロントの起動とレビュー

PCブラウザ向けの追加フロントを `focus-dopa-preview/` に用意しました。DOTS1体、動くトースト、警告音、全画面リリック、Chromeの小窓、macOS用のデスクトップ表示補助アプリを含みます。

```sh
npm run test:front
npm run start:front
```

[音つき10シーンデモ](http://127.0.0.1:4327/?pattern=fever&character=green&showcase=1)で「音つきで一通り再生」を押すと、カメラ・実APIを使わず約33秒で確認できます。[通常画面](http://127.0.0.1:4327/?pattern=fever&character=green)で共有APIを使う場合は、[設定手順](focus-dopa-preview/README.md#共有apiを設定する)に従ってチームのトークンをローカルに設定してください。

最新のIssue #1は2秒保持・通知クールダウンなしです。旧ダウンロード版API仕様には5秒／60秒の記載があるため、[引き継ぎ文書](focus-dopa-preview/docs/HANDOFF.md)と[Issue #1](https://github.com/aieo-product/devdayHackathon261018/issues/1)を参照してください。このフロントは `notify` と `next_capture_after_ms` に従い、保持時間や通知待機時間を独自に追加しません。

実カメラの送信と `observing` 応答は確認済みですが、スマホの実物保持からの陽性通知は未確認です。詳細は [フロントREADME](focus-dopa-preview/README.md)、[引き継ぎとマージ手順](focus-dopa-preview/docs/HANDOFF.md)、[アセットの由来](focus-dopa-preview/ASSETS.md)に記載しています。
