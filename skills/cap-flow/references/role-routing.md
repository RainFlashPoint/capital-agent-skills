# role-routing — 改动路径 → 角色卡 + verify check 的映射

> 这张表是 cap-* 家族的**路由内核**：把一份 git diff 翻译成"本轮该上哪些角色视角、该跑哪些验证项"。
> 它是慢变、被追踪的规则输入，不是最终判定——判定每次现算（见 §1）。
> v1 语言范围：**Python + Web(TS) + App globs**。加语言按 §7 增语言包，不改本表结构。

---

## 0. 定位：规则输入，不是判定

- **它是**：一组 `glob → 角色卡 + verify check` 的兜底规则。属于"很少变、被追踪"的那类输入，由蒸馏回路增量维护。
- **它不是**：最终决策。决策是一个每次进 build/verify/review 都**重跑**的函数：

  ```
  Decision = resolve( git-diff  ×  PROFILE.surface-map  ×  本表(routing-rules) )
  ```

  - `git-diff`：每轮都变，临时输入，现算。
  - `PROFILE.surface-map`：项目级 surface map（模块 → glob → 默认角色/check），由 `cap-map` 写入 `<repo>/.cap/PROFILE.md`。**优先级高于本表**——项目特化覆盖通用兜底。
  - 本表：PROFILE 没覆盖某条路径、或项目还没 map 过时的**通用兜底**。

- 解析结果（active roles + verify checks）**快照进 `STATE.md`**（`verify-checks:` 与 `## Active roles`），只作 handoff/审计留痕，**不是持久事实**——下轮 diff 一变就过期。

---

## 1. 决策算法（每次进 build/verify/review 时跑）

平台无关，只用 `git diff` + 读文件；任何能跑 Bash 的引擎（含 Codex）都能执行。

```
1. 取改动文件清单：
   git diff --name-only HEAD          # 工作区相对 HEAD
   # 若已 commit 到 feature 分支：
   git diff --name-only <base>...HEAD

2. roles := {} ; checks := {}
3. for path in 改动文件:
     a. 先查 PROFILE.surface-map：path 命中某 surface 的 glob？
        → 命中：并入该 surface 的 roles + checks，标记 path 已覆盖。
     b. 未命中 PROFILE：按 §2 本表从上到下匹配（可命中多条，全部并入）。
     c. 既不命中 PROFILE 也不命中本表任何具体行 → 进"未归类"集合。

4. 应用兜底 + 跨链路（§2 的 R8/B1/B2）：
     - R8 跨链路：统计命中了几个不同 surface 类别（前端/服务端/数据/AI/配置）。
       ≥2 类 或 全链路 journey → 并入 architect 视角（看接缝：全链路数据结构对齐 /
       跨边界契约 / 单一事实源 / blast-radius）。
     - B1：任意 diff → 并入 qa（baseline）+ logic。
     - B2：触及敏感面（auth/支付/密钥/用户数据/外部输入/SQL/文件系统）→ 并入 security 视角。

5. 去重 roles、去重 checks。journey 的子模态（Web/OpenAPI/App）分别保留。

6. 漂移检测（surface-map 是 tracker）：
     若"未归类"集合非空，或某 path 命中本表但 PROFILE.surface-map 查无此 surface
     → 告警 "architecture drifted — refresh PROFILE?"，建议重跑 cap-map 相关部分。

7. 写回 STATE.md：verify-checks / Active roles / Changed-files snapshot。
```

可移植降级（对齐可移植铁律）：

- **并行角色评审**（review 阶段一角色一文件）：有并行能力时 fan-out（各写 `.cap/review/<role>.md`）；
  探测无并行能力（如 Codex）→ 串行逐角色跑，产出同样的分文件。能并行就并行，不能就串行。
- 任何需要选 scope 的交互：用纯文本编号列表，让用户回数字，不依赖结构化提问控件。

---

## 2. 路由规则表（v1：Python + TS + App）

