# CoreS3 独立クライアント

CoreS3 自身のカメラ画像を共通判定 API に送り、本体画面と短いビープで知らせる Arduino サンプルです。Mac の常駐は不要です。判定には Wi-Fi とバックエンドが必要です。

**起動しただけでは撮影・画像送信を始めません。** 本体画面の `START` を押して開始します。`STOP` は一時停止、`START` は再開、`END` はセッション終了です。終了が確認できた後の `START` は新しいセッションを作ります。

## 必要なもの

- カメラ付き M5Stack CoreS3。CoreS3-SE はこのサンプルの対象外。
- Arduino IDE または Arduino CLI。
- M5Stack Board Manager 3.2.2 以上、ボード `M5CoreS3`、QSPI PSRAM 有効。
- M5CoreS3 **1.0.1**、M5Unified **0.2.11 以上**、M5GFX、およびライブラリマネージャーが要求する依存。
- ArduinoJson **7.4.2**。`JsonDocument` / `deserializeJson()` の v7 API を使用。
- 2.4 GHz Wi-Fi、共通 API の URL、アプリ専用 token、HTTPS サーバーを検証できるルート CA 証明書。

OpenAI API キーはバックエンドだけに置きます。本体の `FOCUS_API_TOKEN` は共通 API に接続するための独自 token です。

## 初回設定

1. このフォルダの `cores3.ino` を Arduino IDE で開き、上記ボードとライブラリを選択します。
2. `config.example.h` を同じフォルダの `config.h` へコピーします。実際の `config.h` は Git 管理しません。
3. `WIFI_SSID` / `WIFI_PASSWORD`、`API_BASE_URL`、`FOCUS_API_TOKEN`、`ROOT_CA_PEM` を設定します。URL は `https://api.example.com` のような origin とし、`/v1` や末尾の `/` は付けません。
4. バックエンドの `/health` を別途確認します。このクライアントは開始時に `/v1/sessions` を呼んで接続を検証します。
5. コンパイル後、対象の CoreS3 を選んで書き込みます。既存ファームウェアは置き換わるため、必要な復旧方法を先に用意してください。
6. 起動時に `PAUSED` が表示されることを確認します。`CONFIG REQUIRED` の場合はプレースホルダーが残っています。

`config.h` が無くてもサンプルはビルドできます。その場合は `config.example.h` を読み、設定不足を表示して動作を止めます。API が起動していることはビルドの条件ではありません。

**実機試験は Wi-Fi・API URL・アプリ token・CA の設定と、ユーザーによる実機への書き込みを済ませてから行います。現時点で実機書き込み・カメラ起動・画像送信は実施していません。**

## TLS とローカル検証

標準は HTTPS です。`NetworkClientSecure.setCACert()` で証明書を検証し、NTP の時刻同期完了後に接続します。Wi-Fi は 20 秒、時刻同期は 10 秒でタイムアウトします。TLS 検証を無効化する呼び出しはありません。

ローカルサーバーを HTTP で試す場合のみ、`ALLOW_LOCAL_HTTP = true` と private IPv4 または `.local` の URL を指定してください。token と画像が平文になるため、信頼できる閉じた検証用 LAN でのみ使用します。CoreS3 の `localhost` は CoreS3 自身です。PC のサーバーへ接続するときは PC の LAN アドレスを使用します。既定値は `false` です。

初回は Mac 上の mock API を `HOST=0.0.0.0` で起動し、Mac と CoreS3 を同じ検証用 LAN に接続します。API の起動方法はリポジトリ側の手順に従ってください。クラウドへ移すときは `API_BASE_URL` を公開 HTTPS URL に変更し、そのサーバー用の正しい `ROOT_CA_PEM` を設定して **`ALLOW_LOCAL_HTTP = false` に戻します**。クラウド用 token も対象サーバーと一致させます。

## 送受信契約

すべての `/v1` リクエストに `Authorization: Bearer <FOCUS_API_TOKEN>` を付けます。

