---
name: cap-verify
description: >
  研发主线的**验证中枢**:build 之后、review 之前的独立验证阶段。
  根据本轮改动代码动态解析要跑哪些**验证项**——logic(总跑)/ journey(改用户可见面)/ model(改 AI / 模型 / 策略)——
  依次执行各验证项的厚 playbook,汇总写进 `.cap/verify/` 与 STATE。
  与 build 内的单元 TDD 不同:build 的 TDD 是"边写边红绿",verify 是"成体系地证明它真的能用"。
  触发场景:用户说 "/cap verify"、"验证一下"、"跑 verify"、"测一遍"、"验收"、"e2e"、"跑端到端"、
  "评估这次模型 / 策略改动"、"eval"、"现状审计 / health check"、"baseline 健康检查"、"cap-verify";
  cap-flow 判定 stage=verify 时也路由进来,或某验证项被单独点名(`/cap verify --check=journey --scope=full-chain`)。
  本阶段是**调度层**:自己不实测——它解析改动→选验证项→按序执行各 playbook→汇总门控→写交接。
  具体怎么测在 checks/{logic,journey,model}.md。
---

# cap-verify — 验证中枢（调度层）

你是验证阶段的**调度员**。verify 是夹在 **build(实现)** 与 **review(评审)** 之间的独立阶段,职责是:把
"应该能用"变成"已验证能用"的硬证据。

> **定位铁律(与 build 区分)**
> - build 内的 TDD 是**边写边红绿**的单元循环(写一个测试→红→实现→绿)。
> - verify 是**成体系地证明它真的能用**:跑全量套件 + 覆盖率门控、走用户旅程、评 AI 质量。
> 两者不重复:build 关心"这个函数对不对",verify 关心"整个改动作为一个系统对用户 / 对质量站不站得住"。

> **调度层铁律**
> 你**不亲自实测**。你做四件事:① 解析改动→定验证项;② 按序加载并执行每个验证项的 playbook;③ 汇总各
> 验证项门控成本阶段总门控;④ 写报告 + 回写 STATE 交接。具体怎么跑测、怎么截图、怎么打分,全在
> `checks/<check>.md`——你**读它、照它做**,不把它的内容重抄进本文件。引擎 = 一个能 Read/Edit/Bash/Grep
> 的模型(+ journey 验证项用 Playwright MCP)。

---

## 0. 可移植前置（每次入口先做）

> **共享 references 的位置**:本文引用的 `role-routing.md` 物理上在编排器目录 `cap-flow/references/` 下;而
> 各验证项 playbook `checks/<check>.md` 就在**本阶段目录**(`cap-verify/checks/`)下。解析路径分别指向
> `cap-flow/references/...` 与本目录的 `checks/...`,别混。

本阶段要在 Claude 和 Codex 上都能跑。两条降级范式贯穿全程:

### 0.1 交互降级 —— 纯文本编号选项
凡需用户决策(选 scope、确认 eval 契约缺失时如何处理、确认 escalate),**优先用纯文本编号列表**:

```
本次 verify 要验的范围,选一个:
  1) feature   —— 只验本特性改动的旅程(默认)
  2) iteration —— 验本迭代累积的几处改动
  3) full-chain —— 全链路现状审计(也充当 cap-map 的 baseline 健康检查)
回个编号即可。
```

宿主有结构化提问控件可用,但回退路径必须是上面这种编号文本。默认按编号文本写提示。

### 0.2 并行降级 —— 能并行就并行，不能就串行
当本轮要跑**多个验证项**(如 logic + journey + model)时,各产物互相独立、可并行:

- 有并行能力 → 可 fan-out,每个验证项写**各自的报告文件**(`verify/<check>-...-report.md`),最后汇总。
- 无并行能力 → **串行**逐验证项执行同一份 playbook,逐个写报告。

无论并行还是串行,**汇总写 STATE 由本调度层单点完成**(单写者原则,见 §6)。

---

## 1. 入口条件（什么时候进 verify）

满足任一即可进入本阶段:

| 入口 | 条件 | 来源 |
|---|---|---|
| **主线推进** | build 阶段门控通过(实现 green),STATE.stage 推进到 `verify` | cap-flow 路由 |
| **续接** | STATE.stage 已是 `verify`(上次卡在某验证项) | 跨会话 / 子 agent 接力 |
| **单项点名** | 用户 `/cap verify --check=<check> [--scope=<scope>]` | 直接调用 |
| **现状审计** | `--check=journey --scope=full-chain`(无需经 build) | cap-map 的 baseline 健康检查 |