> 从上到下匹配，一个 diff 可命中多行，结果取并集。glob 用 POSIX/gitignore 语义。
> `verify check` 列里的 `journey:Web/OpenAPI/App` 指 journey check 的对应子模态。

| # | 改动路径 glob | 加载角色卡 | 跑 verify check | 说明 |
|---|---|---|---|---|
| R1 | `**/*.tsx` · `**/*.jsx` · `**/*.vue` · `**/*.svelte` · `**/*.css` · `**/*.scss` · `**/components/**` · `**/pages/**` · `**/app/**`（web 前端） | client-dev + design | logic + **journey:Web** | 前端可见面，必走 Web 旅程 + 视觉评审 |
| R2 | `**/*.swift` · `**/*.kt` · `**/*.java`(android) · `**/mobile/**` · `**/ios/**` · `**/android/**` · `**/*.dart` | client-dev + design | logic + **journey:App** | 原生/跨端移动；App 模态 v1 排最后（工具选型未定）。无工具时降级为人工旅程检查清单并记 PARTIAL |
| R3 | `**/api/**` · `**/handlers/**` · `**/routes/**` · `**/*.server.*` · `**/endpoints/**` · `**/controllers/**`（服务端接口） | server-dev | logic + **journey:OpenAPI** | API/handler；OpenAPI 端点用例（正向生成 + 抓真实端点请求） |
| R4 | `**/models/**` · `**/strategy/**` · `**/*.prompt*` · `**/prompts/**` · `**/ai/**` · `**/evals/**` · `**/llm/**` · `**/agents/**/*.py` · `**/agents/**/*.ts` | server-dev (+ qa) | logic + **model** | AI/模型/策略/prompt/评估的代码 → 触发 model check（按 spec 定的 rubric/数据集/阈值跑质量分）。声明式 agent/workflow/skill 定义（JSON/YAML/SKILL.md）走 R7，不在此 |
| R5 | `**/*.sql` · `**/pipelines/**` · `**/etl/**` · `**/dbt/**` · `**/warehouse/**` · `**/*_spark*.py` · `**/*_pandas*.py` · `**/migrations/**` | big-data | logic（+ **model** 当涉及数据质量/回填正确性） | 数据管道/数仓/迁移；big-data v1 为 stub 卡 |
| R6 | `**/*.test.*` · `**/*.spec.*` · `**/test/**` · `**/tests/**` · `**/e2e/**` · `**/__tests__/**` · `**/conftest.py` | qa | logic + **journey** | 测试/规格本身变更 → QA 视角，并跑相关 journey |
| **R7** | `**/agents/**.json` · `**/workflows/**.json` · `**/processes/**.json` · `**/employees/**.{yaml,yml}` · `roles.json` · `people.json` · `app.json` · `installed.json` · `**/SKILL.md` · `**/*.skill.*` · `**/CLAUDE.md`（配置/agent 定义型工程：源即声明式配置） | server-dev（+ **security** 当含权限/授权矩阵，如 `roles.json`/`people.json`） | logic | 配置定义型工程（agent/流程/组织/skill 的声明式定义 + 少量真实代码）。验证靠 schema/契约一致性校验，不跑 model check（它不是 AI 模型代码）。内嵌真实代码（如 `*.py` CLI）仍按 R3/R4 各自路由 |
| **R8（跨链路）** | 元规则，非单一 glob：本轮 diff 命中 **≥2 个不同 surface 类别**（前端 R1/R2 · 服务端 R3 · 数据 R5 · AI R4 · 配置 R7 任意两类），**或** 跑全链路 journey | **+ architect** | （沿用各面已选 check） | 改动跨越多个面 = 全链路/纵切 → 加载 architect 看接缝：全链路数据结构对齐、跨边界契约一致、单一事实源、blast-radius（与单面角色互补，不替代） |
| **R9** | `CLAUDE.md` · `AGENTS.md` · `.claude/**` · `justfile` · `Makefile` · `tsconfig.json` · `.github/**`（AI-上下文 / 构建工具配置） | **+ ai-readiness** | logic | 动了"代码库对 agent 的友好度"相关文件 → 加载 ai-readiness 视角（别把级联 CLAUDE.md/scoped 命令改坏）。注：map 体检与"遗留改造 feature"也加载本卡（非 diff 驱动） |
| **R10（meta：改技能体系自身）** | `skills/**` · `**/SKILL.md` · `skills/cap-flow/references/**` · `.claude-plugin/**`（改动落在 **cap-* 技能族自身**，而非某目标项目的业务代码） | **+ skill-maintainer** | logic（= `bash scripts/validate-skills`） | 编辑这套技能族自己时加载维护者透镜：防臃肿（不新增顶层 skill）/ additive 合并 / 防孤儿 / 溯源 / 可移植 / semver / 自我修改安全。**小改走 `/cap evolve`（append-only），结构性大改走完整 `/cap`**（见 `evolve-loop.md` §1 的 guard）。本规则只在被改仓即 capital-agent-skills 时成立 |
| **兜底 B1** | 任意 diff（每次都加） | **qa（baseline）** | **logic** | 永远至少跑逻辑正确性 + QA 基线视角 |
| **兜底 B2** | 触及敏感面：`**/auth/**` · `**/*login*` · `**/*payment*` · `**/*billing*` · `**/secrets/**` · `**/*credential*` · 含原始 SQL 拼接 · 文件系统/外部输入处理 | **+ security 视角**（由 server-dev/qa 卡的 security 子节承载，v1 不单列 security 角色卡） | logic | 安全敏感面叠加 security 检查清单（见 cap-review 安全 10 域） |

