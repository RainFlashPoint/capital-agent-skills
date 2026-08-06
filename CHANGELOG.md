# Changelog

## 0.4.9

- 新增任务入口“分支意图 Gate”：不再只检查是否直写主干，还会识别历史功能、维护、release、客户变体和其他 Task 分支；分支不匹配时要求新建、续用或切换基线，并记录 branch purpose 与 base commit。
- 新增提交出口“Commit scope Gate”：按必须提交、需要确认、明确排除分类完整脏区，保护既有改动和本机配置；回归测试、契约文档与共享配置按实际交付价值判断，禁止按目录一刀切或使用 `git add .` 一锅端。
- STATE 模板、开发计划、编码实现和结构校验同步新增两道 Gate 的持久字段与一致性检查。

## 0.4.8

- 直接 HTTP 探测不可用时不再误报平台 `network_error`，改为等待 Capital Agent MCP 做最终确认。
- MCP 连接成功会覆盖直连探测结果；只有直连与 MCP 都失败时才进入本地降级。
- 区分“执行进程无法直连”和“平台明确拒绝握手”，避免研发误判平台断网。

## 0.4.7

- 根 `.cap` 固定表示当前活动需求；新需求开始前阻止覆盖仍在执行或待退场的 Task。
- 完成需求按 Task 生成可校验历史快照和索引，只有同 Commit 的 Delivery 与 Server Gate 通过后才清理活动产物。
- 历史需求默认不全量注入 AI；续作通过父 Task 或精确索引按需召回，并重新核验当前代码。

## 0.4.6

- 修复 Node 18 下 `mcp-remote` 的 `undici` 启动失败：统一要求并自动寻找 Node 20.18.1+，三种客户端写入同一兼容 Node 绝对路径；不兼容时在覆盖 MCP 配置前 fail-closed。

## 0.4.5

- 新增 Cursor 一键适配：安装唯一 `cap` Skill、注册固定 MCP Runtime，并写入 always-on 研发规则；真实 Git 研发请求自动创建或绑定 Task，纯问答不上传。
- Cursor MCP 配置采用幂等 JSON 合并，只维护 `capital-agent` 条目，保留已有顶层字段和其它 MCP Server；配置损坏时 fail-closed，不覆盖原文件。
- Doctor 增加 `Cursor MCP` 与 `Cursor 自动进入 Cap` 真实配置检查。

## Unreleased

- README 新增本地模式与团队增强模式：明确 Skills 无需 Cap Server 即可供个人、开源团队和其他公司使用，并分别说明安装方式、能力边界及接入 Server 后获得的统一 Task、中心知识库和独立 Harness Gate。
- 重构 README 产品表达：围绕 Agent 研发主线、可信门禁、持久状态和经验飞轮说明项目价值，精简内部字段与运行细节，同时保留完整安装、升级、诊断和使用入口。
- 更新 README 路线图：标记中心知识库统一出口、owner/runner 归因链路和文件预测 F1 数据契约已经落地，并把尚未完成的个人看板与服务端趋势报告拆成明确后续项。
- Codex MCP 注册改为幂等维护 `~/.codex/config.toml` 受管理区块，不再要求 Codex Desktop 用户额外安装或暴露 `codex` CLI；保留其它 MCP 与个人配置。
- MCP Bridge 改为 setup 时固定安装到本机运行时目录，Codex 启动时不再依赖 `npx`、GUI PATH 或临时联网下载；Doctor 真实执行 MCP initialize 与 tools/list，避免“已注册但不可用”假 PASS。
- 新增 `scripts/setup.sh` 作为统一安装入口，自动发现 PATH、Homebrew、Volta 与 NVM 的 Node.js；Shell 找不到 Node 时不再直接报 `command not found`，而是输出明确的 Node 18+ 修复方式。
- setup 以幂等受管理区块安装 Codex/Claude 全局自动激活规则：Git 仓库中的真实研发请求无需显式 `$cap` 即创建/绑定 Task，纯问答与讨论不上传；用户原有全局指令保持不变。
- 本地 Test Provider 在长测试期间每分钟续租一次，每次仅延长 5 分钟且总生命周期最多 10 小时；连续三次续租失败主动终止测试，避免失联进程无限运行。
- `setup --upgrade` 自动安装并注册按需启动的本地 Test Provider，凭证仅以 `0600` 保存于研发机，不再要求研发理解 Runner ID 或 Token。
- 本地 Provider 只领取当前用户显式指定的 Test Action，在独立 worktree 执行后物理清理；Server 强制 test-only，拒绝无 Action ID、跨用户和 Patch 认领。
- `setup --doctor` 新增本地 Provider 文件、凭证与 Server 鉴权探测。
- 新增开源发布安全门禁，阻止真实凭证、私网地址、固定身份和企业项目细节进入公开仓库。
- 将统一入口中的企业项目示例替换为通用占位仓库，避免项目与分支信息进入公开 Skill。