**前置门(进 verify 前应已满足,否则先回退)**:
- build 的实现已 green(单元 TDD 通过)。若 build 未完成 → 编号文本提示先回 `cap-build`。
- 工作树状态可知(下面 §2 要读 git diff)。脏树不阻断,但 journey 验证项需要能原子提交修复,见其 playbook。

> 若 STATE.md / PROFILE.md 不存在(用户跳过 cap-flow 直接调本阶段):本阶段仍可独立跑——自己读 `git diff`
> 解析验证项,产物落 `.cap/verify/`,但**不写 STATE**(无编排器上下文时不假装交接),在报告里注明"独立运行,
> 未更新 STATE"。

---

## 2. 步骤流程（调度层主循环）

### Step 1 — 改动面 → 角色 + 验证项解析（先做）

verify 是**改动驱动**阶段。进来第一件事是解析"本轮该跑哪些验证项",**复用编排器的 role-routing**,不自己
另发明一套。

```bash
# 算改动集(合并去重)
git diff --name-only HEAD          # 已暂存 + 未暂存 vs HEAD
git diff --name-only --staged      # 仅暂存
git status --porcelain             # 含 untracked
```

拿到 changed-files 后,**读 `cap-flow/references/role-routing.md`**,按其决策算法解析:

```
checks := resolve( changed-files × PROFILE.surface-map × role-routing 规则 )
```

- 先查 `<repo>/.cap/PROFILE.md` 的 surface-map(项目特化,优先级高):命中 surface → 取其默认验证项。
- 未被 PROFILE 覆盖的路径 → 套 `role-routing.md` 的通用 glob 表 + 兜底。
- 取并集,得到本轮 **active checks**(子集 ⊆ {logic, journey:Web/OpenAPI/App, model})。

基线规则(始终成立):
- **logic 永远在 active checks 里**(任意 diff 都跑)。
- 改用户可见面(前端 / 移动 / API / 测试本身)→ 叠加 **journey**(选对应子模态 Web / App / OpenAPI)。
- 改 AI / 模型 / 策略 / prompt / evals → 叠加 **model**;数据质量条件亦可叠 model。

> 单项点名(`--check=`)时:跳过解析,直接把指定验证项当作唯一 active check。`--scope=` 仅对 journey 有意义
> (feature / iteration / full-chain),其它验证项忽略。

把解析出的 `active checks` 与 `changed-files` 暂存,Step 4 写进 STATE 快照。

### Step 2 — 架构漂移自检（轻量）

把 changed paths 与 `PROFILE.surface-map` 的 globs 比对:**有 path 落在所有 surface 之外**(新建服务、首个
移动目录等)→ 编号文本告警,不阻断:

```
⚠ 这些改动不在 PROFILE.surface-map 内,验证项解析可能不全:
  - mobile/ios/App.swift
  1) 现在重跑 cap-map 相关部分刷新 surface-map(推荐)
  2) 本次按通用 routing 规则继续(已据规则判定需 journey:App)
回个编号。
```

漂移只影响"是否漏选验证项";解析时通用 routing 表会兜底,不会因此漏跑 logic。

### Step 3 — 按序执行每个 active check 的 playbook

对每个解析出的验证项,**加载并照做它的 playbook**。各 playbook 自带完整步骤、门控、证据 schema:

| 验证项 | playbook(读它、照做) | 产物 |
|---|---|---|
| `logic` | `checks/logic.md` | `.cap/verify/logic-report.md` |
| `journey` (Web / OpenAPI / App) | `checks/journey.md` | `.cap/verify/journey-<scope>-report.md` |
| `model` | `checks/model.md` | `.cap/verify/model-<scope>-report.md` |

执行顺序与协议:

1. **logic 先跑**(它是底座;它绿了再谈旅程 / 质量更有意义)。
2. **journey / model** 在 logic 之后,二者之间无强依赖——可并行(§0.2)或串行。
3. **失败回流不在本层修**:任何验证项暴露**实现 bug**,按该 playbook 的指引 **escalate 回 `cap-build`**
   (build 的 TDD↔调试子循环修),verify 这一轮对应需求标 PARTIAL。本调度层**不在 verify 偷改实现**。
4. **单条问题 ≤ 3 次迭代仍无解 → escalate,不死磕**(沿用各 playbook 的反死磕约定)。

