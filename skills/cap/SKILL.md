---
name: cap
description: Capital Agent 研发工作的统一入口。用于实现功能、修复问题、测试验证、代码评审和发布交付；系统根据任务复杂度自动选择必要步骤，用户不需要理解或手动调用内部阶段。
---

# Capital Agent 轻量研发入口

这是研发唯一公开入口。目标是先用少量上下文完成确定性分流，再按风险加载必要协议；轻量不代表跳过门禁。

## 1. 启动：先取 compact 状态

真实研发任务开始前，先确认当前宿主是否暴露 Capital Agent MCP，再从用户当前打开的仓库运行：

```text
node scripts/cap-status.mjs <repo> --compact --mcp-runtime <loaded|missing|unknown>
```

`--compact` 返回选择下一动作所需的 Git、安装、平台、Task、Action、Outbox、边界、纠偏和工作流字段。`outputMode=compact` 时按本文件路由；`outputMode=full-fallback` 表示发现阻断、纠偏、未知 blocker 或异常同步状态，结果已自动保留完整证据，必须加载并遵循 `../cap-flow/SKILL.md`，不得自行裁剪。

第一次状态检查把 canonical Git root 锁定为本会话唯一可写主仓。`.cap`、历史文档、另一个 clone/worktree 中的绝对路径只能校验，不能反向选择仓库。

安装状态优先处理：`installation.upgradeRecommended=true` 时先升级本地 Skills 并重跑状态；`bootstrapRecommended=true` 时初始化安装清单。升级完成但当前会话已加载旧 Skill 时，提示新任务验证，不把内存中的旧说明冒充新版本。

## 2. 不可跳过的本地门禁

所有阶段都先读当前仓的 `.cap/STATE.md`、`.cap/task-context.md` 和存在的 plan/verify/review 证据，核对 branch、HEAD、工作树、Task 与未完成门禁。新任务或事实变化时，按以下文件执行：

- `../cap-flow/references/task-reconnaissance.md`：代码与历史侦察、task-context 新鲜度；
- `../cap-flow/references/progress-protocol.md`：状态与阶段推进；
- `../cap-flow/references/complexity-routing.md`：L1–L4 分类；
- 当前阶段 Skill：`../cap-understand`、`../cap-define`、`../cap-plan`、`../cap-implement`、`../cap-test`、`../cap-review` 或 `../cap-release`。

用户语言与内部阶段：项目了解=`understand`，需求确认=`define`，开发计划=`plan`，编码实现=`implement`，测试验证=`test`，代码评审=`review`，发布上线=`release`。不要要求用户记内部名。

L1/L2 且无风险触发时，只加载上述必要 reference 与当前阶段 Skill。L3/L4，或涉及安全、权限、支付、数据库迁移、外部副作用、MCP/发布、跨项目、复杂并发、回滚困难时，加载完整 `../cap-flow/SKILL.md`。分类未知时一律升级到完整协议；不得为了省 Token 猜测低风险。

任务跨越多个依赖阶段时维护 `.cap/spec.md`、`.cap/plan.md` 和 `.cap/STATE.md`；每次进入 plan/implement/test/review/release 前运行 task-context 门禁。工作区出现任务前脏文件时先确认归属，禁止覆盖用户改动。

## 3. 状态分流

- `mode=session_root_blocked`：停止读取错误仓并回到锁定仓；跨项目按 `cross-project-handoff.md` 审阅 handoff 后运行 `cap-session-root.mjs switch`，同项目 worktree 使用新会话。
- `mode=boundary_blocked`：停止需求、计划、编码和测试；只用 `scripts/cap-task-state-switch.mjs` 保存旧活动态并建立本次 Task，然后重跑状态。
- `mode=restart_required`：团队配置存在但会话无 MCP。可选启动只保证能聊天；每个新研发任务仍检查 MCP 并尝试团队握手。让用户选择重启，或明确“本次本地继续”后以 `--allow-local-once` 重跑；禁止静默降级。
- `mode=local_explicit` / `mode=local_fallback_explicit`：只做本地证据，不写平台 Task/Experience/Delivery/Gate/Outbox，只能称本地 PASS。后者绑定运行会话 + 分支 + Task，新会话或 MCP 加载后失效。
- 平台已连接或待 MCP 确认：以 Server canonical Task 为权威；直接 HTTP 探测失败但 MCP 已加载时继续用 MCP 确认，不能直接宣称平台断网。

