# 集中支援アプリ — チーム引き継ぎ

カメラで本人がスマホを手に持つ状態を検出し、5秒間続いたら、その端末の通知・音・動きで作業への復帰を促すアプリです。Reachy Mini Wireless、CoreS3、Macは、それぞれ自分のカメラと通知手段で動作します。判定には共通のクラウドAPIを使い、ガジェットの常時動作にMacを必要としない構成を目指します。

このリポジトリの引き継ぎ範囲は、共通API、JavaScript接続クライアント、CoreS3向け実装です。画面デザインとReachy実装は各担当が接続します。MCP対応は今回の必須条件に含めません。

## 4人の担当と結合点

| 担当 | 作業 | 16:00までの結合点 |
| --- | --- | --- |
| Reachy担当 1名 | Wireless上の撮影・開始／停止・音や動作 | 自分でAPIへ画像を送信し、`notify: true`を自機で実行 |
| フロント① | Macのカメラ取得・PCアプリからOSトースト通知 | `FocusClient.frame()`へ画像を渡し、新しい通知だけ実行 |
| フロント② | セットアップ・セッション操作・状態表示 | 開始／停止をAPIにつなぎ、APIの状態をそのまま表示 |
| 私：API＋CoreS3＋管理 | 共通判定・API配備・CoreS3・結合確認・提出 | 全員へAPI URLとデモ用トークンを渡し、全体デモを確認 |

**5秒間の継続保持・しきい値・通知間隔はAPIだけで判断します。** フロントやガジェットは判定ロジックを複製せず、応答の状態を表示し、`notify: true`のときにだけ端末のアクションを実行してください。ブラウザ内トーストだけではMacのOSトースト要件を満たしません。

## 最新の共通仕様

