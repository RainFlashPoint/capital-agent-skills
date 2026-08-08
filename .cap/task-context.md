# Task Context

- intent: 补齐普通开发 Delivery 与最终 Delivery Candidate 的客户端协议
- branch: fix/delivery-candidate-protocol
- head: 4c37399caaf46f3daee443035dd9b56439924bf8
- inspected-at: 2026-08-08T00:00:00.000Z
- profile-used-as: index-only

## Entry points
- `scripts/client-delivery.mjs` — post-commit 构造普通 Delivery；应明确保持非候选语义。
- `skills/cap/SKILL.md` — 公开入口决定何时从编码实现进入测试验证。
- `skills/harvest-experience/references/platform-task-loop.md` — `record_task_delivery` 的完整协议说明。

## Call chain and data flow
- Git post-commit → `buildCommitDelivery` → `commit-reconcile` — 仅补登记每个 Commit。
- 编码实现完成 → `record_task_delivery(delivery_candidate=true)` → Server 创建幂等 Test Action → Test PASS 后 Review。

## Similar implementations
- `skills/cap-flow/references/harness-action-protocol.md` — Test/Review 绑定精确 Commit 的独立执行边界。
- `scripts/test-client-delivery.mjs` — Git Hook payload 的回归测试。

## Tests and environment
- `node --test scripts/test-client-delivery.mjs` — 普通 Delivery/Outbox。
- `bash scripts/validate-skills` — Skill 引用和结构校验。

## Evidence sources
- `scripts/client-delivery.mjs` — 当前 post-commit payload 只有 `verification.pending=true`。
- `skills/cap/SKILL.md` — 当前表述为任意 Delivery 后自动创建 Test Action。
- `skills/harvest-experience/references/platform-task-loop.md` — 当前未区分开发 Delivery 与候选 Delivery。

## External operation boundary
- environment: local
- authorization: 用户已授权修改平台底层 Task 闭环
- minimum-impact: 只改 Skills 协议和测试，不碰现有 git-intent-gates 工作
- recovery: Git revert 或丢弃独立 worktree 分支
- invalidates-on: 发布 Skill 快照或部署需要另行执行

## Impact surface
- modify: `skills/cap/SKILL.md`
- modify: `skills/harvest-experience/references/platform-task-loop.md`
- modify: `scripts/test-client-delivery.mjs`
- inspect-only: `scripts/client-delivery.mjs`, `skills/cap-flow/references/harness-action-protocol.md`
- out-of-scope: Server 实现、Platform 页面、生产 Task 数据

## Profile drift
- 当前仓库无 `.cap/PROFILE.md`；本次以真实协议文件为准。
