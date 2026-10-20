---
name: cap
description: Capital Agent 研发工作的统一入口。用于实现功能、修复问题、测试验证、代码评审和发布交付；系统根据任务复杂度自动选择必要步骤，用户不需要理解或手动调用内部阶段。
---

# Capital Agent 轻量研发入口

研发唯一公开入口：按风险加载协议，门禁不减。

## 1. 绑定包与 compact 状态

从**本次加载文件的绝对路径**定位 `scripts/cap-package.mjs`；安装可能只有 `cap` 软链：

```text
node <loaded-cap-directory>/scripts/cap-package.mjs resolve skills/cap-flow/SKILL.md
node <loaded-cap-directory>/scripts/cap-package.mjs run scripts/cap-status.mjs <repo> --compact --mcp-runtime <loaded|missing|unknown>
```

解析器按真实位置返回唯一包根、资源路径和摘要。下文路径相对此包：读取用 `resolve`，Node 用 `run`。升级重载；失败修当前安装，**禁止递归搜索其他 clone/worktree 或替用旧门禁**。

研发前检查宿主 Capital Agent MCP。`--compact` 返回路由状态；`outputMode=full-fallback`（阻断、纠偏、未知 blocker、异常同步）必须加载完整 `skills/cap-flow/SKILL.md`。

首次检查锁定 canonical Git root 为唯一可写主仓；`.cap`、历史、其他 clone/worktree 路径只能校验，不能选仓。

先处理安装：`installation.upgradeRecommended=true` 先升级并重跑；`bootstrapRecommended=true` 初始化清单。已加载旧 Skill 的会话提示新任务验证，不能冒充新版本。

## 2. 本地门禁

各阶段先读 `.cap/STATE.md`、`.cap/task-context.md` 及已有 plan/verify/review，核对 branch、HEAD、工作树、Task、未完成门禁。新任务或事实变化按以下文件执行：

- `skills/cap-flow/references/task-reconnaissance.md`：代码/历史侦察、task-context 新鲜度；
- `skills/cap-flow/references/progress-protocol.md`：状态与阶段推进；
- `skills/cap-flow/references/complexity-routing.md`：L1–L4 分类；
- 当前阶段 Skill 的 `SKILL.md`：`skills/cap-understand`、`skills/cap-define`、`skills/cap-plan`、`skills/cap-implement`、`skills/cap-test`、`skills/cap-review` 或 `skills/cap-release`。

阶段映射：项目了解=`understand`，需求确认=`define`，开发计划=`plan`，编码实现=`implement`，测试验证=`test`，代码评审=`review`，发布上线=`release`；用户无需记内部名。

L1/L2 无风险时只加载必要 reference 和当前阶段 Skill。L3/L4、安全、权限、支付、数据库迁移、外部副作用、MCP/发布、跨项目、复杂并发或难回滚，加载完整 `skills/cap-flow/SKILL.md`。分类未知走完整协议，不猜低风险。

跨阶段维护 `.cap/spec.md`、`.cap/plan.md`、`.cap/STATE.md`；plan/implement/test/review/release 前运行 task-context 门禁。既有脏文件先确认归属，禁止覆盖。

长会话按 `skills/cap-flow/references/context-compaction.md`；`contextGate` 未过按 `nextActions` 补齐重跑，无遥测仍检测阶段/语义变化。

原生 Hook 见该 reference；注册、信任和真实回调分别取证。

可见压缩/恢复后，**恢复必须先于继续读取业务代码或执行研发动作**：同源运行 `scripts/cap-context-checkpoint.mjs resume <repo> --event <unique-visible-event>`，读 hot 和所需 warm。没有可信压缩回调时不能承诺每次自动监听；摘要不证明恢复成功。审阅来源后用 `scripts/cap-context-checkpoint.mjs prepare`，参数见 reference，沿用授权。

## 3. 状态分流

- `mode=session_root_blocked`：停止读取错误仓并回到锁定仓；跨项目按 `cross-project-handoff.md` 审阅 handoff 后运行 `cap-session-root.mjs switch`，同项目 worktree 使用新会话。
- `mode=boundary_blocked`：停止研发；`done` 先严格 Retire，未完成态才可切换。tracked `.cap` 默认阻断，用户授权后方可用 `cap-task-state-switch.mjs --migrate-tracked-active` 原子迁移。
- `mode=restart_required`：团队配置存在但会话无 MCP。可选启动只保证能聊天；每个新研发任务仍检查 MCP 并尝试团队握手。让用户选择重启，或明确“本次本地继续”后以 `--allow-local-once` 重跑；禁止静默降级。
- `mode=local_explicit` / `mode=local_fallback_explicit`：只做本地证据，不写平台 Task/Experience/Delivery/Gate/Outbox，只能称本地 PASS。后者绑定运行会话 + 分支 + Task，新会话或 MCP 加载后失效。
- 平台已连接或待 MCP 确认：以 Server canonical Task 为权威；直接 HTTP 探测失败但 MCP 已加载时继续用 MCP 确认，不能直接宣称平台断网。

