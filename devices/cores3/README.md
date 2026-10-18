# CoreS3 独立クライアント

CoreS3 自身のカメラ画像を共通判定 API に送り、本体の日本語画面と日本語音声で知らせる Arduino サンプルです。Mac の常駐は不要です。判定には Wi-Fi とバックエンドが必要です。

**起動しただけでは撮影・画像送信を始めません。** 本体画面の「開始」を押して開始します。「検知停止」は撮影と判定を止め、「検知再開」で再開、「終了」はセッションを終了します。残り時間は最大表示し、検知停止中もAPIのセッション有効期限と同様に進みます。期限到達時は撮影を終了します。終了後の開始では新しい集中時間を作ります。

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

**実機のJPEG→公開Worker→OpenAI応答を確認済みです。直近の保持試験では陽性判定を受けましたが、通信間隔による保持リセットで通知には到達していません。日本語UI・音声を含む新しい版はFlash 83%、静的RAM 21%でコンパイル成功しています。**

## TLS とローカル検証

標準は HTTPS です。`NetworkClientSecure.setCACert()` で証明書を検証し、NTP の時刻同期完了後に接続します。Wi-Fiの接続待ちは20秒（事前の電波スキャン時間を除く）、時刻同期は10秒でタイムアウトします。TLS 検証を無効化する呼び出しはありません。

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

応答は `session_id`、`state`、`notify`、`notification_id`、`continuous_hold_ms`、`required_hold_ms`、`next_capture_after_ms`、`provider` 等を持つ **トップレベルの snapshot JSON** です。`snapshot` オブジェクトで包みません。保有時間の2フィールドは符号なし整数です。本体は型と必須値を検証し、`required_hold_ms` はAPIが返す正の値を受け入れます。固定5000msとして拒否しません。2026-10-18に公開Workerの画像なし開始/終了で `required_hold_ms: 2000`、`provider: "openai"` を実測しました。固定 Content-Length / chunked のどちらにも対応し、応答は 4 KiB まで受け付けます。

判定対象は「スマホを手に持っている」状態です。操作や注視を伴わなくても対象となり、机に置かれたスマホは対象外です。最初の陽性を `0 ms` として、APIが指定する保持時間を満たす新しい陽性応答で `notify: true` を返します。確率閾値・連続保有時間・通知間隔はサーバーが管理します。現在の公開Workerは保持2秒・クールダウンなしです。ローカルAPIなど設定が異なる場合も、本体は応答の `required_hold_ms` と `next_capture_after_ms` に従います。陰性・不明・判定エラー・一時停止・終了、またはAPIの許容観測間隔を超えた場合、連続保有時間はリセットされます。CoreS3は通信と撮影時間を考慮し許容10,000 ms、他端末は2,500 msです。

本体は成功応答の `next_capture_after_ms` だけ待って次の画像を送ります。`continuous_hold_ms` と `required_hold_ms` はシリアル診断へ出し、本体側の時計で保持進捗を増やしたり、通知時刻を判定したりしません。画面の残りタイマーは集中セッションの時間で、スマホ保持時間とは別です。通信失敗時の再試行待ちだけ 3 秒を置きます。フレーム ID はセッション内の連番で、新しい画像ごとに増えます。

実際に手に取った瞬間からAPI指定の保持時間ぴったりでの通知は保証できません。画像取得・通信・推論の遅延が加わります。推論等が遅く、CoreS3 の観測間隔が 10,000 ms を超えると進捗はリセットされるため、その環境ではスマホを持ち続けても通知まで進まない場合があります。実機デモ前に API 側の観測間隔を確認してください。

`notify: true` かつ未処理の `notification_id` の場合だけ 赤い背景の「スマホを置いてください」と「スマホを置いて、集中に戻りましょう。」の日本語音声を出します。録音済み3.02秒・16kHz mono PCMをFlashに置き、再生中の重複音声は追加しません。STOP/ENDは通知表示と音声も止めます。`provider: "mock"` では `MOCK` を表示し、実画像による判定と区別します。通信失敗・不正 JSON・カメラ失敗は `UNKNOWN` で、スマホ検出として扱いません。