| 操作 | リクエスト | 期待値 |
| --- | --- | --- |
| 開始 | `POST /v1/sessions`、JSON `{"device_type":"cores3","duration_seconds":1500}` | HTTP 201、snapshot |
| 判定 | `POST /v1/sessions/{id}/frames`、`Content-Type: image/jpeg`、`X-Frame-Id: 1` など、本文は JPEG バイナリ | HTTP 200、snapshot |
| 一時停止 | `POST /v1/sessions/{id}/control`、JSON `{"action":"pause"}` | HTTP 200、snapshot |
| 再開 | 同上、`{"action":"resume"}` | HTTP 200、snapshot |
| 終了 | 同上、`{"action":"end"}` | HTTP 200、snapshot |

応答は `session_id`、`state`、`notify`、`notification_id`、`continuous_hold_ms`、`required_hold_ms`、`next_capture_after_ms`、`provider` 等を持つ **トップレベルの snapshot JSON** です。`snapshot` オブジェクトで包みません。保有時間の 2 フィールドは符号なし整数で、`required_hold_ms` は `5000` です。本体は型と必須値を検証します。固定 Content-Length / chunked のどちらにも対応し、応答は 4 KiB まで受け付けます。

判定対象は「スマホを手に持っている」状態です。操作や注視を伴わなくても対象となり、机に置かれたスマホは対象外です。API は 1 秒のサンプル間隔を指定し、最初の陽性を `0 ms` として、連続保有が 5 秒以上となる新しい陽性応答で直ちに `notify: true` を返します。確率閾値・連続保有時間・60 秒のクールダウンはサーバーが管理します。陰性・不明・判定エラー・一時停止・終了、または観測間隔が 2500 ms を超えた場合、連続保有時間はリセットされます。

本体は成功応答の `next_capture_after_ms` だけ待って次の画像を送ります。`continuous_hold_ms` と `required_hold_ms` を `Hold 1.0 / 5.0 s (API)` のように表示し、本体側の時計で進捗を増やしたり、5 秒到達を判定したりしません。通信失敗時の再試行待ちだけ 3 秒を置きます。フレーム ID はセッション内の連番で、新しい画像ごとに増えます。

実際に手に取った瞬間から正確に 5 秒での通知は保証できません。画像取得・通信・推論の遅延が加わります。推論等が遅く、API の観測間隔が 2500 ms を超えると進捗はリセットされるため、その環境ではスマホを持ち続けても通知まで進まない場合があります。実機デモ前に API 側の観測間隔を確認してください。

`notify: true` かつ未処理の `notification_id` の場合だけ `PUT PHONE DOWN` と短い音を出します。`provider: "mock"` では `MOCK` を表示し、実画像による判定と区別します。通信失敗・不正 JSON・カメラ失敗は `UNKNOWN` で、スマホ検出として扱いません。

## 撮影・停止の動作と限界

- 撮影は `CoreS3.Camera.begin()` → RGB565 / QVGA フレーム取得 → `frame2jpg(..., 80, ...)` → フレーム返却の順です。JPEG だけを送信し、送信終了後に `free()` します。
- スナップショットごとに `esp_camera_deinit()` し、HTTP 待ち中や停止中にカメラを継続実行しません。繰り返し初期化による露出・色・遅延は実機で確認が必要です。
- HTTP と画像処理は FreeRTOS worker で行います。メイン loop は通信中もタッチを処理します。カメラの取得・JPEG 変換中だけ、I2C 競合を避けるためタッチ処理を待たせます。その短い区間の実測時間は未確認です。
- `STOP` / `END` を処理した時点で、新しい撮影・送信を許可しなくなります。すでに開始した取得や HTTP リクエストを巻き戻すことはできません。世代番号を確認し、停止前の応答から警告やビープを出しません。
- サーバーへの pause / end は進行中リクエストの終了・タイムアウト後に送ります。HTTP 接続・応答、TLS handshake にそれぞれタイムアウトを設定していますが、これらの合計が単一の 10 秒以内になる保証はありません。
- 停止操作後は接続エラー時も本体の撮影を止めたままにします。終了要求は成功するまで保持して再試行します。`END` の直後に `START` を押しても、古いセッションの終了確認までは新しいセッション・撮影を始めません。開始 API が受理された後に応答だけ失われた場合、セッション ID を取得できずサーバーに未操作セッションが残る場合があります。
- 撮影中断・通信断からの復旧、タッチとカメラの共存、長時間のヒープ使用量は実機で検証してください。日本語フォントと音声読み上げは含めていません。