仅在平台已由 MCP 确认可用的团队模式中，`mode=platform_ready` 或 `task.id` 为空时，才必须先调用 `create_or_attach_task`，把 Task/Session 写回 `.cap/STATE.md` 并重跑 compact status，完成前不得进入研发阶段。该规则不适用于 `mode=restart_required`、`mode=local_explicit`、`mode=local_fallback_explicit` 或 `mode=local_degraded`，这些模式不得创建平台 Task 或补写 Delivery。团队模式下 `task.requiresNewSession=true` 时绑定返回的 follow-up `task.id`，不得复用旧 `session_id`，并重新提交本任务的验证命令；`reconciliation.needsDeliveryReconciliation=true` 时先对当前 Task 幂等补记普通 Delivery，不能把它误当候选 Delivery。

`repository.harnessMode=local-only` 的工具/Skills 仓只做本地维护验证；local-only 必须在读取平台凭据前拒绝候选 Push/Harness 动作。`harnessMode=server` 才能进入平台候选 Test/Review。

简报模式、仓库/分支、Task、阶段、阻断/Action、Outbox 数及下一步；无人工门禁则继续。

测试、构建、打包优先用 `scripts/cap-execute.mjs run --compact`：PASS 返回 Gate、哈希、字节数、Artifact；非 PASS `full-fallback` 返回脱敏头尾，canonical receipt/bundle、退出码不变。Git 先读短状态、路径、统计、补丁健康；失败、冲突、评审、安全、发布展开 patch，不能隐藏证据。

## 4. 平台、Task 与离线边界

团队模式先按 `skills/harvest-experience/SKILL.md` 注入经验。调用 `create_or_attach_task` 前使用 `scripts/cap-task-request.mjs` 脱敏，只发送意图、代码范围和验证边界；敏感风险拒绝最多以同一脱敏结果重试一次，仍失败则记 `task_creation_blocked` 并停止编码。

MCP 已加载但远端失败时报告离线原因、影响、恢复方式；本轮结构化元数据用 `scripts/cap-outbox.mjs enqueue` 写 `.cap/outbox.jsonl`。只重放用户明确发起的当前 Task；历史 Task/Session、无归属事件标记“等待历史元数据补报授权”，保留且不阻塞主线。禁止把本地 PASS 报成 Server Gate PASS，禁止上传代码正文或秘密。

当前会话根本没加载 MCP 时不能写 Outbox 伪装离线团队流程，必须走 `mode=restart_required`。显式本地模式也不写 Outbox。

## 5. 实现、Push 与 Harness

当前 Skills Session 或受控 Provider 编码，提交真实 Artifact/Commit/Delivery。摘要按当前 HEAD、源码 fingerprint、最新结果重验；旧 PASS、摘要或历史 Delivery 不能覆盖新失败。

Server Test/Review 前精确 Commit 须在上游可见。`reconciliation.pushRequired=true` 请求一次精确授权，列远程、分支、Commit；仅限该 Task/仓库/分支/Commit，变化即失效。授权后用 `scripts/cap-push-candidate.mjs` Push、回读 ref、登记候选 Delivery、复核 canonical Task；失败不写 Outbox。

进入测试或评审时加载 `skills/cap-flow/references/harness-action-protocol.md`：

- 测试：Server 创建/返回 Test Action 并续接；macOS/Linux 有沙箱才运行 `scripts/cap-local-test-provider.mjs`，否则 `remote-only` 等待远端 Runner。原生 Windows 同样只等待 Server/Linux Runner；严禁无沙箱执行。细节见 Harness 协议。
- 评审：Review Action 只读，客户端不能自签 PASS。
- 代码修复：只续接 Server Review 生成的 Harness Patch Action；新 Commit 必须重新经过对应门禁。

只有 `harnessMode=server`、精确 Commit 已远端可见且 `delivery_candidate=true` 时才形成候选并进入 Test；Test 通过后由 Server 推进 Review。没有 canonical 同 Task/同 Commit 证据时最多报告 partial。

## 6. 收口

提交前执行目标测试、`bash scripts/validate-skills`（适用时）、`git diff --check`，核对 task-context 范围；行为变更同步 CHANGELOG、版本。

团队按 `skills/harvest-experience/SKILL.md` 回写摘要、路径，不传代码/秘密；本地生成并校验 `.cap/experience.md`。严格 Retire 记录可验证知识处置，完成态不直接移入 stale；按当前阶段 Skill 执行。

只报告已证实结果：本地证据≠Server Gate，提交≠推送，分支推送≠合并/发布。
