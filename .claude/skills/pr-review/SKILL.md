---
name: pr-review
description: This skill should be used when the user asks to review a specific GitHub pull request by number, e.g. "PR #123をレビューして", "プルリクエスト#42をレビューして", or invokes "/pr-review <PR番号>". Reviews the given pull request and posts the review results as a comment on it.
argument-hint: <PR番号>
---

プルリクエスト #$ARGUMENTS をレビューしてください。
レビューが終わったら、結果をプルリクエスト #$ARGUMENTS のコメントに投稿してください。