## USB シリアルでの診断

115200 baud のシリアルモニターに、起動時の設定可否、設定先の電波が見えるか・チャンネル・認証方式の番号・RSSI・切断理由コード、撮影の成否・JPEGのバイト数・処理時間、HTTPステータス、画面の状態、ビープ要求を出力します。設定先のSSIDや周辺SSID一覧は出力しません。Wi-Fiの資格情報、API token、画像本体は出力しません。`Japanese voice reminder requested` は音声の出力を要求した証拠であり、実際に聞こえたかは実機で確認してください。

タッチ操作のほか、改行付きの大文字 `START` / `STOP` / `END` をシリアルから送って同じ操作を行えます。シリアル接続だけでは撮影を開始しません。`START` を送ると本体のカメラ画像が設定済みAPIへ送られます。設定不足の場合はコマンドを受け付けません。

## 撮影・停止の動作と限界

- 撮影は `CoreS3.Camera.begin()` → RGB565 / QVGA フレーム取得 → `frame2jpg(..., 80, ...)` → フレーム返却の順です。JPEG だけを送信し、送信終了後に `free()` します。
- スナップショットごとに `esp_camera_deinit()` し、HTTP 待ち中や停止中にカメラを継続実行しません。繰り返し初期化による露出・色・遅延は実機で確認が必要です。
- HTTP と画像処理は FreeRTOS worker で行います。メイン loop は通信中もタッチを処理します。カメラの取得・JPEG 変換中だけ、I2C 競合を避けるためタッチ処理を待たせます。最新の実機試験でカメラ取得・JPEG変換は405〜439 msでした。
- `STOP` / `END` を処理した時点で、新しい撮影・送信を許可しなくなります。すでに開始した取得や HTTP リクエストを巻き戻すことはできません。世代番号を確認し、停止前の応答から警告やビープを出しません。
- サーバーへの pause / end は進行中リクエストの終了・タイムアウト後に送ります。HTTP 接続・応答、TLS handshake にそれぞれタイムアウトを設定していますが、これらの合計が単一の 10 秒以内になる保証はありません。
- 停止操作後は接続エラー時も本体の撮影を止めたままにします。終了要求は成功するまで保持して再試行します。`END` の直後に `START` を押しても、古いセッションの終了確認までは新しいセッション・撮影を始めません。開始 API が受理された後に応答だけ失われた場合、セッション ID を取得できずサーバーに未操作セッションが残る場合があります。
- 撮影中断・通信断からの復旧、タッチとカメラの共存、長時間のヒープ使用量は実機で検証してください。日本語表示にはM5GFXのefontJAを使用し、音声ヘッダーと再生成用スクリプトを同梱しています。

## 最初の実機試験

1. **未開始**：起動後 15 秒待ち、バックエンドに frames が届かないことを確認。
2. **開始と形式**：`START` → sessions 作成 → JPEG の形式検証を通過した応答を確認。共通 API は画像の保存・プレビューを提供しません。大きさ・向き・明るさの目視確認が必要なら、別途 M5Stack の公式カメラ表示サンプル等を使い、本体でローカル確認してください。
3. **mock 表示**：mock backend で `MOCK` を確認。通知 ID が同じ間はビープを繰り返さないことを確認。
4. **判定とAPI指定の進捗**：実判定 backend で、スマホなし・机上のスマホ・手に持ったスマホ・手元が見えない場面を確認。操作や注視をせず持つだけでも、API の `Hold 0.0 / 2.0 s` から進捗が増え、API指定時間以上の陽性応答で直ちに警告・音が出ることを確認。途中で机に置く、手元を隠す、`STOP` する、観測間隔が 2500 ms を超える場合に進捗がリセットされることも確認。`UNKNOWN` をスマホ検出と区別。
5. **通信中停止**：サーバー応答を遅らせ、待機中に `STOP`。その後に返った `notify: true` で警告・音が出ず、新しい frames が届かないことを確認。
6. **再開・終了**：`START` で同じセッションを再開。`END` 確認後は新規撮影なし。次の `START` で新しい ID を確認。
7. **障害**：Wi-Fi 切断・不正 token・不正 CA・サーバー停止をそれぞれ試し、`UNKNOWN` 等の失敗表示になり警告音が出ないことを確認。
8. **継続**：15 分以上稼働して、メモリ不足・再起動・タッチ停止が起きないか確認。

