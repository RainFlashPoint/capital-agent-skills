---
name: cap
description: Capital Agent 研发流程的短入口。Codex 中用 $cap 显式启动；负责转交 cap-flow 编排器，完成 map、shape、plan、build、verify、review、release 与经验闭环。
---

# Capital Agent 短入口

完整读取并遵循同级目录 `../cap-flow/SKILL.md`。本技能只是稳定、易记的公开入口，不复制流程规则。

用户显式调用 `$cap` 后：

1. 读取目标仓库 `.cap/PROFILE.md` 与 `.cap/STATE.md`（不存在则按 cap-flow 首次进入规则处理）。
2. 调用中心知识层注入与本需求相关的历史经验。
3. 按 `cap-flow` 的 Orient → Route → Handoff 推进当前研发任务。
4. 会话结束时沉淀意图与改动文件路径，并维护统一 Task/Skills Session。
