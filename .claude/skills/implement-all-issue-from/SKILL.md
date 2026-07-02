---
name: implement-all-issue-from
description: This skill should be used when the user asks to implement all open GitHub issues starting from a given issue number in order, e.g. "Issue #50からOpenなIssueを全部実装して", or invokes "/implement-all-issue-from <開始Issue番号>". Works through each open issue in ascending order until the highest-numbered issue is complete, choosing the best subagent for each task.
argument-hint: <開始Issue番号>
---

すべての Open 状態の Issue について、#$ARGUMENTS から番号の順に、最も番号の大きな Issue が完了するまで、実装を進めてください。
その際、それぞれのタスクに最適なサブエージェントを選択してくだい。
ひとつひとつの Issue については、次の`実装手順`で作業を進めてください。

### 実装手順

1. Issue の実装
1. PR の作成
1. PR のレビュー（結果をコメントに投稿）
1. レビュー指摘への対応
1. PR の再レビュー
1. 優先度が高および中の指摘がなくなるまで、`レビュー指摘への対応`と`PR の再レビュー`を繰り返し実施
1. CI が失敗していれば修正
1. 優先度が低の指摘を Issue として登録
1. PR を`Create a merge commit`でマージ（このとき実施した Issue をクローズ）