## ビルド確認

2026-10-18、外部SSD上の既存環境が利用できなかったため、一時フォルダの独立したArduino環境で **コンパイル成功（exit 0）**。M5Stack core **3.3.8**、M5Unified **0.2.19**、M5GFX **0.2.26**、M5CoreS3 **1.0.1**、ArduinoJson **7.4.2** を使用しました。ボードは `m5stack:esp32:m5stack_cores3`、既定のUSB CDC有効・QSPI PSRAM有効・16MB flashです。グローバルArduino設定は変更していません。

プログラム領域は **1,306,431 bytes / 3,145,728 bytes（41%）**、静的RAMは **68,520 bytes / 327,680 bytes（20%）**。画像取得やHTTP処理中のヒープ・PSRAM使用量は、この静的集計には含みません。USBのESP32-S3を識別して `/dev/cu.usbmodem101` へ書き込み成功（exit 0、書き込み内容のhash検証成功）。初回の未設定状態では `boot configured=0 camera=idle` と `CONFIG REQUIRED`、設定後の再ビルド・書き込みでは `boot configured=1 camera=idle` と `PAUSED` を確認しました。開始操作なしでは撮影/フレーム送信ログが出ません。明示的な `START` でWi-Fi接続を試し、`target_visible=0 scan_ok=1` と切断理由 `201`（Espressifの `WIFI_REASON_NO_AP_FOUND`）を確認しました。設定先が見えないためチャンネル・認証方式・RSSIは取得できていません。SSID/password文字列の前後空白・不可視の書式制御文字はありませんでした。

`STOP` → `END` の後は `ENDED / No active server session` を確認し、再接続・撮影・送信は始まりません。接続待ちの取消時に古いassociationを切断し、サーバーセッションがないSTOP/ENDでは新たなWi-Fi接続を始めないよう修正しています。カメラ・実機からのAPI接続・5秒進捗・ビープは未確認です。ログは画面描画や音の要求を表すもので、物理画面の目視・音の聴取は別途必要です。

ESP32-S3のWi-Fiは [Espressif公式仕様](https://www.espressif.com/products/socs/esp32-s3) の2.4GHz（802.11 b/g/n）です。今回の記録から設定先が5GHz専用と断定はできません。2.4GHz側の正しいSSID・電波が端末から見えることを確認してから再試験してください。

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

2026-10-18追記：公開Worker用HTTPS設定（共有token・ISRG Root X1・ローカルHTTP無効）で再ビルドと4領域hash検証付き実機書き込みに成功。USB native reset後のwatchdog resetで `configured=1 camera=idle` / `PAUSED` を確認。保持時間を固定5000msとして拒否する検証を、API指定の正の範囲を受け入れる検証に修正しました。STARTは画像送信の明示許可不足として自動承認レビューに拒否され、撮影/実機API/通知は未検証。STOP/END後は `ENDED / No active server session` を確認しています。


### 日本語UI・音声版の実機確認

最新の日本語タイマー・音声版はコンパイル成功（Flash 2,621,167 bytes / 83%、静的RAM 68,952 bytes / 21%）。USB再接続後の低速fullimage書き込みで4領域のhash検証に成功し、`configured=1 camera=idle`、`ENDED / No active server session` の起動・停止を確認しました。途中のboot/flash不整合はこの再書き込み後に解消しています。

明示許可された画像送信試験では、25.1秒の撮影でJPEG 13枚がすべて公開Worker/OpenAIからHTTP 200。最後の1枚はphone 0.94 / observable 0.86の陽性、先行12枚はinsufficient_visibilityでした。最初の陽性で試験時間が終了したため保持時間は0、notify=falseで、この試験では警告画面・音声はまだ発火していません。remote pause/endのHTTP 200と端末ENDEDを確認して撮影を止めています。
