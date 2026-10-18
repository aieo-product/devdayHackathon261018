# 配布アセットの由来

現在の画面で使用する画像だけを含めています。実カメラの映像、人物の撮影画像、制作途中の旧キャラや動画は含めていません。

| ファイル | 由来と用途 |
|---|---|
| `assets/todd.png` | ユーザーが選んだDOTS風の画面デザインを参照し、内蔵image_genで生成した透過キャラクター。元のライム色・大きな目・黒い蝶ネクタイを保ち、1体の相棒として使用 |
| `assets/design-reference.png` | ユーザー提供のUIデザイン参照画像。カメラ未起動時の机のサンプル表示に使用。実カメラ画像ではない |
| `assets/lyric-type/start.png` | 内蔵image_genで作成した開始用の透過日本語タイポグラフィ |
| `assets/lyric-type/alert.png` | 内蔵image_genで作成した警告用の透過日本語タイポグラフィ |
| `assets/lyric-type/complete.png` | 内蔵image_genで作成した完了用の透過日本語タイポグラフィ |

文字画像にはアプリ側で単色のDOTSシルエットを重ねます。フォントファイルの同梱はなく、通常UIは端末のシステムフォントを使います。効果音はWeb Audioで合成しており、音声ファイルを配布しません。

[OpenAI DOTS](https://chatgpt.com/features/dots/)を参照したハッカソン用の試作であり、OpenAIによる公式配布素材・公式製品を示すものではありません。[dopa-drill](https://github.com/grmchn/dopa-drill)は演出の参考にしたリポジトリで、コード・画像・音源のコピーは含みません。ここでの由来説明は第三者の名称・キャラクターの権利を変更するものではありません。
