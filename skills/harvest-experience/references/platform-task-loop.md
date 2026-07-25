# 平台统一 Task 无感闭环

本地研发默认不要求用户打开平台。只要 MCP 暴露对应工具，Skill 必须按以下顺序自动执行；工具不可用时降级为纯本地 `.cap` 流程。

## 开始

1. 读取 `git remote get-url origin`、当前 branch、`git rev-parse HEAD`、upstream HEAD 和仓库根目录。
2. 运行 `cap-status.mjs <repo> --json` 对账当前本地 HEAD、upstream/远端跟踪 HEAD 与 STATE 的 `delivery-head`，再通过 MCP 确认平台最近 Delivery。若本地或远端存在未登记 Commit（包括 IDEA、人工或其它 Agent 提交），按提交顺序收集 Commit SHA 与改动路径并补调用 `record_task_delivery`；不得要求原 Codex 会话仍然存活。平台没有 Delivery 查询工具时，幂等重报当前 HEAD，由服务端去重。
3. 调用 `create_or_attach_task`，传需求原文、repo、branch、base commit、leaf、worktree 和稳定幂等键。
4. 把返回的 `task_id`、`session_id`、Skill/知识快照 ID 写入 `.cap/STATE.md` 顶层元数据。
5. 后续 `enrich_context`、`record_skill_event`、`record_experience` 始终复用同一 repo URL 和 session ID。

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

## 交付

### Task、Commit 与延期验收

- Task 表示一项可独立验收的研发结果，不等于单个 Commit，也不应承载无法收敛的长期大计划。
- 同一 Task 可以累积多次 Commit/Delivery；每次入口按 `delivery-head..HEAD` 补登记人工、IDE 或其它 Agent 的提交。
- 新 Commit 只增加 Delivery 并重新校验最新提交，不创建新 Task。
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

先补登记尚未上报的 Artifact 元数据，再调用 `record_task_delivery`，同时传本项目实际执行成功的 `verification_commands`。验证对象至少包含：

- `passed` 与 `status`；
- `outcome`: `PASS | CODE_FAILED | ENV_BLOCKED | INCONCLUSIVE`；
- `executed_at`: 本轮命令结束的 UTC 时间；
- `environment_fingerprint`: 只包含运行时版本与依赖锁摘要，例如 `os=darwin;node=22;jdk=8;lock=sha256:...`，不含用户名、绝对路径、Host、Token；
- `commands`: 实际执行命令及 exit code；
- `quality_asset_ids`: 若命中平台质量资产则传对应 ID。

只上传 Commit、文件路径、验证和 Review 结构化结论，不上传代码正文。平台只把与当前 Commit 匹配的证据用于 Gate；旧 Commit 的通过证据不得替新提交放行。
`record_task_delivery` 成功后把该 Commit 写入 STATE 的 `delivery-head`；下次入口发现 HEAD/upstream 与之不同时必须补对账。平台查询能力可用时，以平台最近 Delivery 为准并修正本地缓存；STATE 不是最终真值。

IDE、人工或其它 Agent 直接 Commit 时，由项目 `post-commit` Hook 调用同一幂等 Delivery 协议。Hook 不阻塞 Commit；网络失败写入 `.cap/pending-deliveries.jsonl`，下次 `$cap` / `cap-status` 自动重试。知识快照存在时，最终验证回写还应携带 `knowledge_outcome`（直接采用、修改采用、未采用、拒绝）及可选原因，平台据此计算真实采纳与误导率。

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
