Issue#$ARGUMENTS に対する PR#$ARGUMENTS2 について Git Worktree を使い、レビュー指摘に対応してください。
実装の際には、最適なサブエージェントを選択して実装してください。

## 対応手順

### 1. Worktree 作成

- `git worktree add issue-$ARGUMENTS origin/feature/issue-$ARGUMENTS`コマンドで Worktree を作成してください。
- Worktree は`issue-$ARGUMENTS`という命名規則に従ったサブフォルダを作成します。
- `feature/issue-$ARGUMENTS`が存在しない場合は報告してください。

### 2. Worktree 環境の設定

- 作成したサブディレクトリ`issue-$ARGUMENTS`に移動してください。
- `git checkout feature/issue-$ARGUMENTS && git pull origin feature/issue-$ARGUMENTS` で、最新の`feature/issue-$ARGUMENTS`ブランチを取得してください。
- `npx husky install`を実行して Husky のパスを設定してください。
- 必要に応じて`npm install`で依存関係をインストールしてください。

### 3. 実装

- RP の最新のレビュー内容を確認し、最適なサブエージェントを選択してレビュー指摘に対応してください。
- レビュー指摘に対応完了後、必ずテストを実行してください。
- `npm run lint`と`npm run typecheck`でコード品質を確認してください。

### 4. プルリクエストに反映

- 変更をコミットし、リモートにプッシュしてください。

### 5. 後処理(クリーンアップ)

- プルリクエスト反映後、メインディレクトリに戻ってください。
- `git worktree remove issue-$ARGUMENTS` で Worktree を削除してください。
- 作業が完了したことを報告してください。
