# FOCUS デスクトップ演出（macOS 試作）

ブラウザの外でも検知時の演出を見せる、小さな macOS ヘルパーです。透明なパネルを各ディスプレイに重ね、最大 5 秒で閉じます。パネルはクリックを通過させ、作業中のアプリからキーボードのフォーカスを奪いません。カメラ、画面収録、アクセシビリティ操作は使用しません。

## ビルドと起動

macOS 12 以降と Xcode Command Line Tools が必要です。

```sh
bash ./desktop-overlay/build.sh
FOCUS_OVERLAY_BRIDGE_FILE="/absolute/path/to/private-bridge.json" \
  "./desktop-overlay/build/Focus Desktop Overlay.app/Contents/MacOS/FocusDesktopOverlay"
```

通常は生成した `.app` を開くだけで起動します。ビルド時に、ワークスペース直下の `.focus-overlay-bridge.json` を参照する設定を埋め込みます。環境変数または起動引数 `--bridge-file /absolute/path/to/private-bridge.json` で上書きもできます。サーバーが作成する JSON は `{ "url": "http://127.0.0.1:4327", "token": "一時的なローカルトークン" }` です。共有 API のトークンは使用しません。JSON は公開フォルダの外に保存してください。

メニューバーのきらめきアイコンから演出をテストしたり、ヘルパーを終了できます。自動起動・ログイン項目・システム設定の変更は行いません。

現在の表示キャラは `green` のDOTS1体です。旧 `cloud` / `cat` は受信側の互換値として残りますが、表示は同じDOTSへ統一します。

## ローカルの通信契約

- 表示ページ: `/desktop-overlay.html`。同一の `127.0.0.1` オリジン以外への移動は禁止。
- ポーリング: `GET /api/desktop-overlay/native/poll?after=<sequence>` を約 500ms ごとに実行。`Authorization: Bearer <一時トークン>` を使用。
- 応答: `{ "sequence": 123, "event": null }` または `event` に以下を設定。
- イベント: `{ "action": "detect" | "clear", "sequence": 123, "sourceId": "...", "character": "green", "message": "...", "kind": "test" | "detect", "intensity": "max" | "pop" | "off", "reduced": false, "createdAt": 1790000000000 }`。
- 表示ページは `window.focusOverlay.play(event)` と `window.focusOverlay.clear()` を公開。画像などの準備完了時に `window.webkit.messageHandlers.overlayReady.postMessage({})` を送信してください。終了時の `overlayFinished.postMessage({sequence, sourceId})` は任意です。古い演出の終了通知が次の演出を消さないように ID を照合します。
- 起動・再接続の最初の応答は現在位置の同期のみ。過去の通知を再生しません。6 秒以上前のイベントは破棄し、通信切断・clear イベントでは即座に非表示にします。
- macOS の「視差効果を減らす」を有効にすると `reduced` は常に `true` になります。

各ディスプレイの通常アプリとフルスクリーンアプリの上に表示できる構成ですが、ロック画面や macOS の保護された画面に表示するものではありません。WebKit 側の演出が停止しても、ネイティブ側のタイマーで閉じます。
