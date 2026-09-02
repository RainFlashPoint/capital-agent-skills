# 跨项目切换与上下文交接

跨项目顺序开发允许在同一聊天中继续，但不共享项目身份。任何时刻只有一个**可写主仓**；另一个项目要真正修改时，必须显式切换，不能因为当前目录变化或旧 `.cap` 路径而自动切换。

## 允许传递的内容

切换前由当前 Agent 在来源仓生成一份简短交接摘要，先写入 A 的 `.cap/handoff/outgoing/`；主仓切换成功后，再把同一份脱敏摘要放入 B 的 `.cap/handoff/incoming/`。两处都属于本地活动态，不提交到业务仓。每条事实都带来源：

- 业务目标与未完成问题；
- 跨项目接口/数据契约和依赖关系；
- 来源项目、来源分支和精确 Commit；
- 需要目标项目重新确认的文件、符号和验证动作；
- 明确标记 `confirmed` / `to-verify`，以及失效条件。

交接摘要是**线索，不是事实**。目标项目必须重新侦察代码并刷新自己的 `task-context.md`；不能继承来源项目的 Task、Session、Gate、测试 PASS、Review PASS、Delivery 或 Outbox。

## 切换动作

显式说“切换到项目 B 继续开发”后：

1. 记录 A 的当前状态；未提交改动不搬运、不自动提交。
2. 使用 package 根 `scripts/cap-session-root.mjs switch <A> <B> --handoff <A>/.cap/handoff/outgoing/<name>.md`，把已审阅摘要原子复制到 B 后再切换可写主仓。摘要缺失、冲突或复制失败时保持 A 为主仓。
3. B 重新创建/绑定自己的 Task 和 Skills Session，重新读取 B 的 `.cap` 和代码事实。
4. 交接摘要只作为 B 的侦察输入；所有验证、提交和回写只发生在 B。

目标 Task 初始化时会记录 B 当时已有的非 `.cap` 脏文件。任务侦察声明的 `modify` 路径与这些旧脏文件重叠时，编码门禁必须停止；只能续接旧任务、先形成明确基线 Commit，或改用干净 worktree。不得用“只 add 文件名”冒充改动归属隔离。

若 B 的 `.cap/STATE.md`、`spec.md`、`plan.md`、`verify/` 或 `review/` 已被 Git 跟踪，Task 状态切换不得把它们移动到 ignored `local-state`。先显式完成一次仓库 `.cap` 生命周期迁移；失败时原文件和 Git 状态必须保持不变。

最小摘要结构：

```text
source: <repo> @ <branch> / <full commit>
target: <repo>
intent: <为什么切换>
confirmed: <来源仓已由具体文件/符号证明的事实 + 相对证据路径>
to-verify: <目标仓必须重新核对的假设、接口和版本>
target-work: <只属于目标仓的预期修改与验收动作>
non-transferable: Task / Session / Gate / Delivery / Outbox / PASS
```

同一远程项目的不同 clone/worktree 仍视为同一项目，继续阻断；要切换这类 worktree，仍新建会话。只读查看另一个项目不需要切换主仓，但不得运行其脚本、Skill、Hook 或写入其 `.cap`。

## 安全不变量

- 主仓切换必须由用户意图触发，禁止自动跟随 `cd`、历史索引或绝对路径。
- 切换后旧 Task/Session 的事件不能进入新项目 Outbox；历史事件仍按原项目边界保留。
- 目标项目的 `HEAD`、branch、工作区指纹和验证命令必须重新建立；来源项目的证据只能作为待验证参考。
- 如果切换失败，会话仍锁定原主仓，不得部分切换。
- Codex 页面显示的启动 cwd 可能仍是来源仓；切换结果中的 canonical root 才是逻辑主仓，后续文件和命令操作必须显式使用该目录。
