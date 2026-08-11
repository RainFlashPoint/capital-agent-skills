# 平台统一 Task 无感闭环

本地研发默认不要求用户打开平台。只要 MCP 暴露对应工具，Skill 必须按以下顺序自动执行；工具不可用时降级为纯本地 `.cap` 流程。

## 离线 Outbox

平台或 MCP 暂时不可用时，研发本身继续，但所有待回写事件统一写入 `.cap/outbox.jsonl`，不再为 Artifact、Action、Experience 各造一套临时文件。允许类型为 `task.attach`、`artifact.record`、`delivery.record`、`action.create:test`、`action.create:review`、`experience.record`、`skill.event`。

每条事件必须带稳定 `idempotencyKey`、`type`、可选 `localTaskRef`、`dependsOn`、结构化 `payload`、时间与重试信息。离线创建 Task 时先生成 `localTaskRef`；后续事件依赖 `task.attach`，重放得到真实 `task_id/session_id` 后再注入后续 MCP 参数。只传路径、hash、Commit 和结构化结论，禁止保存代码正文、密钥和完整外部身份数据。

恢复后运行 `scripts/cap-outbox.mjs replay-plan <repo>`。当前 Task 在本轮明确授权范围内的事件，严格按依赖顺序调用原 MCP Tool；成功后执行 `ack`，失败执行 `fail` 并停止依赖它的后续事件。不得并行发起多个写操作，否则首个权限拒绝时其它请求仍可能已经发送。

历史 Task、旧 Session 或之前会话形成的事件属于独立的数据发送动作。重放前必须告诉用户：目标服务、事件数量，以及将发送仓库相对路径、branch、Commit SHA、Task/Session ID 等结构化元数据；获得明确授权后才可逐条发送。未授权时不删除、不重试、不绕过审查，保留事件并继续当前任务。宿主返回 `rejected due to unacceptable risk`、`approval required` 或同类权限拒绝时，应原样归因为“缺少历史补报授权”，立即停止该批重放并向用户请求授权，禁止解释成超时或普通中断。

重复进入 `$cap` 必须安全重试，同一幂等键不得产生重复 Task、Artifact、Delivery、Action 或经验。旧 `.cap/pending-deliveries.jsonl` 会在下一次 `cap-status` 自动迁入 Outbox，新 post-commit 失败直接写 Outbox。

历史 Outbox 永不继承新会话的授权。普通 Delivery 可按幂等协议自动重放；候选 Delivery 不进入自动重放 Outbox，发送失败后必须按当前 Task、repo、branch、Commit 重新取得授权并实时发送。

## 开始

1. 读取 `git remote get-url origin`、当前 branch、`git rev-parse HEAD`、upstream HEAD 和仓库根目录。
2. 运行 `cap-status.mjs <repo> --json` 对账当前本地 HEAD、upstream/远端跟踪 HEAD 与 STATE 的 `delivery-head`，再通过 MCP 确认平台最近 Delivery。若本地或远端存在未登记 Commit（包括 IDEA、人工或其它 Agent 提交），按提交顺序收集 Commit SHA 与改动路径并补调用 `record_task_delivery`；不得要求原 Codex 会话仍然存活。平台没有 Delivery 查询工具时，幂等重报当前 HEAD，由服务端去重。
3. 若 `cap-status.task.requiresNewSession=true`，说明 STATE 指向的父 Task 已完成、平台已给出活动 follow-up Task：调用 `create_or_attach_task` 时显式传 `task_id=cap-status.task.id`，省略旧 `session_id`，并用本轮意图生成新的稳定幂等键。否则按常规创建/复用 Task。两种情况都传需求原文、repo、branch、base commit、leaf、worktree。
4. follow-up 必须重新计算并传入本轮 `verification_commands`；禁止照搬父 Task 的接口、测试或发布命令。平台返回新 Session 后，旧 session-id 仅作历史记录，不得继续写事件。
5. 把返回的 `task_id`、`session_id`、Skill/知识快照 ID 写入 `.cap/STATE.md` 顶层元数据，覆盖父 Task/Session 指针。
6. 后续 `enrich_context`、`record_skill_event`、`record_experience` 始终复用同一 repo URL 和新 session ID。

