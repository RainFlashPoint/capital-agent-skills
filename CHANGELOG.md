# Changelog

遵循语义化版本。格式参考 Keep a Changelog。

## [0.1.0] — 2026-07-09

### Added
- **cap 研发流程技能族首个版本**:纯文件 + git 的结构化研发流程,不依赖任何运行时,Claude / Codex 都能跑。
  - **1 driver(`cap-flow`,含 intake 需求树)+ 7 流程 skill**:map / shape / plan / build / verify / review / release。driver 负责 Orient → Route → Handoff,并内联需求树的分叉决策;机械树操作(Seed/Generate/Ingest/Coverage/Lint/Move/Retire)落在 `references/intake.md` + `scripts/intake.py`。
  - **角色卡透镜**:server-dev / client-dev / big-data / qa(baseline)/ architect / design / ai-readiness / skill-maintainer,由 `references/role-routing.md` 按改动 glob 路由加载。
  - **verify 三 checks**:`cap-verify/checks/{logic,journey,model}.md`——logic 基线恒跑,journey/model 按 surface 挂载(journey 含 Web/OpenAPI/App)。
  - **release 按部署目标组织**:`cap-release/targets/{container,static,vps}.md` + 晋级门引擎(dev→staging→canary→full)。
  - **语言包**:python / typescript / go / rust / java-spring / kotlin / swift,记录各语言的 lint/test/build 具体命令。
  - **状态目录 `.cap/`**:PROFILE.md / STATE.md / spec.md / plan.md / requirements/ / verify/ / review/ / archive/ / EVOLUTION.md,单写者纪律。
  - **可移植适配**:`references/runtime-adapters/codex.md`——AskUserQuestion→text_mode、Task 并行→Task-or-sequential 降级。
  - **硬门禁**:`scripts/cap-guard`(pre-commit 并发/边界防串台)、`scripts/validate-skills`(结构 lint)。
- **经验闭环 `harvest-experience`(本项目核心)**:骑在 CLI 上的 `注入 → 编码 → 沉淀`。会话首尾各调一次 `enrich_context` / `record_experience`,连 `capital-agent` 中心知识库,带 operator 归因。接入见 `skills/harvest-experience/references/setup-mcp.md`。
- **护城河改锚**:`references/evolve-loop.md` 与 `references/distillation-loop.md` 的沉淀出口指向中心知识库(不指向任何外部代码仓自更新环);`cap-verify/checks/model.md` 提供 F1 proof-of-value 钩子(接入 KB 后模型预测准确率的可观测回归)。
