---
title: Reachy Focus
emoji: 🌱
colorFrom: green
colorTo: yellow
sdk: static
app_file: index.html
pinned: false
short_description: Standalone gentle smartphone-use reminders on Reachy Mini Wireless
tags:
  - reachy_mini
  - reachy_mini_python_app
---

# Reachy Focus — いまの作業へ、そっと戻ろう

Reachy Mini Wirelessの本体カメラで、スマホを見たり操作したりする行動を観測し、短い日本語の声かけと任意の小さなアンテナ動作で気づきを促すPythonアプリです。開始後に操作ページとMacを閉じても、本体が撮影・判定要求・通知・タイマー終了を処理します。インターネット接続と利用者自身のOpenAI APIキーが必要です。

**現在の検証状況:** Python 39件・既存JavaScript 31件のテスト、wheel/sdist内容検査、公式CLIの一時環境インストール・アンインストール検証に成功しています（2026-10-18）。実APIによる認識精度とWireless実機での音声・動作・単体継続は、[実機チェックリスト](docs/reachy/validation.md)で結果を記録するまで未確認です。モックの成功を実機確認として扱いません。

## すぐに使う

1. Reachy Mini Controlのアプリ一覧から `reachy_focus` をインストールして起動します。初回公開前は、下の開発インストールを使います。
2. 操作画面を開きます。Wirelessでは `http://reachy-mini.local:8042` または `http://本体のIP:8042` です。
3. OpenAI APIキーを保存し、開始前に「カメラを1枚確認」と「通知をテスト」を実行します。声の音量は本体で調整してください。
4. 集中時間と通知方法を選び、画像送信の説明に同意して「集中を始める」を押します。
5. 作業でスマホを使うときは一時停止します。再開・終了は同じ操作画面から行えます。Reachy Mini Controlからアプリ自体を停止することもできます。

このアプリは集中度、意図、ADHDなどの診断を行いません。画角によって誤検知・見逃しがあります。スマホが置いてあるだけの場合と、見たり操作したりする場合を区別する条件で判定します。

## 単体モードのルール

| 項目 | 初期設定 |
| --- | --- |
| タイマー | 25分。一時停止中も終了時刻は変わりません |
| 画像 | 長辺640px以下のJPEG。メモリ内だけで処理 |
| 送信 | およそ3秒間隔。処理が遅い場合は完了後に間隔を空け、並列送信・待ち行列は作りません |
| 通知条件 | 判断可能な画像でスマホ操作確率0.8以上が3回連続 |
| リセット | 非検出、判定不能、通信失敗、設定変更、一時停止、終了、直前の有効判定から10秒以上 |
| 再通知 | 通知後60秒は抑制し、解除後に新しい3回を数えます |
| 通知 | 同梱の「いまの作業に、戻ろう。」。動作は初期設定で無効 |
| 障害時 | 注意せず再試行。キー・権限・制限超過等を操作画面へ表示 |

一時停止・終了・設定変更で古い結果を無効化します。送信済みのリクエストはOpenAI側で処理される場合がありますが、その結果で通知しません。ローカル確認画像も開始時に画面から取り除きます。表示する推定確率は実測の検知精度ではありません。

## APIキー・画像・ログ

キーは本体の `~/.config/reachy-focus/settings.json` に所有者のみ読み書きできる権限（0600）で保存します。`XDG_CONFIG_HOME` があればその下です。キーをGit、ブラウザのlocalStorage、URL、イベントログに保存・表示しません。「保存したキーを削除」で削除できます。

本人が開始したセッション中だけ、画像を本体から `https://api.openai.com/v1/decisions` へ送信します。開始前・一時停止中の「カメラを1枚確認」は明示操作によるローカル確認で、OpenAIへ送信しません。画像は自サービスで永続保存しません。イベントはメモリに当該セッションの最新500件まで保持し、新しいセッションまたはアプリ終了で消えます。OpenAI側の保持条件とAPI料金は別途適用されます。

操作画面は信頼するLANで使う前提です。HTTPであり、ユーザー認証はありません。同一LANの人は設定変更やローカルカメラ確認を実行できるため、ポート8042をインターネットへ公開しないでください。異なるWebサイトからの操作はOrigin/専用ヘッダーで拒否します。APIキーの生値を読み出すAPIはありません。

## 開発・検証

公式の `reachy-mini-app-assistant` 1.12.0で作成したひな形をルートへ配置しています。Python 3.10以上、Reachy SDK 1.12系が対象です。実機上のSDK/デーモン互換性は導入時に確認してください。

```sh
uv venv --python 3.12
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check src/reachy_focus tests/reachy
.venv/bin/python -m build
.venv/bin/python scripts/check-reachy-package.py
.venv/bin/reachy-mini-app-assistant check .
```

デーモンが動くWireless本体上で、このリポジトリのルートをインストールします。Reachy Miniは同時に1つの本体アプリを実行します。

```sh
/venvs/apps_venv/bin/python -m pip install /path/to/devdayHackathon261018
# 開発用に直接起動する場合（Controlからの起動と同時実行しない）
/venvs/apps_venv/bin/python -m reachy_focus.main
```

SDKが接続済みの本体インスタンスをアプリへ渡します。独自のハードウェア接続やデーモン変更は行いません。モデル名の既定値は公式Decisionsガイドに合わせて `gpt-6-luna`。利用権限・応答は実キーで別途確認します。APIの接続先は固定し、キーが任意サーバーへ送られる設定は提供しません。

## 共有リポジトリと直接公開

```text
README.md / pyproject.toml / index.html / style.css  # HF Spaceのルート
src/reachy_focus/                                  # 配布するPythonパッケージ
apps/mac/                                         # Mac担当用の置き場
apps/cores3/                                      # 将来の独立置き場（既存実装はdevices/cores3）
api/ / clients/ / devices/cores3/                   # 既存チーム実装
tests/reachy/ / docs/reachy/                       # Reachy専用テスト・資料
```

GitHubとHF Spaceへ**同一コミット**をpushします。サブディレクトリの書き出しは不要です。HFには全ソースが公開されますが、wheel/sdistはReachyパッケージだけを含みます。他機器用の依存関係は各プロジェクト内で管理し、ReachyのPython依存に追加しません。

重要: チーム共通APIには「スマホ保持5秒」の別ルールがあります。**今回のReachyは承認済みの直接Decisions接続・3回連続モードです。共通APIの `notify` を使いません。** 既存API・CoreS3の挙動を変更していません。統合する場合は判定クライアント境界とポリシーを明示的に変更してください。既存READMEは [共通APIチーム引き継ぎ](docs/shared-team-handoff.md) に保存しています。

[直接公開の手順](docs/reachy/release.md) / [実機チェックリスト](docs/reachy/validation.md) / [Issue本文](docs/reachy/issue.md)

## 公式資料

- [Reachy Miniアプリの作成・配布](https://github.com/pollen-robotics/reachy_mini/blob/main/docs/source/SDK/apps.md)
- [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions)
- [元仕様書](https://focus-team-spec-20261018-a14d.donald-25.chatgpt.site/)