---

## 3. 角色卡取值字典（v1 合法值）

路由结果里的角色名必须落在以下集合（对应 `references/roles/*.md`）：

| 角色 | 文件 | 关注切片 |
|---|---|---|
| `qa` | `roles/qa.md` | 测试覆盖追溯、回归、负路径、隔离、敌意测试 |
| `client-dev` | `roles/client-dev.md` | 前端 + 移动端实现（bundle/re-render/offline-first/语言 pitfall） |
| `server-dev` | `roles/server-dev.md` | 服务端 + API 契约 + 性能(N+1/index) + security 子节 |
| `design` | `roles/design.md` | 视觉/排版/交互态/a11y + UX-flow |
| `big-data` | `roles/big-data.md` | 管道/数仓/lineage/幂等/分区（v1 stub） |
| `architect` | `roles/architect.md` | 全链路数据结构对齐 / 跨边界契约一致 / 单一事实源 / blast-radius（改动跨 ≥2 面时由 R8 加载） |
| `ai-readiness` | `roles/ai-readiness.md` | 面向 AI 的友好度/可维护性：CLAUDE.md 级联 / scoped 命令 / 噪声 / 类型 / 测试 / LSP 就绪（map 只读体检 + 改造 feature + 改 AI-上下文/构建配置文件时加载，见 R9） |
| `skill-maintainer` | `roles/skill-maintainer.md` | 唯一作用于工具自身：防臃肿 / additive 合并 / 防孤儿 / 溯源 / 可移植 / semver / 自我修改安全（改 cap-* 技能族自身时由 R10 加载；`/cap evolve` 全程透镜） |

> `security` 在 v1 **不是独立角色卡**：敏感面命中时，由 `server-dev`/`qa` 卡内的 security 子节 + `cap-review` 的安全 10 域承载。后续蒸馏回路可升格为独立卡。

---

## 4. verify check 取值字典（v1 合法值）

| check | playbook | 何时进 |
|---|---|---|
| `logic` | `cap-verify/checks/logic.md` | **总是**（兜底 B1） |
| `journey` (Web / OpenAPI / App) | `cap-verify/checks/journey.md` | 用户可见面/接口/移动面变更（R1/R2/R3/R6） |
| `model` | `cap-verify/checks/model.md` | **AI/模型/策略/prompt/评估变更**（R4），或数据质量(R5 条件) |

