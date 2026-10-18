# 共通判定API：Cloudflare Worker引き継ぎ

Mac・Reachy Mini・CoreS3が同じREST APIを利用します。RESTは通信形式、Bearerは認証方式で、両方を組み合わせます。画面・撮影・音や動きの実装は各端末チームの担当です。レビュー用の詳細仕様は[API仕様書.md](./API仕様書.md)、機械可読な型は[openapi.yaml](./openapi.yaml)を参照してください。

## メンバー向け共有先

- API入口：https://focus-shared-api-20261018.take-otani.workers.dev/
- レビュー用仕様書：https://focus-shared-api-20261018.take-otani.workers.dev/docs
- OpenAPI：https://focus-shared-api-20261018.take-otani.workers.dev/openapi.json
- 設定状態：https://focus-shared-api-20261018.take-otani.workers.dev/health

これらのGETは認証不要です。`/`は利用可能なURLを返すJSON、`/docs`はMarkdown、`/openapi.json`はOpenAPI JSONです。API利用者にCloudflareのメンバー登録は不要です。`/v1/`呼び出し用の`FOCUS_API_TOKEN`は別経路で共有し、`OPENAI_API_KEY`はサーバー専用とします。`/health`の`configured`で設定状態を確認してください。

## 起動と配備

リポジトリ直下で実行します。ローカル用の`cloudflare/.dev.vars`を作成し、実値はコミットしません。

```dotenv
FOCUS_API_TOKEN=replace-with-demo-token
DECISION_PROVIDER=mock
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
# 実判定の場合のみ DECISION_PROVIDER=openai と OPENAI_API_KEY を設定
```

```sh
npm install
npm run start:worker
npm run test:worker
npm run check:worker
npx wrangler secret put FOCUS_API_TOKEN -c cloudflare/wrangler.jsonc
npx wrangler secret put OPENAI_API_KEY -c cloudflare/wrangler.jsonc
npm run deploy:worker
```

`start:worker`は`wrangler dev -c cloudflare/wrangler.jsonc`、`check:worker`はdry-run、`test:worker`はNodeテストです。配備設定の既定プロバイダーは`openai`です。`DECISION_PROVIDER`は`mock` / `openai`。`OPENAI_API_KEY`はサーバー専用です。`/health`の`configured`は設定の確認で、OpenAIとの疎通や精度の保証ではありません。mockは画像を解析しません。

公開URL：`https://focus-shared-api-20261018.take-otani.workers.dev`。以下の`BASE_URL`をそのHTTPS URLへ置換します。ローカルは`http://127.0.0.1:8787`です。Webチームは実際のOriginを`ALLOWED_ORIGINS`へ完全一致で登録してください（パス・末尾スラッシュ・ワイルドカードなし）。既定は`http://localhost:3000,http://localhost:5173`。端末のHTTP通信にはCORS設定は不要です。

## 実APIの疎通確認とエラー診断

`cloudflare/.env.connection` に `FOCUS_API_URL` と端末接続用の `FOCUS_API_TOKEN` を設定して、リポジトリ直下で次を実行します。このファイルはGit管理対象外です。OpenAIキーはWorkerのSecretに設定します。

```sh
npm run smoke:worker
# 任意：自分で用意したJPEG/PNGを使う
FOCUS_SMOKE_IMAGE_PATH=/path/to/frame.jpg npm run smoke:worker
```

既定では有効な無地PNGを生成し、実Decisions APIへ1枚だけ送ります。キーが有効であることとレスポンスの解析を確かめる試験で、スマホ認識精度の試験ではありません。生成画像では `insufficient_visibility` が正常な判定になり得ます。`provider: openai` と両確率が0〜1の数値であることを確認し、HTTP 200でも `provider_error` や確率nullなら失敗終了します。セッション取得・重複送信・一時停止・再開も確認し、試験セッションは終了します。実API利用分の料金が発生する場合があります。

`provider_error` は上流の非2xx応答です。Workerのサーバーログには次のような安全な診断を記録します。

```json
{"event":"openai_decision_error","status":401,"code":"invalid_api_key","type":"invalid_request_error"}
```

記録するのはHTTPステータスと許可したエラー分類だけです。キー・画像・上流のメッセージ・ヘッダーは記録しません。未知の分類は `unknown` になります。利用者向けレスポンスは引き続き `reason: provider_error` です。

`401 / invalid_api_key` の場合、Cloudflareの **Workers & Pages → focus-shared-api-20261018 → Settings → Variables and Secrets** で `OPENAI_API_KEY` を有効なOpenAI APIキーの値に更新し、Deployしてから再試験します。`FOCUS_API_TOKEN` やCloudflare APIトークンはここには使いません。`configured:true` は値の存在確認にすぎず、OpenAIが認証したことを意味しません。

## 操作

| メソッド | パス | 入力 / 応答 |
| --- | --- | --- |
| GET | `/health` | 認証不要、provider/configured |
| POST | `/v1/sessions` | device_type、任意duration_seconds → 201 snapshot |
| GET | `/v1/sessions/{id}` | 現在のsnapshot |
| POST | `/v1/sessions/{id}/frames` | 生JPEG/PNG → 判定snapshot |
| POST | `/v1/sessions/{id}/control` | action: pause/resume/end → snapshot |

