# 跨项目交接稳定性收紧

## 目标

保持“同会话可显式切换独立项目”的现有能力，同时阻止目标仓旧改动混入新任务、旧 `.cap` 状态被静默搬进 ignored 目录，以及根锁已切换但交接摘要未落地的半切换状态。

## 决策

- Task 状态初始化前记录目标仓非 `.cap` 脏路径基线。后续任务侦察声明的 `modify` 与仍然脏的基线路径重叠时失败关闭；解除方式只有续接原任务、形成明确基线 Commit 或使用干净 worktree。
- `.cap` 活动态只允许移动未跟踪文件。发现 Git 已跟踪的 STATE/spec/plan/verify/review 时，在任何 rename 前阻断，保持 Git 状态不变。
- 会话根切换强制携带来源仓已审阅 outgoing 摘要。摘要先写入目标仓临时文件，根锁替换成功后再原子落为 incoming；任一步失败都恢复原根锁。
- 不新增 Skill、不新增生命周期阶段，不自动 stash、提交、合并或迁移用户已有改动。

## 验证

- 跨独立仓切换后 outgoing/incoming 内容哈希一致；摘要缺失时原根仍有效。
- 计划修改路径与任务开始前脏文件重叠时，POSIX 与 Node Context Guard 都阻断；无重叠时保持兼容。
- 已跟踪 `.cap` 的 fixture 在 Task 切换后文件和 Git 状态完全不变。
- 现有 sibling worktree、相同 remote、路径软链、无 Session ID 和正常干净仓回归保持通过。
