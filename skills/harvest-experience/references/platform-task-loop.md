# 平台统一 Task 无感闭环

本地研发默认不要求用户打开平台。只要 MCP 暴露对应工具，Skill 必须按以下顺序自动执行；工具不可用时降级为纯本地 `.cap` 流程。

## 开始

1. 读取 `git remote get-url origin`、当前 branch、`git rev-parse HEAD` 和仓库根目录。
2. 调用 `create_or_attach_task`，传需求原文、repo、branch、base commit、leaf、worktree 和稳定幂等键。
3. 把返回的 `task_id`、`session_id`、Skill/知识快照 ID 写入 `.cap/STATE.md` 顶层元数据。
4. 后续 `enrich_context`、`record_skill_event`、`record_experience` 始终复用同一 repo URL 和 session ID。

## 交付

当代码已形成且存在有效 Commit 时，自动收集：

```bash
git rev-parse HEAD
git rev-parse HEAD^
git branch --show-current
git diff-tree --no-commit-id --name-only -r HEAD
```

调用 `record_task_delivery`，同时传本项目实际执行成功的 `verification_commands`；只上传 Commit、文件路径、验证和 Review 结构化结论，不上传代码正文。

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