## 0.3.9 — 2026-07-27

- Harness Action 进入终态后强制同步刷新 STATE 与 Test/Review 阶段报告，旧的“等待 Commit、Action 未创建”描述必须被替换。
- 本地证据统一记录 Action、源 Commit、Provider 终态、Server Gate、机器分类和解除条件；`ENV_BLOCKED` 不得被写成代码失败或 PASS。
- Test Action ready 后自动唤醒本机已注册 Runner，只领取 Harness Action 并继承本机 Maven/npm/SDK 环境；本地 Provider 不可用时不再回退到 Server 猜测研发环境。

## 0.3.8 — 2026-07-27

- 增加精确 Commit 的 Push 门禁：当前 HEAD 未在上游分支可见时明确提示远程、分支和 Commit，授权后连续执行 Push、当前 Delivery 与 Test Action。
- 当前 Task 主线与历史 Outbox 完全解耦；历史元数据补报不再阻塞当前测试与评审。
- Harness 预检错误按 Commit 未推送、仓库认证、分支缺失、Provider 状态和验证命令缺失分类展示；Test 成功后自动接力只读 Review，不再要求用户重复输入“继续”。

## 0.3.7 — 2026-07-26

- 为所有外部系统集成增加四条跨项目安全硬门：环境选择 fail-closed、配置作用域不升级、真实调用显式启用、新配置默认不产生流量。
- 编码与 Review 在命中外部系统或环境配置时共享同一组不变量；支付渠道的表、枚举、字段和接口仍留在专项 Skill、项目画像与经验层。
- 增加结构回归，防止通用角色卡丢失不变量或混入具体项目字段。

- 修复已完成父 Task 的后续任务接续：`cap-status` 自动解析活动 follow-up Task，强制新建 Skills Session、按本轮刷新验证命令，并避免把父 Task 的最后 Commit 误补报到 follow-up。
- `$cap` 握手新增平台 Action 接力：按仓库/分支自动认领 Review 或验证工作项，完成后回写统一证据并由 Server 自动重算 Gate，不再停在“等待 Review”。

## Unreleased

- 经验沉淀携带 Task/Commit，由 Server 根据同 Commit Gate 自动生成可信验证判定；`cap-status` 读取平台 Task，避免本地 STATE 陈旧时仍显示“测试验证”。
- 客户端 Doctor 升级为能力握手，验证身份、Task 写入、Commit 对账与 MCP 注册状态。
- 项目治理新增兼容原 Hook 的 `post-commit` 自动补报；网络失败写入本地待发送队列，并在下一次 `$cap` 状态检查时自动重试。
- Delivery 协议支持知识直接采用、修改采用、未采用与误导反馈，供平台计算真实采纳率。

## Unreleased

- 拆分代码交付与环境验证门禁：开发/测试分支允许在 `ENV_PENDING/ENV_BLOCKED` 时推送，受保护分支仍要求完整 verify/review gate。
- `cap-status` 增加本地 HEAD、upstream HEAD 与 `delivery-head` 对账，自动暴露 IDEA、人工或其它 Agent 产生的未登记 Commit。
- 已选择安装的 Capital Agent `pre-push` Hook 会在治理安装器运行时自动升级到最新门禁语义；非 Capital Agent Hook 不会被覆盖。

## 0.3.6 — 2026-07-23

- 新增确定性 `cap-status.mjs`：一次检查平台配置与身份、Git 仓库、Task/Session、当前阶段和下一动作。
- `$cap` 开场强制输出客户端握手快报；MCP、身份或平台失败时明确进入本地降级，禁止静默丢失平台闭环。
- Artifact 和 STATE 不再被视为流程终点；无人工门禁时，同一会话必须按下一动作继续执行。
- 增加握手、旧阶段归一、门禁停留和产物驱动下一步的回归测试。

## 0.3.5 — 2026-07-21

- Codex 与 Claude 的技能列表只安装唯一入口 `Cap`；经验闭环、内部编排器及七个研发阶段继续保留，由 `Cap` 按意图和复杂度自动调用。
- 升级安装会安全清理旧版本遗留且仍指向本技能包的内部阶段软链接，不删除用户目录或其他来源的同名 Skill。
- 同时清理已从源码退场的 `cap-map`、`cap-shape`、`cap-build`、`cap-verify` 历史软链接。
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