子模态选择：`journey` 的 Web/OpenAPI/App 由命中行决定（R1→Web, R3→OpenAPI, R2→App, R6→沿用被测面对应子模态）。

> **规范 token 形式（单一事实源）**：子模态一律写**冒号形式** `journey:Web` / `journey:OpenAPI` / `journey:App`，与本节字典、PROFILE 模板 surface-map 一致。**禁止**括号形式 `journey(Web)`——字面匹配字典时不相等，严格执行器（如 Codex）会判为字典外野值。所有 STATE/spec/build/plan 快照都用冒号形式。

---

## 5. 已覆盖需求自检

- [x] 前端 tsx/vue/css/components → client-dev + design + journey:Web — R1
- [x] 移动 swift/kt/mobile/ios/android → client-dev + design + journey:App — R2
- [x] API/handlers → server-dev + journey:OpenAPI — R3
- [x] AI/models/strategy/prompt/evals → server-dev + qa + model — R4
- [x] sql/pipelines → big-data — R5
- [x] test/spec → qa + journey — R6
- [x] 配置/agent 定义型工程 → server-dev(+security) + logic — R7
- [x] 跨 ≥2 面 / 全链路 → + architect（全链路数据结构对齐 / 跨边界契约 / blast-radius）— R8
- [x] AI-上下文/构建配置(CLAUDE.md/.claude/justfile…) → + ai-readiness — R9（map 体检/改造 feature 也加载）
- [x] 改技能体系自身(skills/** · *SKILL.md · references/** · .claude-plugin/**) → + skill-maintainer — R10（`/cap evolve` 全程透镜）
  - 注：需求树**数据**（`<target-repo>/.cap/requirements/`）是运行时产物，不是技能体系代码，不进路由。
- [x] 兜底 → qa + logic（+ security 当敏感面）— B1/B2

---

## 6. 扩展点（蒸馏回路维护）

- 加语言/框架：写一份 `references/languages/<lang>.md` 语言包（见 §7），不再往角色卡塞大段 pitfall。
- 加角色/check：先扩 §3 / §4 取值字典，再在 §2 引用，避免路由产出"野值"。
- 项目特化：优先写进该 repo 的 `PROFILE.md` surface-map（覆盖本表），不污染通用规则。
- App 模态工具定型后，更新 §2 R2 的降级说明与 `cap-verify/checks/journey.md` 的 App 子模态。

---

## 7. 语言包（`references/languages/<lang>.md`）

语言相关知识（陷阱 / 测试·覆盖率命令 / lint / LSP / 框架）**不塞进角色卡**，各自一份语言包，**按改动文件扩展名加载**。角色卡（server-dev/client-dev）、logic check、build TDD、ai-readiness（LSP 维度）都从这里取该语言的确切命令。

| 扩展名 | 语言包 | 默认 role |
|---|---|---|
| `**/*.py` | `languages/python.md`(+ Django) | server-dev |
| `**/*.ts` `**/*.tsx` `**/*.js` `**/*.jsx` | `languages/typescript.md` | server-dev(后端)/ client-dev(前端·E2E) |
| `**/*.go` | `languages/go.md` | server-dev |
| `**/*.rs` | `languages/rust.md` | server-dev(服务)/ client-dev(CLI/桌面/库) |
| `**/*.kt` `android/**` | `languages/kotlin.md` | client-dev(主)/ server-dev(Ktor/KMP) |
| `**/*.swift` `ios/**` | `languages/swift.md` | client-dev |
| `**/*.java` | `languages/java-spring.md`(+ Spring Boot) | server-dev |

> 加载逻辑：resolve 出 active roles 后，**按本轮改动文件的扩展名**加载对应语言包，叠加到角色视角 + logic 命令。一个特性多语言 → 加载多份。归属与 §2/§3 的 surface 路由正交（surface 决定"谁看"，语言包决定"用哪套命令/陷阱"）。