`/v1/`以下はすべて`Authorization: Bearer <FOCUS_API_TOKEN>`が必要です。JSONは16 KiB以下。画像は1 MiB以下、生バイト列で送信します（multipartやBase64ではありません）。`X-Frame-Id`はセッション内一意、英数字と`_.:-`で1〜128文字です。同時に送る画像は1枚までです。判定中に別IDを送ると409、同じ受理済みIDなら200 `duplicate_frame`・通知なしで返ります。

```sh
BASE_URL='https://focus-shared-api-20261018.take-otani.workers.dev'
FOCUS_API_TOKEN='REPLACE-WITH-DEMO-TOKEN'
curl "$BASE_URL/health"
curl "$BASE_URL/v1/sessions" -H "Authorization: Bearer $FOCUS_API_TOKEN" -H 'Content-Type: application/json' --data '{"device_type":"cores3","duration_seconds":1500}'
# 上の応答から session_id をコピー
SESSION_ID='REPLACE-WITH-SESSION-ID'
curl "$BASE_URL/v1/sessions/$SESSION_ID/frames" -H "Authorization: Bearer $FOCUS_API_TOKEN" -H 'Content-Type: image/jpeg' -H 'X-Frame-Id: cores3-000001' --data-binary @frame.jpg
curl "$BASE_URL/v1/sessions/$SESSION_ID" -H "Authorization: Bearer $FOCUS_API_TOKEN"
curl "$BASE_URL/v1/sessions/$SESSION_ID/control" -H "Authorization: Bearer $FOCUS_API_TOKEN" -H 'Content-Type: application/json' --data '{"action":"end"}'
```

## 端末実装の最小例

CoreS3はカメラで取得したJPEGのバッファを同じHTTPリクエストへ直接渡します。HTTPSの証明書検証を有効にしてください。以下はCoreS3/ReachyチームがPC上で疎通確認できるPython `requests`例です。カメラ取得部分だけ各端末で置き換えます。

```python
import os, time, uuid
from pathlib import Path
import requests

base = os.environ['BASE_URL'].rstrip('/')
headers = {'Authorization': 'Bearer ' + os.environ['FOCUS_API_TOKEN']}
# CoreS3は cores3、Reachy Miniは reachy_mini
r = requests.post(base + '/v1/sessions', headers=headers,
                  json={'device_type': 'reachy_mini', 'duration_seconds': 1500}, timeout=15)
r.raise_for_status()
sid = r.json()['session_id']
seen_notifications = set()
try:
    while True:
        jpeg = Path('frame.jpg').read_bytes()  # 毎回ここで最新のJPEGを撮影
        r = requests.post(f'{base}/v1/sessions/{sid}/frames',
                          headers={**headers, 'Content-Type': 'image/jpeg',
                                   'X-Frame-Id': str(uuid.uuid4())}, data=jpeg, timeout=15)
        r.raise_for_status()
        s = r.json()
        if s['state'] in ('paused', 'ended'):
            break
        if s['notify'] and s['notification_id'] not in seen_notifications:
            seen_notifications.add(s['notification_id'])
            print(s['message'])  # CoreS3の音 / Reachyの動きへ置換
        time.sleep(s['next_capture_after_ms'] / 1000)
finally:
    # 利用者の停止操作では、この要求の前に撮影タイマーとカメラを止める
    requests.post(f'{base}/v1/sessions/{sid}/control', headers=headers,
                  json={'action': 'end'}, timeout=15).raise_for_status()
```

通知は新しいフレーム応答の`notify: true`だけで実行します。GET・保存済みsnapshot・端末タイマーから通知しません。最初の陽性画像から、新しい陽性画像で5000msの継続保持を確認すると通知します。観測間隔が2500msを超えると進捗をリセットします。`next_capture_after_ms`を待ち、さらに固定1秒を足さないでください。遅い通信・推論では継続判定が成立しない場合があり、実時間で正確に5秒後の通知は保証しません。通知後は60秒待機します。pause/endは撮影を即停止し、遅れて届く応答も破棄します。pause中もセッション期限は進みます。

判定失敗はHTTP 200でも`state: unknown, notify: false`となります。HTTPエラーは`{error:{code,message},request_id}`です。401はトークン、403はOrigin、409は送信の重複、413はサイズを確認してください。503はWorkerの設定不足です。`X-Request-Id`で問い合わせできます。

## 保存とデモの範囲

状態・受理済みフレームIDはSQLite Durable Objectsへ永続化し、Worker再起動後も復元します。判定中の再起動は`decision_interrupted`として安全に取り消します。終了・期限後は約30分で削除します。生画像はサーバーに永続保存しません。openaiモードでは画像をOpenAIへ送信します。

共有APIトークンはデモ用で、利用者ごとの分離はありません。ブラウザからは見えるため実値をソースへ固定しないでください。実運用に向けた端末別キー・scope・rate limitは今後の課題です。