> 调度层的纪律(贯穿所有验证项):**没有本轮新鲜验证证据,不得做任何"通过 / 完成"声明。** 每个报告里的
> 每条 COVERED / PASS 都必须挂本轮真跑的命令 + 输出 + exit code。看到 should / probably / seems / "Great!" /
> "Done!" 出现在验证之前 = STOP,去跑命令。各 playbook 内有各自的 Gate Function 与反合理化表,照用。

### Step 4 — 汇总门控 + 写交接

所有 active check 跑完后,本调度层**汇总**:

1. 读每个报告的 `result`(PASS / GATED / BLOCKED)。
2. **阶段总判定**:
   - 全部验证项 PASS → verify 阶段 = **PASS**,可进 review。
   - 任一验证项 GATED(覆盖率不达标 / 旅程失败已 escalate / eval 未达阈值)→ 阶段 = **gated**,STATE.next
     指回缺口对应阶段(多为 `cap-build`)。
   - 任一验证项 BLOCKED(测试基建起不来 / eval 装置坏 / 缺评估契约且无法回退)→ 阶段 = **blocked**,在
     STATE.Decisions log 记原因。
3. 写一份**阶段汇总**(可放 `.cap/verify/summary.md` 或直接体现在 STATE),列每个验证项的结果与去向。
4. **输出 `## HANDOFF` → 回写 STATE.md**(经 cap-flow / 单写者,见 §6):更新 stage / status / gates /
   verify-checks / next。

---

## 3. 读写哪些 .cap/ 文件

| 文件 | 读 / 写 | 用途 |
|---|---|---|
| `<repo>/.cap/PROFILE.md` | **读** | surface-map(解析验证项)、test-commands、覆盖率阈值。本阶段不写 PROFILE |
| `<repo>/.cap/STATE.md` | **读 + 写**(单写者) | 读 stage / next 续接;写回 stage / status / gates / verify-checks / active roles / next |
| `<repo>/.cap/spec.md` | **读** | 取验收标准(logic Step 1)与 **AI 工作的 eval rubric / 数据集 / 阈值**(model 的契约输入) |
| `<repo>/.cap/plan.md` | **读** | 取任务的 acceptance_criteria 作为"必须被证明的行为"清单 |
| `<repo>/.cap/verify/logic-report.md` | **写** | logic 验证项产物 |
| `<repo>/.cap/verify/journey-<scope>-report.md` | **写** | journey 验证项产物(截图齐全) |
| `<repo>/.cap/verify/model-<scope>-report.md` | **写** | model 验证项产物(质量 / 性能分) |
| `<repo>/.cap/verify/summary.md` | **写**(可选) | 多验证项阶段汇总 |
| `cap-flow/references/role-routing.md` | **读** | 解析 changed-files → active checks |
| `cap-verify/checks/<check>.md` | **读** | 各验证项的执行 playbook(照做) |

> spec→verify 的关键契约:**model 验证项的标准在 spec 阶段定**。若改了 AI 面但 `spec.md` 没写 rubric /
> 数据集 / 阈值 → model playbook 会回退到"AI 工作一般最佳实践审计"并报警;本调度层在汇总时把它记为
> **gated**,STATE.next 提示回 `cap-shape` 补 eval 契约。

---

## 4. 出口门控（全过才算 verify 阶段通过）

进入 `cap-review` 之前,以下必须全部成立:

- [ ] **验证项选齐**:Step 1 解析出的 active checks 已全部执行(logic 必在内),无漏跑。
- [ ] **logic PASS**:全量 / 相关测试本轮真跑 0 failures(贴命令 + exit 0);typecheck / build exit 0;覆盖率
      门控由工具以非零 exit 把关达标(不靠肉眼)。
- [ ] **journey PASS**(若 active):本轮要验的用户旅程都跑到终态;失败用例已回 build 修复并三联截图取证;
      不能测的维度已显式声明(Scope Declaration),不猜成 TESTED。
- [ ] **model PASS**(若 active):评估装置先过 oracle / nop 自检;按 spec 既定 rubric / 阈值跑出实际分;
      baseline-diff 无 REGRESSION;无效跑已剔除。spec 缺契约 = 本门视为 gated。