## 平台 Action 接力

Test/Review/Patch 的 Harness 契约见 `../../cap-flow/references/harness-action-protocol.md`。测试与评审只走
`create_task_action/get_task_action/wait_task_action/cancel_task_action`：它绑定精确 Commit、独立 Provider Run
和 Server Gate，STATE 只缓存引用。Review 生成的 Patch Action 由受控 Provider 消费。

编码实现不创建或认领 Task Action。当前 Skills Session 或受控执行 Provider 完成代码后，依次回写阶段 Artifact、
真实 Commit Delivery 和经验。普通开发 Delivery 只累积工程证据；仅当实现收敛并准备进入测试验证时，客户端把同一
Commit 作为 `delivery_candidate=true` 再次幂等回写，Server 才基于该候选创建 Test/Review Harness Action。这样
Task、Session、Action、Delivery 各自只有一种职责，不再存在两套 Review/Test 队列。

Server 的 canonical projection 是状态单一事实源：Task 只由当前候选 Commit 的必需 Gate 收口；Session 结束、Execution 成功和客户端本地 PASS 均不能直接完成 Task。客户端读取 `currentCommit/currentGate/currentAction/blocker/nextAction`，并按结构化 `code/detail/remediation` 展示不同修复动作，不得自行 reverse/find 历史 Action 猜“当前状态”。

## Artifact 元数据

每次阶段 HANDOFF 后，若 MCP 提供 `record_task_artifact`，登记本阶段实际存在且有变化的产物：

| 路径 | kind |
|---|---|
| `.cap/PROFILE.md` | `profile` |
| `.cap/spec.md` | `spec` |
| `.cap/plan.md` | `plan` |
| `.cap/STATE.md` | `state` |
| `.cap/verify/*` | `verify` |
| `.cap/review/*` | `review` |
| `.cap/release/*` | `release` |

只传 `task_id`、`kind`、仓库相对 `path`、文件 SHA-256 `hash`、当前 `git_ref`、`stage`、`status` 和一句 `summary`。禁止上传正文、本机绝对路径、平台地址或凭据。同一路径同一 hash 不重复上报；工具不存在、无 task-id 或调用失败时静默降级。

Task 严格退场生成 `.cap/history/<task-id>/manifest.json` 后，再登记一条历史 Artifact 元数据：
`lifecycle=history`、`artifact_root=.cap/history/<task-id>`、`parent_task_id`、`snapshot_hash`、`completed_at`。
历史 Artifact 只登记路径、快照哈希与谱系，不上传 manifest 或 Markdown 正文。活动阶段继续省略这些字段，Server
按 `lifecycle=active` 兼容处理。平台不可用时写入 `artifact.record` Outbox，不能把本地快照误报成平台已登记。

## 交付

### Task、Commit 与延期验收

- Task 表示一项可独立验收的研发结果，不等于单个 Commit，也不应承载无法收敛的长期大计划。
- 同一 Task 可以累积多次 Commit/Delivery；每次入口按 `delivery-head..HEAD` 补登记人工、IDE 或其它 Agent 的提交。
- 新 Commit 只增加 Delivery 并重新校验最新提交，不创建新 Task，也不自动创建 Test Action。
- 核心验收通过、剩余项仅受外部时间或样本约束且可独立验收时，调用 `split_deferred_acceptance`：为每个延期项创建
  关联 follow-up Task，原 Task 在 Commit/Review/Quality/Safety 门通过后完成。
- 代码失败、安全问题、数据一致性风险或核心行为未通过不得延期，必须保持当前 Task gated/blocked。

