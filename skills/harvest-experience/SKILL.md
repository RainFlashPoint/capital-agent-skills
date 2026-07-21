---
name: harvest-experience
description: >
  骑在 CLI 上的经验闭环。会话开始时从 capital-agent 知识库注入相关经验（enrich_context），
  会话结束时把本次的意图与改动文件沉淀回知识库（record_experience），供后续会话复用。
  依赖已配置的 MCP server `capital-agent`（提供 enrich_context / record_experience 等工具）。

  Trigger keywords: 任何真实编码、实现需求、修改代码、修 bug、重构、测试、review、coding session、经验沉淀、会话结束。用户不需要显式输入 $cap。
allowed-tools:
  - Bash
---

# Harvest & Inject Coding Experience

这个 skill 让本地 CLI 会话和 capital-agent 知识层形成闭环：**登记会话 → 注入 → 编码 → 沉淀 → 结束**。
它不改变正常编码方式，只补充轻量元数据事件；绝不上传代码正文。

前置：MCP server `capital-agent` 已在本 CLI 注册（提供 `enrich_context`、`record_experience`、`search_knowledge` 等工具）。若这些工具不可用，跳过本 skill，正常编码即可。

## 1. 会话开始 —— 登记 + 注入

若当前目录属于 Git 仓库，开始实质工作前静默运行仓库自带的 `scripts/install-git-governance.mjs`（从本 skill 所属 package 根定位）。它幂等安装 `prepare-commit-msg`，保留并先执行项目原 Hook，把 `.cap/STATE.md` 中有效的 Task/Session 自动追加到 Commit，并在代码提交时检查 `.cap` 研发产物没有被遗漏或本地 exclude；安装失败时降级，不阻塞编码。不要要求用户手工安装或理解 Hook。

若 MCP 提供 `create_or_attach_task`，优先按 `references/platform-task-loop.md` 创建/复用统一 Task；把返回的 `task_id`、`session_id` 写入 `.cap/STATE.md`。仅当该工具不存在时才退回 `start_skill_session`。工具不可用时降级为原有流程，不阻塞编码。

在开始实质编码前，用本次任务的意图调用一次 MCP 工具 `enrich_context`：

- `agent_type`: 按任务性质选 `dev`（改代码）/ `prd`（理需求）/ `review` / `test`
- `input`: 用户这次的需求/意图原文
- `repo_url`: 当前仓库地址（`git remote get-url origin` 或本地路径，用于统计复用率归因）
- `session_id`: 可选，会话标识

把返回的经验内容作为上下文纳入你的方案，不要照搬无关内容。若返回为空，正常编码即可。

## 2. 会话结束 —— 沉淀经验（harvest）

当本次编码任务基本完成（改动已成形，无论是否已提交），收集改动文件并沉淀一条经验：

```bash
# 收集本次改动的文件路径（只要路径，不要内容）
git diff --name-only HEAD    # 未提交改动
# 若本次已提交，可用：git diff --name-only HEAD~1 HEAD
```

然后调用 MCP 工具 `record_experience`：

**核心字段(必填)**：
- `intent`: 本次会话的意图/需求。**优先用你对本次会话的总结**（比 commit message 信息量大）；若要用 commit message，先确认它不是 "fix bug" 这类空话，否则用总结。
- `changed_files`: 上一步 `git diff --name-only` 得到的文件路径数组（**只传路径，绝不传代码内容**）
- `repo_url`: 当前仓库地址（必须与第 1 步一致，否则闭环归因会断）

**归因字段(可选)**：
- `session_id`: 会话标识
- `owner`: 需求/叶子的**人类归属**（当初拍板要做这件事的人）
- `runner`: **谁执行了本次**——人跑 = 该 operator；无头/夜间自治 = `night-factory`（或配置的 bot id）。人机贡献可切分,A/B 晋级时能单独看机器自治产出的质量。
- `operator`: 旧字段,作 `owner` 的向后兼容别名（老调用只传 operator 仍工作）。

**飞轮数据点字段(可选,cap-flow 退场时吐;见 `cap-flow/references/intake.md §6` 步⑤)**：
- `predicted_files`: plan 阶段的整体预测面 `[{path, action, reason}]`（path 为 repo-root 相对）——**预测**。
- `verify_verdict`: logic / journey / model 各 check 的通过判定。
- `review_verdict`: review gate = PASS / findings。
- `leaf_id`: 源需求叶 id（无需求树的特性可空）。

> `predicted_files`(预测)对 `changed_files`(真值)打文件预测 F1,是"接入 KB 后模型有没有变准"的**适应度函数**,
> 也是并行分支 A/B 测 skill 变体的第一把尺。

**前向兼容**：以上可选字段 server 端**不认识就忽略、不报错**——skills 可安全吐全集,server 侧收字段 + 落库算 F1
属另一阶段的工作(不阻塞本 skill)。

沉淀成功后工具会返回经验摘要与文档 ID。

随后若 MCP 提供 `record_skill_event`：
- 记录 `experience_recorded`，artifact_refs 只放知识文档 ID。
- 记录 `session_finished`，data 放 verify/review 的结构化结论，不放代码正文。

若 MCP 提供 `record_task_artifact`，按 `references/platform-task-loop.md` 补登记本轮 `.cap` 产物元数据。只传相对路径、hash、Git ref 和结构化摘要；不传文件正文。无 task-id、工具不存在或调用失败时静默降级。

若已有有效 Git Commit 且 MCP 提供 `record_task_delivery`，按 `references/platform-task-loop.md` 自动回写 Commit、改动文件路径、verify/review。HEAD 已推送且门禁满足时，再调用 `request_docker_verification`；不得上传未提交工作区或代码正文。

阶段流转时由 cap-flow 在 HANDOFF 后记录 `stage_entered` / `gate_passed` / `stage_blocked` / `verify_completed` / `review_completed`。

## 规则

- **意图质量优先**：intent 太短或是 "fix"/"update"/"修改" 这类空话时，服务端会自动跳过；请尽量给一句有信息量的意图总结。
- **只传文件路径，不传代码内容**：沉淀的是"这类需求通常改哪些文件"的经验，不是代码本身。
- **repo_url 首尾一致（repoTail 不变量）**：注入和沉淀用同一个 repo_url，复用率统计才准确。服务端从 repo_url 派生 `projectKey` 做归因；**大小写 / 尾部差异会让 projectKey 不匹配、闭环归因静默断裂**——注入与沉淀务必逐字符同源。
- **owner ≠ runner**：owner 记"这需求归谁",runner 记"这轮谁跑的"。夜间自治跑务必把 runner 标成 `night-factory`,别混进人的账。
- **不确定就跳过沉淀**：如果本次会话没有真正的代码改动（纯问答、纯调研），不要调用 `record_experience`。
- 沉淀结果与量化指标（沉淀量、复用率）可在平台 `/experience` 页面查看。

## 三处统一出口

`record_experience` 是 cap 家族沉淀的**统一出口**,三处都走它(不各造通道)：
- **cap-flow** —— 退场 Retire 步⑤ 吐 labeled 数据点(`intake.md §6`);`/cap evolve` 推耐久教训(`evolve-loop.md`)。
- **cap-review** —— 复发 findings 蒸馏成经验卡(`distillation-loop.md`)。
- **cap-shape** —— 定型的耐久决策。

全部带 owner/runner 归因、同一 repo_url,汇进中心 KB 团队共享池。
