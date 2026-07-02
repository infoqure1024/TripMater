---
name: implement-epic-issue
description: This skill should be used when the user asks to implement the child issues of a GitHub epic issue in recommended order, e.g. "エピックIssue #10の子Issueを実装して", or invokes "/implement-epic-issue <エピックIssue番号>". Follows the epic's documented "推奨着手順" (see "実装順・依存"), implementing each linked child issue in turn with the best-suited subagent.
argument-hint: <エピックIssue番号>
---

Github の エピック Issue#$ARGUMENTS に記載された`推奨着手順`（`実装順・依存`を参照）にしたがって、子 Issue の実装を進めてください。
ひとつひとつの Issue について、次の実装手順で作業を進めてください。
エピック記載されたすべての Issue について、実装手順を繰り返し実行してください。
その際、それぞれのタスクに最適なサブエージェントを選択してくだい。

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