**スマホを手に持った状態が5秒続いたら、5秒到達後の新しい判定応答で直ちに注意します。** 見ていない・操作していない場合も、手に持っていれば対象です。机上にあるだけなら対象外です。旧「3秒間隔・3回連続」仕様より、この5秒仕様を優先します。全体の作業と進捗は[issue #1](https://github.com/aieo-product/devdayHackathon261018/issues/1)に集約します。

撮影の目安は1秒間隔です。最初の陽性画像の受理を0秒として、以降も陽性が続き、受理時刻の差が5秒以上になった画像応答で`notify: true`を返します。非検出・判定不能・停止、または観測間隔が2.5秒を超えた場合は0からやり直します。画像間の連続保持はサンプリングによる推定です。物理的に持った瞬間から正確に5.000秒で通知することは、撮影・通信・推論の遅延により保証できません。実APIの遅延は未計測です。

画面は`continuous_hold_ms` / `required_hold_ms`の確認済み進捗を表示し、ローカルタイマーで通知を作りません。待機中やGETだけで進捗を増やさず、`notify: true`が返ったらすぐ自機の通知を実行します。

## 最初に動かす

Node.js **22.9以上**を使用します。このAPI・テストには外部npm依存がなく、`npm install`は不要です。

```sh
cp api/.env.example api/.env
```

`api/.env`に次を設定します。値は例なので、`FOCUS_API_TOKEN`はチーム用の値に変更してください。

```dotenv
FOCUS_API_TOKEN=replace-with-team-demo-token
DECISION_PROVIDER=mock
MOCK_PHONE_PROBABILITY=0.95
MOCK_OBSERVABLE_PROBABILITY=1
HOST=127.0.0.1
PORT=8787
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

```sh
npm test
npm run start:api
```

別ターミナルから、同じトークンで接続確認します。

```sh
FOCUS_API_URL=http://127.0.0.1:8787 FOCUS_API_TOKEN=replace-with-team-demo-token npm run smoke -- --expect-notify
```

上の設定は**モック**です。画像内容に関係なく指定した確率を返し、通知・停止・接続の確認に使います。画像認識の実演や精度検証として扱わないでください。`/health`とセッション応答の`provider`でモックか実APIかを確認できます。

実APIへ切り替える場合はサーバーの`api/.env`で`DECISION_PROVIDER=openai`と`OPENAI_API_KEY`を設定し、再起動します。実画像を送るスモークテストは明示的に許可します。

```sh
FOCUS_API_URL=https://your-api.example FOCUS_API_TOKEN=replace-with-team-demo-token npm run smoke -- --image /absolute/path/test.jpg --allow-live
```

`--expect-notify`は、通知が出ると期待する画像でだけ追加してください。実APIでは画像内容と判定により通知されない場合があります。OpenAIの実キー、実画像での認識、実機のカメラ・音・OS通知の動作確認は別途必要です。

## 各担当へ渡すもの

- **共通API担当 → 全員：** HTTPSのAPI URL、デモ用`FOCUS_API_TOKEN`、現在の`provider`、[HTTP契約](api-contract.md)。公開Webからの接続先にはHTTPSを使用します。
- **フロント担当：** [JavaScriptクライアント](../clients/focus-client.mjs)を使い、セットアップ画面でAPI URLとデモ用トークンを入力。実際の値をソースや配布バンドルへ固定しません。
- **CoreS3担当：** [CoreS3のREADME](../devices/cores3/README.md)の機種・ライブラリ・カメラ設定に従います。Wi-Fiからバックエンドへ直接HTTP(S)通信し、公開先にはTLSとサーバー証明書の検証を使います。
- **Reachy担当：** Wireless上の処理から同じHTTP契約へ直接接続。画像はJPEGで送信し、頭・アンテナ・音など実装済みの通知アクションを呼び出します。

`OPENAI_API_KEY`は**APIサーバーだけ**に置きます。各端末に渡す`FOCUS_API_TOKEN`とは別物です。ブラウザに渡したデモ用トークンは利用者から見える値であり、サーバー秘密鍵のようには保護できません。本実装は共有トークンでのハッカソン用構成で、利用者ごとの認証・権限分離はありません。

## Mac／画面担当の接続例

```js
import { FocusClient } from './clients/focus-client.mjs';

const focus = new FocusClient({ baseUrl: apiUrl, token: demoToken });
await focus.start({ deviceType: 'mac', durationSeconds: 1500 });

// 呼び出し間隔には snapshot.next_capture_after_ms を使う。
// jpegBlobは自分のカメラから取得する。撮影・OS通知は各担当の実装。
const snapshot = await focus.frame(jpegBlob);
if (snapshot !== null) {
  renderState(snapshot);
  if (focus.active && snapshot.notify) {
    showOsToastOnce(snapshot.notification_id, snapshot.message);
  }
}
```

- `frame()`は一時停止中、古い結果、送信の重複などで`null`を返せます。その場合は通知しません。
- `focus.snapshot`は表示用です。保存された`notify`を画面再描画や定期取得で再実行せず、**その場で返った新しいフレーム応答だけ**を通知に使います。`notification_id`でも重複を防ぎます。
- `start()`・`pause()`・`resume()`・`end()`は`await`し、処理中は操作ボタンを無効にします。状態取得は`await focus.get()`、残り時間の表示は`focus.remainingMs`です。
- 一時停止・終了の操作時点で撮影タイマーとカメラを止め、進行中のローカル画像取得を中止します。遅れて届いた結果は破棄します。`focus.active === false`の間も撮影しません。
- APIは撮影もOS通知も行いません。セッション時間は開始時から経過し、一時停止しても終了予定時刻は延びません。

## 16:00結合・17:00提出まで

| 時刻（2026/10/18 JST） | 到達点 |
| --- | --- |
| 14:17〜14:30 | 担当・HTTP契約を固定。API URL、認証、モック接続を全員で確認 |
| 14:30〜15:00 | Mac／Reachy／CoreS3がそれぞれ撮影→API応答まで一往復 |
| 15:00〜15:30 | 実APIで判定→自機通知。停止・判定不能・通知連打の確認 |
| 15:30〜16:00 | 変更を結合し、公開環境と実機でデモを通す。CoreS3の追加機能は止める |
| 16:00〜16:30 | 結合済みアプリの不具合修正と説明のブラッシュアップ |
| 16:30〜16:45 | 公開URL、公開GitHub、README、デモの最終確認 |
| 16:45〜17:00 | 提出操作と受付確認。**17:00提出完了**を目標 |

管理担当がCoreS3に使う最初の調査は30分を目安にします。撮影→API応答が通らない場合は詰まりを記録して管理に戻り、15:30以降は全体結合を優先します。未完成機種を完成済みと見せず、動作確認できた機種と未確認箇所を提出時に明記します。

## 結合時の確認

- [ ] 全員が同じ公開APIへ接続でき、デモがモックか実APIかを説明できる。
- [ ] スマホ保持が5秒未満なら通知せず、5秒到達後の応答で通知する。机上に置いただけの場合や撮影できない場合は誤通知しないことを実画像で確認する。
- [ ] 通知後はクールダウンし、同じ通知を何度も実行しない。
- [ ] 撮影中・API待ちのどちらで停止しても、撮影と後続通知が止まる。
- [ ] Reachy／CoreS3はMacを中継せず動作し、Macは自分のOS通知を実行できる。
- [ ] 公開URLと公開リポジトリを開け、APIキー・実トークンが公開ファイルに含まれない。

APIは単一プロセスのメモリにセッションを保持するため、再起動でセッションが失われます。複数レプリカ間の共有、永続ログ、ユーザーごとのアカウント管理は未実装です。生画像をアプリ側のファイルに保存する処理はありませんが、実APIモードでは画像をOpenAIへ送信します。

## 参照

- [HTTP契約・応答・エラー一覧](api-contract.md)
- [APIの環境変数・配備手順](../api/README.md)
- [CoreS3の実機セットアップ](../devices/cores3/README.md)
- [OpenAI Decisions APIガイド](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI Decisions APIリファレンス](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create)
