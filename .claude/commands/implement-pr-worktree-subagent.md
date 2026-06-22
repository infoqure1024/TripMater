Issue#$ARGUMENTS に対する PR#$ARGUMENTS2 について Git Worktreeを使い、レビュー指摘に対応してください。

## 対応手順

### 1. 前処理（Worktree 作成前）

- 現在のブランチが`feature/issue-$ARGUMENTS`以外の場合は、`feature/issue-$ARGUMENTS`ブランチをチェックアウトしてください。
- `git checkout feature/issue-$ARGUMENTS && git pull origin feature/issue-$ARGUMENTS` で最新の`feature/issue-$ARGUMENTS`ブランチを取得してください。
- `feature/issue-$ARGUMENTS`が存在しない場合は報告してください。

### 2. Worktree作成

- `git worktree add issue-$ARGUMENTS -b feature/issue-$ARGUMENTS`コマンドでWorktreeを作成してください。
- Worktreeは`issue-$ARGUMENTS`という命名規則に従ったサブフォルダを作成します。

### 3. Worktree 環境の設定

- 作成したサブディレクトリ`issue-$ARGUMENTS`に移動してください。
- `npx husky install`を実行して Husky のパスを設定してください。
- 必要に応じて`npm install`で依存関係をインストールしてください。

### 4. 実装

- RPの最新のレビュー内容を確認し、最適なサブエージェントを選択してレビュー指摘に対応してください。
- レビュー指摘に対応完了後、必ずテストを実行してください。
- `npm run lint`と`npm run typecheck`でコード品質を確認してください。

### 5. プルリクエストに反映

- 変更をコミットし、リモートにプッシュしてください。

### 6. 後処理(クリーンアップ)

- プルリクエスト反映後、メインディレクトリ(/daily-sales-report)に戻ってください。
- `git worktree remove issue-$ARGUMENTS` で Worktree を削除してください。
- 作業が完了したことを報告してください。