- [ ] **无偷改实现**:所有暴露的实现 bug 都 escalate 回 build,verify 期间实现文件 0 改动(可 `git diff` 自证)。
- [ ] **证据完整**:每个报告的每条 PASS / COVERED 都挂本轮真跑证据;无"应该过 / 上次过"判定。
- [ ] **STATE 已更新**:gates 勾选、verify-checks 快照、next action 写明(独立运行模式可豁免 STATE,但要在
      报告注明)。

任一项不过 → 阶段 status = `gated` 或 `blocked`,STATE.next 指回缺口对应阶段(多为 build,eval 契约缺失则回
shape)。**verify 阶段 PASS 是进入 review 的前置门。**

---

## 5. 写什么进 HANDOFF（由 cap-flow 写 STATE）

阶段结束,输出 `## HANDOFF` block,经 cap-flow / 单写者把进度写回 `<repo>/.cap/STATE.md`。独立直调时先产同一
HANDOFF,再作为单写者应用。verify 阶段要更新的字段:

```markdown
## HANDOFF
stage: verify            # 若全过且要进下一阶段,由 cap-flow 推进到 review
status: in-progress | gated | blocked
verify-checks: [logic, journey, model]   # 本轮 Step 1 解析出的子集(快照,非持久事实)
active-roles: [server-dev, qa]           # Step 1 解析出的角色,与 checks 同源
changed-files:
- <Step 1 的 git diff 路径清单>
gates-passed:
- verify: logic 通过(套件 + 覆盖率门控)
decisions:
- <date> escalate <实现 bug> 回 build;eval 阈值缺失,回 shape 补 rubric ...
next-action: -> cap-review            # 全过
# -> 回 cap-build 补覆盖率 / 修旅程失败    # gated
# -> 回 cap-shape 补 eval 契约            # model 因缺契约 gated
```

要点:
- `verify-checks` 与 `active-roles` 是**本轮 resolve 出的快照**,仅供交接 / 审计,**不是持久事实源**(下次进来
  diff 变了要重 resolve)。
- gates 三个 verify 子项按本轮 active checks 勾选;**未 active 的验证项不勾、不算缺口**(如本次没动 AI 面,
  model 子项保持未勾但不阻断)。
- `Next action` 必须写成可直接执行、给"全新上下文的下一个 agent"看的指令。

---

## 6. 兼容性（载重规则，Codex / 子 agent 都能用）

| # | 规则 | 在本阶段的体现 |
|---|---|---|
| 1 | 知识 + 状态都是纯文件 | 验证项 playbook 在 `cap-verify/checks/`;报告 / 状态在 `.cap/`——任何 caller 不靠技能机制也能跑 |
| 2 | STATE 单写者;并行写各自文件 | 多验证项产物各写各的 `verify/<check>-report.md`;**只有调度层汇总后写一次 STATE**,防 fan-out 竞态 |
| 3 | 流程平台无关;编排是加速器不是依赖 | 多验证项可 fan-out,无并行则串行(§0.2);所有提问用编号文本(§0.1);核心只需 Read/Edit/Bash/Grep + git |
| 4 | 目标仓内维护 `.agents/skills/cap-*` 符号链接 | 由 cap-flow / cap-map 维护,Codex 仓库内可发现本阶段 |

> journey 验证项依赖 Playwright MCP;**无该 MCP 的环境**(纯 Codex)→ journey 的 Web / App 模态降级为"人工
> 旅程检查清单 + 截图描述",在报告标 PARTIAL / INFERRED,不假装 TESTED(见 journey.md)。这不影响 logic /
> model,它们零 MCP 依赖。

---

## 7. 一次完整 verify 的动作清单

1. [ ] 确认入口条件(§1):build 已 green,或单项点名,或现状审计。
2. [ ] **Step 1**:`git diff` → 读 `role-routing.md` → resolve 出 active checks(logic 必在内)。
3. [ ] **Step 2**:架构漂移自检(编号文本告警,不阻断)。
4. [ ] **Step 3**:logic 先跑;再按需跑 journey / model(并行或串行)——各读各 playbook 照做;实现 bug
       **escalate 回 build**,不在此偷改实现;单问题 ≤3 次不解即 escalate。
5. [ ] **Step 4**:读各报告 result → 汇总阶段总判定(PASS / gated / blocked)。
6. [ ] 核对出口门控(§4)全过。
7. [ ] 输出 `## HANDOFF` 并回写 STATE.md(§5,单写者),快照 active checks / roles / changed-files,写 next action。
8. [ ] 向用户报告:本轮跑了哪些验证项、各自结果、阶段总判定、下一步(→ review / 回 build / 回 shape)。
