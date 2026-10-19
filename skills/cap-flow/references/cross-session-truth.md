# 跨会话真值与决定对账

用于会话恢复、长时间停顿、另一个会话或人员可能已推进任务、状态查询，以及提交、迁移、CI、部署、发布等外部动作之前。它是 `cap-flow` 的流程纪律，不新增阶段或顶层 Skill。

## 核心原则

旧聊天摘要、旧 STATE、旧报告和模型记忆只用于定位线索，不能证明当前状态。按事实领域回到对应权威来源：

- 用户意图、授权、禁止与范围：当前任务的原始用户消息和已审阅决定记录；旧摘要不能反向覆盖明确决定。
- Git 与交付：当前 HEAD、实时远端 ref、PR、Tag、Release API；未刷新的 remote-tracking ref 不得冒充远端现状。
- Capital Agent Task：Server canonical projection；STATE 是游标，不是 Server Gate。
- CI、部署和运行态：对应 Provider、API 或目标系统的当前观察；历史成功或失败只能说明当时状态。
- 测试证据：绑定相同源码树或 Commit、命令、环境和 Gate 版本的证据可复用；任一绑定变化才重跑，不能因会话变化机械重复全量测试。

不同领域没有一个可互相替代的总优先级。GitHub Release 不能替代用户授权，用户口头“应该发布了”也不能替代 Release API。

## 何时必须刷新

满足任一条件，先刷新相关权威来源，再给状态结论或执行动作：

- 新会话、可见上下文恢复、handoff 或长时间停顿后继续；
- 用户问“现在怎样、完成了吗、发布了吗、CI 绿了吗”；
- 另一个会话、人员、自动化或外部系统可能已改变状态；
- 即将提交、Push、合并、迁移、启停 CI/CD、部署、回滚、打 Tag 或发布；
- 当前证据与聊天摘要、STATE、报告或用户决定互相冲突。

无法访问权威来源时，结论必须是 `unknown/unverified`，并说明缺哪一项；不能沿用旧摘要填空。

## 用户决定冲突

把当前范围内的明确允许、禁止和边界写进 `task-context.md` 的 `Current truth and decisions`，外部动作还要同步到 STATE Decisions log：

- 后续会话遇到相反动作时，先展示原决定、当前请求、重叠范围和影响。
- 明确禁止（如“CI/CD 保持关闭”）在同一范围内保持有效，直到出现可定位的更新决定；不能靠较新的模型总结、默认值或操作便利推翻。
- `conflicts: unresolved:<摘要>` 时，受影响外部动作失败关闭；只读调查和不受影响工作可继续。
- 已由原始用户消息或可信系统事实解决后写 `conflicts: resolved:<摘要>`；没有冲突写 `none`。

## task-context 记录

存在远端写入、部署、迁移、发布或其它非本地外部动作时，必须包含：

```markdown
## Current truth and decisions
- observed-at: <ISO-8601>
- sources: <本轮实际检查的 Git / Server / Provider / 用户决定来源>
- user-decisions: <当前范围内仍有效的允许、禁止与边界>
- external-state: <已观察状态；未知项明确写 unknown>
- conflicts: none | resolved:<摘要> | unresolved:<摘要>
- invalidates-on: <哪些变化要求重新检查>
```

Context Guard 只验证记录完整性和未决冲突，不能认证聊天内容或外部 API；主 Agent 仍须真实读取来源。状态变化后刷新本段及语义检查点。

## 防止重复劳动

先比较源码树或 Commit、测试命令、环境和 Gate 版本：全部相同且证据仍可重验时直接引用；不同或无法证明相同时才运行受影响的最小测试，再按风险扩大。不要为了“换了会话”重复完整发布门禁，也不要把同树证据复用成不同平台的 PASS。