调用 `split_deferred_acceptance` 时传 `task_id`、当前 `commit_sha`/branch、结构化延期项，以及当前核心范围的
verification/review PASS。成功后将返回的 follow-up Task ID 写入 STATE；失败时保留延期项并明确报告平台未拆分。

代码交付与环境验证是两道独立门：

- `CODE_DELIVERED`：本地可执行验证已完成且 Commit 已形成，可推送开发/测试分支供部署联调。
- `ENV_PENDING` / `ENV_BLOCKED`：外部环境验证尚未完成或环境受阻；不阻止开发/测试分支推送，但阻止生产晋级和 Task 完成。
- `ENV_VERIFIED`：权威环境验证完成。只有 verify、review 与所需环境门都通过后，Task 才可完成或进入生产发布。

当代码已形成且存在有效 Commit 时，自动收集：

```bash
git rev-parse HEAD
git rev-parse HEAD^
git branch --show-current
git diff-tree --no-commit-id --name-only -r HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

先补登记尚未上报的 Artifact 元数据，再调用 `record_task_delivery`，同时传本项目实际执行成功的 `verification_commands`。普通开发提交和历史对账不传 `delivery_candidate`（或传 `false`）；只有编码实现完成、当前精确 Commit 已推送且确定进入测试验证时才传 `delivery_candidate=true`。验证对象至少包含：

- `passed` 与 `status`；
- `outcome`: `PASS | CODE_FAILED | ENV_BLOCKED | INCONCLUSIVE`；
- `executed_at`: 本轮命令结束的 UTC 时间；
- `environment_fingerprint`: 只包含运行时版本与依赖锁摘要，例如 `os=darwin;node=22;jdk=8;lock=sha256:...`，不含用户名、绝对路径、Host、Token；
- `commands`: 实际执行命令及 exit code；
- `quality_asset_ids`: 若命中平台质量资产则传对应 ID。

只上传 Commit、文件路径、验证和 Review 结构化结论，不上传代码正文。平台只把与当前 Commit 匹配的证据用于 Gate；旧 Commit 的通过证据不得替新提交放行。
`record_task_delivery` 成功后把该 Commit 写入 STATE 的 `delivery-head`；下次入口发现 HEAD/upstream 与之不同时必须补对账。平台查询能力可用时，以平台最近 Delivery 为准并修正本地缓存；STATE 不是最终真值。

IDE、人工或其它 Agent 直接 Commit 时，由项目 `post-commit` Hook 调用同一幂等 Delivery 协议，但 Hook 永远只登记普通 Delivery，不得自行设置 `delivery_candidate=true`。网络失败写入 `.cap/outbox.jsonl` 的 `delivery.record`，下次 `$cap` / `cap-status` 自动重试；历史 `.cap/pending-deliveries.jsonl` 自动迁移，不再产生新记录。知识快照存在时，最终验证回写还应携带 `knowledge_outcome`（直接采用、修改采用、未采用、拒绝）及可选原因，平台据此计算真实采纳与误导率。

经验沉淀必须携带 `task_id + commit_sha`。权威 PASS 来自 Server 对同一 Task、同一 Commit 的 Gate 校验；Task 一旦达到 `done`，Server 同步把关联的活动 Skills Session 收口到 `done/finished`。本地 STATE 若仍停在测试或评审阶段，`cap-status` 以平台 Task 为权威提示退场，不再让用户误以为流程卡住。

只有同时满足以下条件才调用 `request_docker_verification`：

- 工作区干净；
- HEAD 已存在于远端分支；
- Task 已有精确 base Commit、隔离分支和验证命令；
- 本地 verify/review 没有阻断；
- 平台项目自治门禁允许。

门禁拒绝不是会话失败，记录原因并继续以本地交付为准。

## Git 资产边界

建议提交：`.cap/PROFILE.md`、最终 spec、decision、plan、verification/review 摘要。

禁止提交：`.cap/runtime/`、`.cap/logs/`、`.cap/cache/`、`.cap/tmp/`、密钥、模型原始思考和本机绝对路径。
