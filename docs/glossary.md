# Capital Agent 常用术语对照表

代码字段、API 参数和状态 ID 保留英文；页面、流程说明和人工提示优先使用中文。英文术语第一次出现时可写成“中文（English）”。

| 英文 | 页面建议显示 | 含义 |
|---|---|---|
| Task | 研发任务 | 一次完整的需求、修复或验证工作 |
| Session | 工作会话 | Agent 或人处理某个任务的一段工作过程 |
| Stage | 研发阶段 | 需求确认、开发、测试、评审等流程位置 |
| Action | 执行步骤 | 针对一个 Commit 发起的测试、评审或修复动作 |
| Delivery | 代码交付 | 把 Commit 和改动证据登记到任务 |
| Candidate | 候选版本 | 准备接受正式测试和评审的 Commit |
| Gate | 质量门禁 | 决定是否可以进入下一阶段的条件 |
| Evidence | 验证证据 | 证明代码、测试或评审结果真实发生的材料 |
| Provider | 执行服务 | 实际运行测试、评审或修复的服务 |
| Runner | 执行节点 | 承担具体命令执行的机器或进程 |
| Outbox | 待同步队列 | Server 暂时不可用时保存在本地、等待补报的数据 |
| Canonical state | 权威状态 | 当前真正有资格决定任务状态的事实 |
| Projection | 状态投影 | 根据事实整理给某个使用者看的状态视图 |
| Fallback | 降级模式 | 中心服务不可用时允许继续工作的受控模式 |
| Commit | 代码提交 | Git 中记录的一次完整变更 |
| Branch | 分支 | 一条独立的代码开发线路 |
| Review | 代码评审 | 检查改动是否符合要求和质量标准 |
| Verification / Test | 测试验证 | 通过命令、环境或业务场景确认结果 |
| Artifact | 研发产物 | 需求、方案、测试报告、评审报告等文件 |
| Harness | 项目执行框架 | 让 Agent 能理解项目规则、执行流程并留下证据的一组文件和工具 |
| Snapshot | 知识快照 | 某个任务开始时冻结的一组知识版本 |
| Ledger | 账本 | 记录注入、采用或同步等过程数据 |
| Idempotency | 幂等 | 同一个请求重复执行不会产生重复结果 |
| Lease | 执行租约 | 某个执行节点在限定时间内占用一个执行步骤的许可 |
| Reconciliation | 对账 | 比较本地 Commit、Server 记录和交付证据是否一致 |

## 最容易混淆的四组词

- **Task / Session**：Task 是要完成的事情，Session 是处理它的一段会话。
- **Delivery / Candidate**：Delivery 可以是普通提交登记，Candidate 是准备进入正式验证的版本。
- **Action / Provider**：Action 是要执行的步骤，Provider 是执行这个步骤的服务或节点。
- **Local state / Canonical state**：Local state 表示本地下一步怎么做，Canonical state 表示平台认可到哪一步。

