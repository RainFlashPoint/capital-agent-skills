# Harness Action 协议

Skills 是 Harness Client，不是可信 Gate 内核。STATE 是游标，不是 Gate 真值；`.cap/STATE.md` 只保存阶段游标、Action 引用和人类可读摘要，不能自行证明 Test、Review 或 Safety 已通过。

当前交付对象由 Server 的 `currentCommit` 决定。普通 Delivery 只登记工程事实，不能改变 current candidate；只有显式 `delivery_candidate=true` 才能提名最终候选。`currentAction.sourceCommit`、Test/Review Evidence 与 Gate 必须始终等于 `currentCommit`，旧 Commit 的 PASS 在新候选出现后立即失效。Session finished ≠ Task finished，local PASS ≠ Server Gate PASS。

## 唯一路由矩阵

| 阶段 | 允许的 Action 协议 | 禁止事项 |
|---|---|---|
| 编码实现 | Skills Session / 受控执行 Provider + Artifact / Delivery | 不创建阶段 Action，不得写 Test/Review Gate |
| 测试验证 | `create_task_action(test) / get / wait / cancel` | 客户端不得自行回写 PASS |
| 代码评审 | `create_task_action(review) / get / wait / cancel` | 客户端不得自行回写 PASS |
| 代码修复 | Server 生成的 Harness Patch Action + 受控 Patch Provider | Skills 不认领普通旧 patch，不自行写 Patch Evidence |

同一阶段只能使用一套协议。Test/Review/Patch 统一使用 Harness Action；编码实现通过 Session、Artifact、Delivery 和真实 Commit 交接，不再存在另一套可认领、可完成的 Task Action。

## Test Action

当本轮已有精确 Commit 且 MCP 暴露 `create_task_action` 时，测试验证阶段必须：

1. 先确认精确 Commit 已在 Task 指定远程分支可见。若 `cap-status.reconciliation.pushRequired=true`，先进入 Push 门禁；得到当前 Task 范围授权后执行 Push 和当前 Delivery 补报，再用 `task_id + commit_sha + required_checks` 创建 `action_type=test`。默认由 Server Test Provider 异步执行。

Push 授权必须绑定 `repo + task + branch + commit` 的 fingerprint；计算前先移除 remote URL 中的账号/Token，任一身份变化授权立即失效并重新询问。候选 Delivery 只能在本次授权下实时发送，发送失败不得写入自动重放 Outbox；历史 Outbox 不继承当前 Task 的 Push/发送授权，也不能抢占当前候选的 Test → Review 主线。
2. 把返回的 `action_id/run_id` 写入 STATE 的 `Harness actions`，状态记为 `ready/running`，不得提前勾选质量 Gate。
3. Action 进入 `ready` 后，若目标仓本机存在已注册的 Capital Agent Runner，立即执行 package 根 `scripts/cap-local-test-provider.mjs <target-repo> <action-id>` 唤醒一次本地独立 Test Provider。必须传本次 Action ID，Provider 只能领取这一条，不能领取同仓库其他工作。该 Provider 继承研发机的 Maven/npm/SDK 配置，在隔离 worktree 验证精确 Commit；它只领取 Harness Action，不得顺带领取编码任务。未安装、未授权当前仓库或认证失败时，明确报告 `local_provider_unavailable`，不得回退到 Server 猜测本地依赖环境。
4. 用 `wait_task_action` 做有界等待；超时后保存当前状态并允许新会话用 `get_task_action` 续接，禁止无限轮询。
5. 只有 Action 返回 `status=succeeded` 且 machine validation 绑定同一 Commit，才把“独立验证已通过”写进交接。`blocked/needs_human` 按 Server 原因回到实现或人工处理。
6. 本地命令和 `.cap/verify/*` 是 Provider 输入与诊断资产，不是高风险任务的最终通行证。低风险兼容是否可放行也由 Server Gate Policy 决定，Skills 不自行判断。
7. Test Action 成功后，Server 应为同一 Commit 幂等创建只读 Review Action；客户端从 Test 结果中的 `reviewActionId` 或 Task Action 列表继续等待。没有人工门禁时不得停下来要求用户再次触发评审。

### Action 终态的本地证据同步

