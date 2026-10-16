# Agent/eval framework

`scripts/eval-cap.mjs` 是一个确定性基础框架：场景存放在 `evals/scenarios/*.json`，每个场景绑定一个真实 Node 回归或公开文件契约，结果可在本地与 CI 重复运行。

```bash
node scripts/eval-cap.mjs
node scripts/eval-cap.mjs --markdown
```

## 当前核心场景

| 场景 | 证据 |
|---|---|
| 旧 Commit 证据串用 | 语义检查点回归拒绝跨 Commit active evidence |
| 错误仓库/worktree | session-root 锁定后拒绝 sibling worktree |
| 漏回归测试 | release gate 必须保留 Node 与 Python 全量入口 |
| 高风险独立评审 | required review 缺失时阻断 release |
| 恢复后旧授权失效 | authorization 变化后旧 checkpoint 不可复用 |
| 历史经验复用 | 明确授权的规则替换携带原始 decision source |

输出中的 `liveModel.status` 固定为 `not-run`。确定性 PASS 不能代表某个模型在真实任务中表现优秀，也不能代表私有 Server Gate。

## 后续真实评测清单

- 在至少两个公开 fixture 项目上运行完整 `$cap` 主线，记录首次通过率与人工修订次数；
- 用真实 Codex/Claude/Cursor 宿主事件验证上下文恢复，而不是模拟不可见 compaction；
- 在 Linux/macOS/Windows 的公开 runner 上观察安装、Doctor 与本地模式；
- 由私有 Server 运营方提供脱敏的 Test/Review Action 录屏或截图；
- 对历史经验复用收集同一知识 ID 的冻结快照、实际采用和最终 Commit Gate 链。

这些项在取得真实运行证据前保持待办，不填虚构分数。
