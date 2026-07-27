---
name: cap
description: Capital Agent 研发工作的统一入口。用于实现功能、修复问题、测试验证、代码评审和发布交付；系统根据任务复杂度自动选择必要步骤，用户不需要理解或手动调用内部阶段。
---

# Capital Agent 研发入口

完整读取并遵循同级目录 `../cap-flow/SKILL.md`；真实编码会话同时读取 `../harvest-experience/SKILL.md`，自动完成经验注入与沉淀。本技能是研发唯一公开入口，也是唯一安装到客户端列表的 Skill，不复制内部流程规则。

## 用户语言

不要要求用户输入 `cap-define`、`cap-implement`、`cap-test` 等内部技能名。识别下列自然语言并在内部完成路由：

| 用户说法 | 对外名称 | 内部阶段 |
|---|---|---|
| 了解项目、建立项目档案 | 项目了解 | `understand` / `cap-understand` |
| 梳理需求、确认方案、写规格 | 需求确认 | `define` / `cap-define` |
| 拆任务、制定计划 | 开发计划 | `plan` / `cap-plan` |
| 开始开发、实现、修复 | 编码实现 | `implement` / `cap-implement` |
| 测试、验证 | 测试验证 | `test` / `cap-test` |
| 代码评审、Review | 代码评审 | `review` / `cap-review` |
| 发布、上线 | 发布上线 | `release` / `cap-release` |

`/cap 需求`、`/cap 计划`、`/cap 开发`、`/cap 测试`、`/cap 评审`、`/cap 发布` 是可选快捷表达；日常直接 `$cap` 加需求即可。

用户显式调用 `$cap` 后：

1. 先运行 package 根的 `scripts/cap-status.mjs <target-repo> --json`，获得 Git、平台配置、Task 和确定性下一动作。
2. 若 MCP 提供 `create_or_attach_task`，立即创建/复用 Task 并写回 `.cap/STATE.md`；随后重跑 `cap-status.mjs`。若 `cap-status` 返回 `task.requiresNewSession=true`，说明已完成父 Task 存在活动 follow-up：必须把 `task.id` 作为显式 `task_id` 绑定，**不得传旧 session_id**，让平台为 follow-up 创建新 Skills Session；同时按本轮需求重新传 `verification_commands`，不得继承父 Task 的验证命令。若工具缺失或调用失败，必须明确报告 `仅本地执行 + 原因 + 影响 + 修复命令`，禁止静默降级。
   平台暂时不可用时，把原本应调用 MCP 的结构化元数据写入目标仓 `.cap/outbox.jsonl`，使用 package 根 `scripts/cap-outbox.mjs enqueue`。恢复后先读取 `replay-plan`，按依赖顺序调用原 MCP 工具；成功后 `ack`，失败则 `fail` 保留事件。不得把本地 PASS 重放成 Server Gate PASS，也不得上传代码正文。
3. 创建/绑定 Task 后先读取 STATE 中已有的 Harness Action 引用；Test/Review/Patch 使用 `get_task_action / wait_task_action` 续接。编码实现由当前 Skills Session 或受控执行 Provider 完成，结果通过 Artifact、Delivery 和 Commit 回写，不再认领另一套旧 Task Action。
4. 若状态包含 `git_delivery_reconciliation_needed`，立即扫描 `delivery-head..HEAD`；对 IDEA、人工或其它 Agent 产生的 Commit 幂等补调用 `record_task_delivery`。平台没有 Delivery 查询工具时也要重报当前 HEAD，由平台幂等去重，不能依赖原编码会话仍然存在。
5. 用统一“客户端握手快报”告诉用户平台连接、仓库、分支、Task、当前阶段、已认领 Action 和下一步；不得先写规格或代码再补报。
   快报必须同时显示 Outbox 待同步数、可重放数、阻塞数与下一事件类型；存在待同步事件时不得只说“平台已连接”。
6. 调用中心知识层注入与本需求相关的历史经验。
7. 按 `cap-flow` 的 Orient → Route → Handoff 推进当前研发任务。没有人工门禁时，在同一会话立即进入 `cap-status.mjs` 判定的下一动作，禁止只上传 Artifact 或只更新 STATE 就结束。
8. 按阶段使用唯一 Action 协议，禁止双写：
   - 编码实现：由当前 Skills Session 或受控执行 Provider 完成；通过 Artifact + Delivery 回写真实 Commit，不创建阶段 Action，不写 Test/Review PASS。
   - 测试验证：强制 `create_task_action(action_type=test) → wait_task_action/get_task_action`；Server 决定 Gate，客户端不得自行写验证 PASS。
   - 代码评审：强制 `create_task_action(action_type=review) → wait_task_action/get_task_action`；Review 只读，客户端不得自行写 Review PASS。
   - 代码修复：只续接 Server Review 生成的 Harness Patch Action；由受控 Patch Provider 回写新 Commit 与 Patch Evidence，Skills 不自行伪造完成结果。
   Server 返回新 Commit 的 Test/Review Action 时在同一会话继续；统一 Task `done` 后才进入 Delivery 与经验沉淀。
9. 会话结束时沉淀意图与改动文件路径，并维护统一 Task/Skills Session。

进入测试验证或代码评审前同时加载 `../cap-flow/references/harness-action-protocol.md`。验证阶段优先使用 `create_task_action → wait_task_action/get_task_action` 请求独立 Test Provider；STATE 只保存 Action 引用，不能用本地 `PASS` 自证平台 Gate。Review 默认只读；可修 Finding 生成独立 Patch Action，不在同一 Review Run 中修改源码并自签 PASS。

握手成功示例：

```text
Capital Agent 已连接
仓库：financial/gu-bei · dev_huifu
Task：task_xxx（已创建或已复用）
当前：开发计划
下一步：编码实现（本会话立即继续）
```

降级示例：

```text
Capital Agent 当前仅本地执行
原因：capital-agent MCP 未注册
影响：不会创建平台 Task，也不会回写验证证据
修复：运行 setup.mjs --upgrade && setup.mjs --doctor
下一步：仍可继续本地流程
```

开始任何阶段前，加载并执行 `../cap-flow/references/progress-protocol.md` 与 `../cap-flow/references/task-reconnaissance.md`。项目画像只能作为定位索引；每个新任务必须先从当前仓库代码建立 `.cap/task-context.md`。

向用户汇报时使用“需求确认、开发计划、编码实现、测试验证、代码评审、发布上线”等对外名称。只有诊断状态文件或开发 Skills 本身时，才在括号中补充内部 ID。
