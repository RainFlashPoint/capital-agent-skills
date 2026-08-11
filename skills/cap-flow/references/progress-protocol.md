# 可见进度协议

任何阶段都必须让用户知道“现在在哪里、正在做什么、完成标准是什么、随后去哪”。这不是可选文案，而是研发执行契约。

## 客户端握手（所有阶段之前）

先运行 package 根的 `scripts/cap-status.mjs <target-repo> --json`。结合 `create_or_attach_task` 的真实结果，第一条状态必须包含：平台连接、仓库、分支、Task ID、当前阶段、下一动作。MCP/身份/平台失败时不得静默降级；明确说明本次仅本地执行、缺失的能力和修复命令。

直接 HTTP 探测不是平台连通性的最终判据。`handshake.reason=direct_probe_unavailable` 只表示当前执行进程无法完成直连探测，必须继续用 Capital Agent MCP 确认；此时禁止向用户报告 `network_error`、平台断网或连接失败。MCP 成功后最终快报必须覆盖直接探测结果并显示“平台已连接”；只有两条通道都失败才进入本地降级。

同时读取 `platform.outbox`。有待同步事件时必须展示：总数、可重放数、阻塞数和下一事件类型。属于当前 Task 的事件按 `scripts/cap-outbox.mjs replay-plan` 补报；历史 Task/旧 Session 事件必须先显示“等待历史元数据补报授权”，说明发送目的地与元数据类型，不能静默发送，也不能阻塞当前新需求。某条失败时记录 attempt/lastError，不得跳过依赖链，也不得把“已写入 Outbox”表述为“平台已完成”。

权限与风险拒绝必须使用真实错误归因。`create_or_attach_task` 因 `rejected due to unacceptable risk` 或敏感元数据策略被拒时属于特殊的可恢复入口：用 `scripts/cap-task-request.mjs` 将具体商户、公司、账号和凭据值替换为“仅本地配置”，保留业务意图与验证命令，串行重试一次；成功后继续，第二次失败则 `task_creation_blocked`，禁止降级后编码。其它 `approval required`、`not authorized` 或外部动作风险拒绝仍报告“需要用户授权该数据发送/外部动作”，不得猜测成工具超时、宿主卡顿或网络异常。多个外部写操作必须串行；首条被拒后立即停止同批无关调用。

`cap-status.mode=boundary_blocked` 是高于阶段路由的硬门禁。STATE 的 branch/worktree 与当前 Git 边界不一致时，不读取旧 Task 推断下一动作、不补报旧 Delivery、不进入任何研发阶段；先用 `scripts/cap-task-state-switch.mjs` 原子移动旧活动态到 `.cap/local-state/stale/<old-task>/...`，再为已经创建成功的新 Task 初始化 STATE。同一分支上显式开始新 Task 时，切换调用还必须传 STATE 中的精确旧 Task ID，禁止无条件覆盖。移动或初始化任一步失败必须回滚并保持阻断，业务源码、暂存区和现有 Commit 不得被修改。

下一动作不是提示语。若 `status=in-progress` 且没有人工门禁，当前会话必须立即路由并执行该动作；只有 `gated/blocked`、不可逆操作或用户明确要求暂停时才能停下。Artifact 登记和 STATE 更新只是证据，不构成阶段完成。

精确 Commit 尚未推送是一个独立、可解释的人工门禁，不得混成“执行前检查未通过”：提示必须包含远程名、分支和短 Commit，并只询问一次是否允许推送。用户同意后，该授权在当前 Task 的同仓库、同分支、同 Commit 范围内连续覆盖 Push、Delivery 元数据回写和 Test/Review Action 创建；任一身份边界变化即重新授权。Push 成功后必须自动续跑，不让用户再次输入“继续”。

Server/MCP 返回预检失败时，优先展示结构化 `reason/preflight.code/detail/remediation`。至少区分 `source_commit_not_remote`、`repo_auth_failed`、`repo_branch_missing`、`provider_not_healthy/provider_at_capacity`、`verification_commands_missing`；不得统一翻译成“环境问题”或“执行失败”。

平台可用时，客户端只消费 Server 的 canonical projection：`currentCommit/currentGate/currentAction/blocker/nextAction`。平台状态与本地 STATE 冲突时，必须输出 `server_canonical_state_overrides_local_state` 并修正本地游标；Session finished、本地 PASS 或 Execution success 都不能越权把 Task 判定为 done。健康接口同时展示 `build.commit/schemaRevision/taskStoreMode`，无法证明运行版本时不得声称新逻辑已部署。

“准备执行”“接下来调用”或一份执行计划不算执行证据。外部操作预检通过后，必须在当前会话真实调用可用工具并取得可观察结果，再以脱敏的命令/请求标识、状态码、终态或错误归因更新验证产物与 STATE；工具不可用或调用失败则据实标为 `ENV_BLOCKED` / `INCONCLUSIVE`，不得停在口头承诺或伪报完成。

## 阶段进入

开始实质工作前先发一条简短状态：

```text
当前：<对外阶段名>
正在做：<本阶段马上执行的 1-3 件事>
完成条件：<本阶段出口证据或门禁>
下一步：<通过后进入的对外阶段名>
```

不得只说“开始处理”“继续执行”，也不得只报告内部 ID。

## 执行中

完成一个有意义的证据批次后更新一次：

```text
已完成：<已获得的事实或产物>
正在做：<当前动作>
随后：<紧接着的动作>
```

以下情况必须更新：

- 连续工具执行接近 60 秒；
- 从代码调查转入写规格、编码、测试或评审；
- 发现范围变化、画像漂移、环境阻塞或需要用户决策；
- 长测试、构建或远程执行开始与结束。

不要逐文件播报，也不要用空泛进度百分比。更新必须包含可核验事实。

## 阶段交接

阶段结束时明确报告：

```text
本阶段结果：<PASS / GATED / BLOCKED + 一句话原因>
新增证据：<产物路径、测试结果或关键代码事实>
下一步：<下一阶段将做什么；若不能继续，说明解除条件>
```

同时把相同语义写入 `STATE.md` 的 status、gates 和 next-action。聊天提示与状态文件冲突时，以真实证据修正两者，不能静默跳阶段。

若阶段由 Harness Action 执行，终态还必须同步刷新对应 `.cap/verify/*.md` 或 `.cap/review/*.md`。STATE、阶段报告和聊天必须引用同一个 Action、Commit、Provider 结论与解除条件；禁止报告仍写“等待 Commit/Action 未创建”，而 STATE 已记录 Action 阻塞或成功。
