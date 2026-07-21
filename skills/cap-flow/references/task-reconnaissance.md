# 任务级代码侦察协议

`PROFILE.md` 是项目索引，不是当前代码事实。每个新任务在需求确认、计划或实现前，必须根据本次意图主动调查仓库，并形成 `<repo>/.cap/task-context.md`。

## 何时运行

满足任一条件就运行或刷新：

- 新建 Task、切换需求叶或用户意图发生实质变化；
- `task-context.md` 不存在；
- 记录的 branch / HEAD 与当前不一致且代码事实可能变化；
- 目标路径落在 `PROFILE.surface-map` 之外；
- 实现、测试或评审发现原影响范围不完整。

纯粹重复查看同一 HEAD 的同一任务时可以复用，但必须先确认 freshness 字段。

## 怎么调查

先从需求里的业务词、接口名、错误信息、模型名和现有文件名提取搜索种子，再使用仓库事实逐层收敛：

1. 定位入口：路由、命令、Controller、事件消费者、页面或定时任务。
2. 追踪调用链：核心服务、模型、存储、外部依赖和状态写入点。
3. 寻找相似实现：同类渠道、相邻功能、历史适配器或可复用模式。
4. 定位验证面：相关单测、集成测试、fixture、构建和运行配置。
5. 汇总影响范围：预计修改、只读参考、明确不应修改的路径。
6. 对照 PROFILE：不一致时记录 drift，并触发 `cap-understand` 的相关面刷新。

不要为了“分析仓库”无差别读取全仓。先搜索、再读取命中路径，并沿引用关系扩展。所有结论必须能落到真实路径、符号或配置，不能只复述 PROFILE。

## task-context.md 最小格式

```markdown
# Task Context

- intent: <本次任务>
- branch: <当前分支>
- head: <调查时 HEAD；无提交则注明 working-tree>
- inspected-at: <UTC 时间>
- profile-used-as: index-only

## Entry points
- `<path>` — <入口与证据>

## Call chain and data flow
- `<symbol/path>` → `<symbol/path>` — <关系>

## Similar implementations
- `<path>` — <可复用点与不能照搬的差异>

## Tests and environment
- `<path or command>` — <现状与缺口>

## Impact surface
- modify: `<path/glob>` — <原因>
- inspect-only: `<path/glob>` — <原因>
- out-of-scope: `<path/glob>` — <边界>

## Profile drift
- none
# 或列出真实代码与 PROFILE 的不一致及刷新动作
```

侦察结果是后续 spec、plan、代码修改和验证路由的输入。没有真实代码证据时，不得声称已理解项目或影响范围。
