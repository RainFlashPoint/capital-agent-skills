# Changelog

## 0.3.5 — 2026-07-21

- Codex 与 Claude 的技能列表只安装唯一入口 `Cap`；经验闭环、内部编排器及七个研发阶段继续保留，由 `Cap` 按意图和复杂度自动调用。
- 升级安装会安全清理旧版本遗留且仍指向本技能包的内部阶段软链接，不删除用户目录或其他来源的同名 Skill。
- 统一公开入口说明：用户只描述要完成的研发工作，`Cap` 自动选择必要步骤并在真实编码会话中执行经验闭环。

## 0.3.4 — 2026-07-21

- 经验生命周期明确为 `candidate → validated → promoted → deprecated`；promoted 要求至少两个不同 Task 证据和管理员批准，deprecated 支持原因与替代关系且不再注入。
- Review finding 蒸馏改为至少 3 个不同 Task/Run，同一轮多个 finding 不重复计数。
- 同一问题与解法使用稳定 fingerprint 去重并累计证据；外部 Skill 必须记录 URL、版本、License 和 fixture/验证引用。
- 指标语义纠正：旧 `reuse_rate` 仅作曝光率兼容，明确新增曝光率、采纳率和误导率。

## 0.3.3 — 2026-07-21

- `record_experience` 改为提交结构化问题、解法、适用条件、反例、证据引用和结果，不再把文件路径摘要等同于经验。
- 未验证或旧客户端产生的内容只能进入 candidate draft；只有带 PASS 证据的经验才能发布并注入当前项目。

## 0.3.2 — 2026-07-21

- 增加 `cap-context-guard`：进入计划、实现、测试、评审或发布前，确定性检查任务调查的 intent、branch、HEAD 与路径证据。
- 增加临时 Git 仓库行为 fixture，证明仅有 PROFILE 不可进入计划、代码变化会使调查过期、缺少测试证据会阻断流程。

## 0.3.1 — 2026-07-21

- 增加强制可见进度协议：每个阶段明确“当前、正在做、完成条件、下一步”，长操作与阶段交接持续播报真实进展。
- 增加任务级代码侦察协议：每个新任务必须从当前仓库代码建立 `.cap/task-context.md`，项目画像只作为搜索索引。
- 七个阶段 Skill 均强制加载两份共享协议，并增加结构回归防止后续绕过。

## 0.3.0 — 2026-07-21

- 阶段协议统一为 `understand → define → plan → implement → test → review → release`。
- Skill 本体同步改名为 `cap-understand`、`cap-define`、`cap-implement`、`cap-test`，不再保留难理解的旧 Skill 名。
- 新生成的 `.cap/STATE.md`、Skills Session、Task Artifact 与平台事件只写新阶段 ID。
- `map/shape/build/verify` 仅作为旧任务读取兼容值，读取后立即归一化，不再继续传播。

## 0.2.1 — 2026-07-21

- 将 `$cap` / `/cap` 明确为研发唯一公开入口，用户无需理解内部阶段名。
- 新增“项目了解、需求确认、开发计划、编码实现、测试验证、代码评审、发布上线”直白动作词，并支持 `/cap 需求`、`/cap 开发`、`/cap 测试` 等表达。
- `cap-shape`、`cap-build`、`cap-verify` 等名称降为内部兼容 ID，保留历史 STATE、平台事件和旧客户端兼容性。
- 增加公开入口词汇回归校验，防止后续文档再次把内部阶段名暴露给研发。

遵循语义化版本。格式参考 Keep a Changelog。

## [0.2.0] — 2026-07-21

### Added
- 新增 L1–L4 研发复杂度路由：小改动使用精简流程，中高风险与生产发布保留完整 map、shape、plan、build、verify、review、release 门禁。
- `PROFILE.md` 新增 `Verification environment` 项目验证环境画像，记录运行时、执行区域、依赖仓库、Secret 引用、可组合服务、企业服务、确认缺口和权威验证阶段；禁止记录密钥明文。
- `cap-verify` 新增 `PASS / CODE_FAILED / ENV_BLOCKED / INCONCLUSIVE` 四类验证归因，环境与依赖问题不再伪装成代码失败。
- Skills 交付证据新增当前 Commit、UTC 执行时间、实际命令与 exit code、质量资产 ID 和脱敏环境指纹，供平台判断证据新鲜度与可信度。
- 新增复杂度路由与 Git Hook 回归测试。

### Changed
- 提交包含业务代码时，`.cap/STATE.md`、spec、plan、verify、review 等当前研发产物必须一并暂存；本地 exclude 或 ignore 隐藏 `.cap` 会阻止提交。
- Commit Hook 继续自动追加 `Task:` / `Session:` trailer，并明确区分“本地已提交”和“已推送、平台可见”。
- 平台只应采用与最新 Commit 匹配的验证证据，旧 Commit 的 PASS 不得替新提交放行。
- `cap-map` 会从 Dockerfile、CI、toolchain、依赖配置和测试文档建立初始环境画像，未知依赖显式记录为 `unknown`，不由 Agent 猜测。

### Fixed
- 修复 `.cap` 研发产物可能因只加入本地 `.git/info/exclude` 而未进入交付提交的问题。
- 修复 Skills 已生成 Task/Session 元数据，但提交说明缺少可靠关联 trailer 的交付断链风险。
- 修复复杂任务与小改动共用同一套重型阶段、导致流程成本过高的问题。

## [0.1.2] — 2026-07-19

### Added
- 普通编码请求自动进入 Task/经验闭环，无需显式 `$cap`；首次进入 Git 项目时静默安装兼容现有 Hook 的 `prepare-commit-msg`，自动把 Task/Session 写入 Commit。

### Changed
- 项目 Hook 不再强制 Commit 格式、不覆盖原 Hook，也不默认生成 GitLab CI 文件。

## [0.1.1] — 2026-07-19

### Added
- cap-flow 在阶段 HANDOFF 后通过可选 `record_task_artifact` 上报 `.cap` Artifact 元数据；仅包含相对路径、哈希、Git ref、阶段、状态和摘要，工具不可用时静默降级。

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
