# Reachy Focusの直接公開

GitHubの共有リポジトリとHugging Face Spaceは同一内容のGitリモートです。
公開するアプリ名（Space名）はPython entry pointと揃えて `reachy_focus` にします。

## 初回リリース

1. ローカルテスト、wheel/sdist内容検査、公式CLI `check .` を通す。
2. 実機チェックリストを埋め、未確認事項を公開ページへ正しく記載する。
3. PRをレビューして統合先ブランチへマージする。現在の共有デフォルトは `feat/shared-focus-api`（mainは未作成）。未レビューの作業ブランチを配布しない。
4. 公開先HFアカウントで空の**static Space** `reachy_focus` を作成する。READMEの自動生成は不要。CLI `hf auth login` と `hf auth whoami` でアカウントを確認する。トークンはソースに書かない。
5. そのSpaceのURLを `huggingface` リモートとして追加し、検証済みコミットをそのままpushする。

```sh
git remote add huggingface https://huggingface.co/spaces/YOUR_ACCOUNT/reachy_focus
git push origin HEAD:feat/shared-focus-api
git push huggingface HEAD:main
# GitHubの統合ブランチとHFのmainのSHAが同じことを確認
git ls-remote origin refs/heads/feat/shared-focus-api
git ls-remote huggingface refs/heads/main
```

すでにHF側に独立したコミットがある場合はforce pushせず、履歴を確認して整合させる。
SpaceのURLでランディングページが表示されることと、別端末のReachy Mini Controlから
インストール・起動・停止できることを確認する。Spaceのページ自体は静的な配布案内であり、
ブラウザ内で本体セッションを代行するものではない。

## 更新

統合先ブランチのテスト済みコミットを両リモートへ同じようにpushする。
実機のアップデート→起動→操作ページ→停止まで確認する。
戻す場合はソースをrevertした新しいコミットをテストして両リモートへpushする。
HFリモートへの自動同期ワークフローはまだ有効化しない（公開先と認証が未設定）。

## ストア掲載

READMEの `reachy_mini` / `reachy_mini_python_app` タグを維持する。
タグで探索されるコミュニティアプリと、公式の承認済み標準一覧は別。
Space公開だけで標準一覧への掲載完了とは報告しない。公式の掲載申請手順と
対応Control/daemon版を公開時に再確認する。

## 他機器の変更をマージするとき

- ルートのHFメタデータとReachy entry pointを維持する。
- Pythonのfind設定を「全フォルダの自動検出」に広げない。
- NodeやCoreS3の依存関係は既存の各プロジェクト内で完結させる。
- `scripts/check-reachy-package.py` でPython配布物を検査する。
- リポジトリ全体はSpaceにも公開される。ローカルキー・Wi-Fi設定を追加しない。
