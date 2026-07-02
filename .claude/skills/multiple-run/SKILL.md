---
name: multiple-run
description: This skill should be used when the user asks to run two commands sequentially, e.g. "$1を実行してから$2を実行して", or invokes "/multiple-run <コマンド1> <コマンド2>". Runs the first command, waits for it to finish, then runs the second command.
argument-hint: <コマンド1> <コマンド2>
---

$1 コマンドを実行して。その実行が終わったら $2 コマンドを実行して。
