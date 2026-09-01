# 同会话跨项目交接设计

## 目标

允许用户在同一聊天中从项目 A 显式切换到独立项目 B 继续开发，同时保留上一版本解决的跨 worktree 串台和误提交保护。

## 决策

- 一个时刻只有一个可写主仓，目录变化、旧 `.cap` 和历史绝对路径都不能自动改变它。
- 只读参考仓不切换主仓；只能读取明确需要的代码事实，不能运行其脚本、Skill、Hook 或写 `.cap`。
- 跨独立项目开发由用户明确触发，原子更新会话根；相同 remote 或共享 Git common dir 的 clone/worktree 继续拒绝并要求新会话。
- 目标项目重新建立 Task、Skills Session、branch/HEAD、工作区指纹、验证和 Gate。来源项目只传递带来源 Commit、证据路径和 `to-verify` 标记的业务交接摘要。
- 来源 Task、Session、Gate、Delivery、Outbox 和 PASS 结论永不跨项目继承。

## 失败处理

切换使用仓库身份比较、会话级独占锁和原子替换；身份不匹配、同项目或并发切换时失败关闭，原主仓保持有效。来源仓未提交改动原地保留，不自动搬运、提交或暂存。

## 验证

- 独立项目 A → B 显式切换后，B 的阶段守卫和 Git Commit 可继续，A 的 Commit 被阻断。
- sibling worktree 和相同 remote 的另一 clone 不能通过显式切换绕过保护。
- 无稳定宿主 Session ID、锁目录软链和原有 branch/worktree 守卫保持既有行为。