## 最初の実機試験

1. **未開始**：起動後 15 秒待ち、バックエンドに frames が届かないことを確認。
2. **開始と形式**：`START` → sessions 作成 → JPEG の形式検証を通過した応答を確認。共通 API は画像の保存・プレビューを提供しません。大きさ・向き・明るさの目視確認が必要なら、別途 M5Stack の公式カメラ表示サンプル等を使い、本体でローカル確認してください。
3. **mock 表示**：mock backend で `MOCK` を確認。通知 ID が同じ間はビープを繰り返さないことを確認。
4. **判定と 5 秒進捗**：実判定 backend で、スマホなし・机上のスマホ・手に持ったスマホ・手元が見えない場面を確認。操作や注視をせず持つだけでも、API の `Hold 0.0 / 5.0 s` から進捗が増え、5 秒以上の陽性応答で直ちに警告・音が出ることを確認。途中で机に置く、手元を隠す、`STOP` する、観測間隔が 2500 ms を超える場合に進捗がリセットされることも確認。`UNKNOWN` をスマホ検出と区別。
5. **通信中停止**：サーバー応答を遅らせ、待機中に `STOP`。その後に返った `notify: true` で警告・音が出ず、新しい frames が届かないことを確認。
6. **再開・終了**：`START` で同じセッションを再開。`END` 確認後は新規撮影なし。次の `START` で新しい ID を確認。
7. **障害**：Wi-Fi 切断・不正 token・不正 CA・サーバー停止をそれぞれ試し、`UNKNOWN` 等の失敗表示になり警告音が出ないことを確認。
8. **継続**：15 分以上稼働して、メモリ不足・再起動・タッチ停止が起きないか確認。

## ビルド確認

2026-10-18 時点で構造レビューを実施。ビルドを試みたものの、既存 Arduino 環境が参照する `/Volumes/AIWorkSSD/AIWorkSpace/arduino/data` のボリュームが利用不可となり、コンパイルは完了していません。バイナリサイズ・実機 RAM 使用量・実機動作は未確認です。

試行時に列挙できた環境は M5Stack core **3.3.8**、M5Unified **0.2.19**、M5GFX **0.2.26**。M5CoreS3 **1.0.1** と ArduinoJson **7.4.2** は公式の固定タグから一時フォルダにだけ取得しました。グローバルライブラリの追加や実機書き込みはしていません。この組合せでのビルド成功はまだ確認できていません。

Arduino CLI での通常ビルド例（必要ライブラリを導入済みの場合）：

```sh
arduino-cli compile --fqbn m5stack:esp32:m5stack_cores3 devices/cores3
```

## 公式根拠

- [M5Stack の現行カメラ例と要件](https://docs.m5stack.com/en/arduino/m5cores3/camera)
- [M5CoreS3 1.0.1 のカメラ実装](https://github.com/m5stack/M5CoreS3/blob/1.0.1/src/utility/GC0308.cpp)
- [Espressif の frame2jpg API](https://github.com/espressif/esp32-camera/blob/master/conversions/include/img_converters.h)
- [Espressif の HTTPS クライアント例](https://github.com/espressif/arduino-esp32/blob/master/libraries/HTTPClient/examples/BasicHttpsClient/BasicHttpsClient.ino)
- [ArduinoJson 7.4.2](https://github.com/bblanchon/ArduinoJson/releases/tag/v7.4.2) / [v7 JsonDocument](https://arduinojson.org/v7/api/jsondocument/)