`get_task_action` 或 `wait_task_action` 返回终态后，主线必须在同一轮同步刷新 `.cap/STATE.md` 和当前阶段报告（Test 为 `.cap/verify/*.md`，Review 为 `.cap/review/*.md`）。两处至少记录：Action ID、源 Commit、Provider 终态、Server Gate 结论、机器分类和解除条件。

- 必须替换报告中已经失效的文字，例如“Action 未创建”“等待 Commit/Push”；不得只在 STATE 末尾追加新 Action。
- Commit 已形成、已推送、Action 已创建等机械事实应在 STATE 中勾选；独立 Test/Review Gate 只有 Server 返回可信成功时才能勾选。
- `blocked/needs_human` 且分类为 `ENV_BLOCKED` 时，报告写环境阻塞和解除条件，绝不能改写为代码失败或 PASS。
- 终态同步属于同一 Task 的本地证据校正，不要求为了更新报告再产生一个业务代码 Commit；如平台支持 Artifact，只登记路径和摘要，不上传代码正文。
- 聊天、STATE 和阶段报告发生冲突时，立即按 Server 终态修正三者后再决定下一动作。

Action API 不可用时，明确报告“仅完成本地验证，缺少独立 Provider Gate”；不得把本地 `PASS` 改写成平台已验证。

## Review 与 Patch Action

Review 执行者默认只读源码，只产 Findings、Review Evidence 和结论。它不得在同一个 Review Run 中修改被审代码并给自己的修改签发 PASS。

当已有精确 Commit 且 MCP 暴露 `create_task_action` 时，Review 阶段先创建 `action_type=review`，默认 scopes 为 `code_review + security_review`，再通过 `wait_task_action/get_task_action` 读取 Server 结论。缺少 Review 或 Security Artifact、结论不确定、Commit 不一致时都不得由 Skills 自行补写 PASS。

- 无 Finding：只有 Review Action 返回 `succeeded` 且绑定同一 Commit，才记录独立 Review 已通过。
- 有可修 Finding：Server Review Action 返回 `blocked` 并生成独立 Patch Action；Skills 只保存 Action 引用，不在 Review Run 里直接修改源码。
- 需要业务或安全裁决：进入 `needs_human`，不得用 Patch Action 替用户接受风险。
- Patch 完成产生新 Commit 后，旧 Test/Review Evidence 自动过期，必须为新 Commit 创建新的 Test/Review Run。

Patch Action 只允许声明 `patch` 能力、匹配仓库范围且持有有效租约的受控写 Provider 认领。执行器必须从 Action 冻结的 `source.commitSha` 开始，只处理 `findingRefs` 与 `constraints` 声明的范围；完成时回写：

- `parentHead`：必须等于 Action 冻结的源 Commit；
- `newHead`：必须是不同的新精确 Commit，不能只报工作区已修改；
- `changedFiles`：只传路径；
- `resolvedFindingRefs`：必须覆盖全部冻结 Finding；
- `artifactRefs`：可审计的 Patch receipt/交接资产引用。

Server 验证 Patch Evidence 后才结束 Patch Action。成功只代表“新 Commit 已产生”，不代表交付通过；Server 随即为新 Commit 建立新的 Test/Review Action，STATE 更新 Action 引用后继续等待，不得复用父 Commit 的 PASS。父 Commit 不一致、没有新 Commit、缺少改动路径或 Finding 未覆盖时一律阻断。

## STATE 边界

STATE 可记录：`action-id/type/status/source-commit/run-id/next-poll` 以及从 Server 终态提炼的分类、解除条件和人类可读摘要。STATE 不得自行生成权威事实：`server-validated=true`、最终 Gate PASS、Provider 原始输出正文。权威结果始终通过 `get_task_action` 从 Server 读取；STATE 与阶段报告只是该结果的可审计本地镜像。

## Delivery 与经验回写

Action 协议只负责阶段执行和 Gate。真实 Commit 仍通过统一 Task Delivery 回写；阶段产物仍通过 Task Artifact 元数据回写；经验仍通过 `record_experience(task_id + commit_sha)` 沉淀。三者不得被旧 Action completion 替代，也不得重复上传代码正文。