仅在平台已由 MCP 确认可用的团队模式中，`mode=platform_ready` 或 `task.id` 为空时，才必须先调用 `create_or_attach_task`，把 Task/Session 写回 `.cap/STATE.md` 并重跑 compact status，完成前不得进入研发阶段。该规则不适用于 `mode=restart_required`、`mode=local_explicit`、`mode=local_fallback_explicit` 或 `mode=local_degraded`，这些模式不得创建平台 Task 或补写 Delivery。团队模式下 `task.requiresNewSession=true` 时绑定返回的 follow-up `task.id`，不得复用旧 `session_id`，并重新提交本任务的验证命令；`reconciliation.needsDeliveryReconciliation=true` 时先对当前 Task 幂等补记普通 Delivery，不能把它误当候选 Delivery。

`repository.harnessMode=local-only` 的工具/Skills 仓只做本地维护验证；local-only 必须在读取平台凭据前拒绝候选 Push/Harness 动作。`harnessMode=server` 才能进入平台候选 Test/Review。

每次启动向用户简报：模式、仓库/分支、Task、当前阶段、阻断或 Action、Outbox 数和下一动作；随后在没有人工门禁时继续工作，不以“状态已检查”结束。

模型可见输出也走保守压缩：本地测试、构建、打包优先用 `scripts/cap-execute.mjs run --compact`；PASS 只返回 Gate、哈希、字节数与 Artifact，非 PASS 自动 `full-fallback` 到脱敏头尾诊断，canonical receipt/bundle 与退出码不变。Git 先读短状态、路径、统计和补丁健康，失败、冲突、评审、安全或发布时再展开相关 patch；不得为省 Token 隐藏证据。

## 4. 平台、Task 与离线边界

团队模式先按 `../harvest-experience/SKILL.md` 注入经验。调用 `create_or_attach_task` 前使用 `scripts/cap-task-request.mjs` 脱敏，只发送意图、代码范围和验证边界；敏感风险拒绝最多以同一脱敏结果重试一次，仍失败则记 `task_creation_blocked` 并停止编码。

MCP 已加载但远端暂时失败时，明确说明离线原因、影响与恢复方式；本轮应发送的结构化元数据可用 `scripts/cap-outbox.mjs enqueue` 写入 `.cap/outbox.jsonl`。只重放当前用户明确发起的当前 Task；历史 Task/Session 或无归属事件必须标记“等待历史元数据补报授权”，未获授权时保留且不阻塞当前主线。禁止把本地 PASS 补报成 Server Gate PASS，禁止上传代码正文或秘密。

当前会话根本没加载 MCP 时不能写 Outbox 伪装离线团队流程，必须走 `mode=restart_required`。显式本地模式也不写 Outbox。

## 5. 实现、Push 与 Harness

编码由当前 Skills Session 或受控 Provider 完成，提交真实 Artifact/Commit/Delivery。任何状态摘要都必须按当前 HEAD、源码 fingerprint 与最新执行结果重验；旧 PASS、可编辑摘要或历史 Delivery 不能覆盖新失败。

进入 Server Test/Review 前，当前精确 Commit 必须在上游可见。`reconciliation.pushRequired=true` 时只请求一次精确授权，说明远程、分支、Commit；授权只覆盖该 Task/仓库/分支/Commit，任一变化即失效。授权后使用 `scripts/cap-push-candidate.mjs` 完成 Push、远端 ref 回读、候选 Delivery 登记和 canonical Task 复核。候选失败不写 Outbox。

进入测试或评审时加载 `../cap-flow/references/harness-action-protocol.md`：

- 测试：Server 创建/返回 Test Action，再用 `get_task_action` / `wait_task_action` 续接；macOS/Linux 运行 `scripts/cap-local-test-provider.mjs <repo> <action-id>`，本机 Provider 不可用时明确阻塞。原生 Windows 不调用该脚本，只等待 Server/Linux Runner。
- 评审：Review Action 只读，客户端不能自签 PASS。
- 代码修复：只续接 Server Review 生成的 Harness Patch Action；新 Commit 必须重新经过对应门禁。

只有 `harnessMode=server`、精确 Commit 已远端可见且 `delivery_candidate=true` 时才形成候选并进入 Test；Test 通过后由 Server 推进 Review。没有 canonical 同 Task/同 Commit 证据时最多报告 partial。

## 6. 收口

提交前至少执行：目标测试、`bash scripts/validate-skills`（若本仓适用）、`git diff --check`，并核对改动文件未越过 task-context 范围。行为变更同步 CHANGELOG 与版本元数据。

团队模式的真实改动按 `../harvest-experience/SKILL.md` 只回写意图、文件路径、仓库与验证摘要，不传代码和秘密；本地模式生成并校验 `.cap/experience.md`。发布、归档与 Retire 细节按当前阶段 Skill 执行。

向用户只声称证据实际证明的结果：本地证据不等于 Server Gate，提交不等于已推送，分支推送不等于已合并或已发布。
