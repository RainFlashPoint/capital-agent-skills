# 平台统一 Task 无感闭环

本地研发默认不要求用户打开平台。只要 MCP 暴露对应工具，Skill 必须按以下顺序自动执行；工具不可用时降级为纯本地 `.cap` 流程。

## 开始

1. 读取 `git remote get-url origin`、当前 branch、`git rev-parse HEAD` 和仓库根目录。
2. 调用 `create_or_attach_task`，传需求原文、repo、branch、base commit、leaf、worktree 和稳定幂等键。
3. 把返回的 `task_id`、`session_id`、Skill/知识快照 ID 写入 `.cap/STATE.md` 顶层元数据。
4. 后续 `enrich_context`、`record_skill_event`、`record_experience` 始终复用同一 repo URL 和 session ID。

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
