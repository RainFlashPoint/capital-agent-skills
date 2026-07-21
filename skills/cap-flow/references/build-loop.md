# 构建回路(Build Loop)—— 测试驱动的自治特性循环

> 这份 playbook 是 **数据,不是 skill**(与 `evolve-loop.md` / `distillation-loop.md` 并列)。任何引擎
> (一个能 Read/Edit/Bash/Grep 的模型,或 Codex)都能照着执行,不依赖任何运行时编排工具。
> 由 cap-flow 的 **`/cap loop`** 子命令入口加载。它**只编排**既有阶段(shape/plan/build/verify/review/release
> + 需求树 intake),**不重写**任何阶段的内部纪律。兑现需求树的"ready-queue → 批量喂给循环"。

---

## 0. 它解决什么

把"**人推一步、它走一步**"变成"**说一声开始,它自己一圈一圈转到队列干完**":
从需求树的 ready-queue 取就绪叶 → 自动跑完单特性主线 → 退场 → 取下一片。
**内核是 TDD**:每一步的"做完没"由**测试执行(ground truth)**判定,不靠模型自我感觉——agent 须每步从环境取真实结果,不接受"应该过了"。

核心认知:loop 不是新引擎,是**一根薄轴**。零件早已造好——
**工作源** = ready-queue(`intake.py`)· **发动机** = RGR(cap-implement)· **里程表** = STATE + 叶 status。
loop 只补两样:**这根编排轴** + **一盏完工检查灯(converge oracle,§4)**。

---

## 1. 何时用 loop(边界)

| 场景 | 走法 |
|---|---|
| `.cap/requirements/` 需求树已建、有多片 ready 叶要批量推进 | **`/cap loop`**(本 playbook) |
| 只做单个特性、要逐阶段把控 | 普通 `/cap`(手动单步),不进 loop |
| 无需求树 | 先经 cap-flow intake 建树派生 ready-queue,再 loop |

> loop **不绕过任何硬门**:review / 安全 open=0 / 覆盖率门一律照旧。loop 自动化的是"推进",不是"把关"。
> loop **不并发跑多特性**(同分支并行第二特性会 STATE 互覆盖,见 cap-flow §1.1);串行取叶,worktree 并行另见 `collaboration-discipline.md`。

---

## 2. 工作源:ready-queue(外层循环)

```bash
python3 <ik> readyqueue --root <root>   # <ik>=capital-agent-skills 仓 scripts/intake.py;<root>=<target-repo>/.cap/requirements
                                        # → JSON: 解依赖、按 P0<P1<P2<P3 排序的就绪叶(字段含 leaf_id / title / priority)
```

> **路径占位**:`<ik>`/`<root>` 沿用需求树约定——`<ik>` 由 cap-flow 按**安装路径解析**(目标仓通常**没有** `scripts/intake.py`),**不写死相对路径**(守可移植铁律)。

- **ready** ⟺ 叶 `status != shipped` 且其 `depends_on` 全部已 shipped(或无依赖)。
- 外层循环 = "队列非空就取队首叶"。loop **只依赖这个契约**,不碰树内部结构(需求树演进 schema 与 loop 消费 ready-queue 解耦)。
- 取到一片叶(队首)→ **起隔离分支** → 写 STATE(`source-leaf=<queue[0].leaf_id>` + `owner` + `runner`,§6;字段名是 `leaf_id`,Retire 据此回写源叶),进入单叶内循环(§3)。

> **分支隔离 + runner 身份(不内联,见 `headless-policy.md`)**:取叶后进 build 前起隔离分支 `cap/<leaf-id>`
> (从最新主干切,或 worktree),该叶所有提交落此分支,**产物永不碰 main**;收敛后开 PR / 留 pr-intent 交晨审。
> 同时按运行形态注入 `runner`:人跑 = `<operator>`,无头/夜间 = `night-factory`;`owner` = 叶的人类归属。二者写进
> STATE,退场时随数据点吐出(§5)。**无头模式下 `headless-policy.md` 的边界(决策段禁发起、HARD-GATE→gated、
> 交互降级)一并生效**——本 playbook 只述编排,无头收紧规则以那张卡为单一事实源。

---

## 3. 单叶内循环(复用既有阶段)

对取出的每片叶,跑标准主线——**loop 不重写这些阶段,只按序调用并在阶段间判定**:

```
shape(若该叶无 spec.md)   → 收敛需求 + 定 Done Criteria(§4 oracle 的判据来源)
  ↓                         AI 工作前置 eval rubric;UI 工作前置 design 契约(cap-define 既有纪律)
plan                      → 拆成扁平、可勾 [X] 的任务清单(cap-plan 既有纪律)
  ↓
build: 逐任务 RED→GREEN→verify   → 测试=ground truth(cap-implement RGR 内核,Iron Law 不破)
  ↓                              → 失败 → 系统化调试子环(三振升级)
verify(按改动 resolve check)     → logic/journey/model(cap-test;无新鲜证据不声称通过)
  ↓
review(多角色 + 安全 open=0 门)  → 写 cap-gate(cap-review;硬门一律不短)
  ↓
converge oracle(§4)            → 真做完没?没 → 回 build;做完 → release
  ↓
release → intake Retire          → 标叶 shipped、解锁下游(§5 checkpoint)
```

**关键**:plan 把任务拆成**扁平可勾清单**——这张清单本身就是本叶内循环的**进度账本**(§6),取一条→做→勾 `[X]`→取下一条。

> **loop 模式的状态转移(避免抢跑)**:converge(§4)是 **review-PASS 与 release 之间**的闸——**单叶只有 release 完成后才推进 `stage→done`**。故 cap-flow §2 的"`done` 前置 Retire"**不会在单叶半途触发**(converge 没过时停在 build/converge,`stage` 仍 in-progress);Retire 只在该叶 release 后、回 §2 取下一片前由 §5 显式触发。

---

## 4. converge oracle —— 完工检查灯(本特性新增的核心)

> 它是循环的**不动点检测器**,回答"这片叶**真做完没**"——而非"任务**划完没**"。
> 任务划完 ≠ 需求满足;oracle 防"清单勾完就误判交差"。

**输入**:本叶 `spec.md` 的 `## Done Criteria` + 本轮测试执行结果 + `intake.py readyqueue`。

**单叶通过判据**(三条全满足才算这片叶 done):
1. logic 全绿——真命令 + exit 0(ground truth,不接受"应该过了")。
2. 每条 Done Criteria 有对应证据(命令输出 / 测试 / 制品),逐条核对。
3. review gate = PASS(`cap-gate: PASS reviewed-head=<sha>`)。

**不通过**:列出**未满足的** Done Criteria → append 成新 build 任务前**先查重**(同一 Done Criteria 不重复追加)→ 回 build。**per-leaf 迭代上限(防内层死循环)**:同一缺口连续 **≥3 轮**仍未消除(无新鲜进展)→ 该叶 **gated**(三振升级)。

**gated 后怎么走(人跑 vs 无头有别)**:
- **人跑**:停下回报,交人判(默认行为)。
- **无头/夜间**:**不整队停摆**——标该叶 `gated` + 一行 STATE 记录(现象/卡点/建议)+ 保留其隔离分支,然后**回 §2 取下一片 ready 叶继续**。被 gated 的叶留给晨审的人处置。这样单叶阻塞不拖垮整晚产出。降级细则见 `headless-policy.md §2/§4`。

无论哪种,都**不无限内循环、不误判完成、不假装绿**。

**轻**:复用既有测试执行 + Done Criteria,**不新建脚本、不做跨工件大报告**。

**全局停止(防误判)**:`readyqueue` 空 **且** 无 unshipped 叶(`<ik> coverage` / `tree` 核对 unshipped=0)= **全局收敛 done**。
若 `readyqueue` 空但**仍有 unshipped 叶** → 不是完成,而是**依赖死锁 / 断依赖 / 全卡住**:跑 `<ik> lint` 报 deadlock → **gated**,停下回报,**绝不声称 done**。

---

## 5. checkpoint —— 每叶一个独立可交付增量

每片叶 = 一个**独立可测试、可交付**的增量。故 oracle 通过后**立即收尾该叶**,不攒一大批再统一验:

```
release(按 PROFILE.Deploy + targets,可跳)
  → python3 <ik> retire --root <root> ...        # 归档工件 / 标源叶 shipped / 回流教训到 EVOLUTION
  → 清 STATE 顶层(在飞态) → 回 §2 取下一片 ready 叶
```

这给 loop 天然的**提交/退场节拍**:一叶一 checkpoint,崩了也只回退到上一片叶。

---

## 6. 文件态 & 可恢复(状态在文件,上下文可丢弃)

长循环必然上下文膨胀。铁律:**进度只活在文件里,不靠对话记忆**——

| 载体 | 记什么 |
|---|---|
| `.cap/STATE.md` | 当前叶(`source-leaf`)/ stage / status / gates / Next action(cap-flow 单写者) |
| 叶 `status`(captured→…→shipped) | 该需求在树里的生命周期位(`intake.py set-status`,§5 retire 推进) |
| plan 任务清单 `[X]` | 本叶内循环的微进度账本(取一条→做→勾) |

→ 任意时刻崩溃 / `/clear` / 换 session,重进 `/cap loop`:读 STATE + 叶 status + 任务 `[X]` 即可续接,**无需重放上下文**。
**单写者**:仍只有 cap-flow 写 STATE;loop 串行取叶,无 fan-out 竞态。

---

## 7. 停止条件(baseline)

loop 不裸奔,须有明确停止条件。任一触发即停并用纯文本编号回报:

- **完成**:`readyqueue` 空 **且 unshipped=0** → 全局 done。(空队列但仍有 unshipped 叶 = 依赖死锁,判 **gated** 非 done,见 §4。)
- **达 max-iterations**:外层取叶次数封顶(防失控空转)→ gated,回报已 release/剩余。
- **wallclock 超时(无头长跑兜底)**:除取叶次数外,headless 设**墙钟上限**(如 N 小时);到点即停,回报已 ship / 在飞 / 剩余。防无人值守下失控空转烧资源。人跑通常不需要(人随时可中断)。
- **blocker**:某叶 review BLOCK / 测试基础设施挂 / 单问题 ≥3 轮无解(三振)→ 该叶 gated。**人跑**:停下回报,**不跳过、不假装绿**。**无头**:该叶 gated 记账 + 留分支,**跳下一叶继续**(§4;单叶阻塞不停整队,但绝不假装绿)。
- **架构漂移 / 边界串台**:cap-flow §1.1/§3.3 检测到 → 停下提示,不在串台态硬推。

---

## 8. 可移植

- 交互:所有提问用**纯文本编号**,不硬依赖结构化提问控件。
- 并行:loop 本质**串行取叶**(单写 STATE);worktree 并行另见 `collaboration-discipline.md §5.4`,非 loop 内置。
- 工具:核心只需 Read/Edit/Bash/Grep + git + `intake.py`。
- 无头/夜间自治:边界(决策段禁发起 / HARD-GATE→gated)、分支+PR 隔离、交互降级、runner 归因全在 `headless-policy.md`——本卡只述编排,无头收紧规则以那张卡为单一事实源。
- Codex:本卡纯数据,软链可发现,任何引擎照跑。

---

## E. 先进思路蒸馏区(逐条由 `/cap evolve` append)

> 下方每条各自标注**外部研究来源**(公开 agent-loop 研究),由 `/cap evolve` 以 **append-only** 落为 `### E#` 小节。索引:

- **E1 复述(recitation)** — Manus context-engineering
- **E2 失败写教训** — Reflexion
- **E3 自生成测试强化 oracle** — AlphaCodium
- **E4 可选外脑交叉验证** — Anthropic evaluator-optimizer
- **E5 停止 + ground-truth 收紧** — Anthropic building-effective-agents

---

### E1. 每圈复述 Done Criteria(recitation)

> 来源:Manus context-engineering(todo.md recitation / soft attention control)

长循环上下文会膨胀、目标会"中间遗忘(lost-in-the-middle)"。**每进入一片叶的内循环、每次回到 build 前**,先**重读本叶 spec 的 `## Done Criteria` + plan 未勾 `[X]` 任务**,把目标顶回注意力末端。

- 不是重新规划,只是**把目标 + 剩余项复述一遍**(soft attention control,无需特殊机制)。
- 复述源 = 文件(spec/plan),**不是对话记忆**——与 §6"状态在文件"一致;fresh-context 重进时,复述即自然恢复目标对焦。

---

### E2. 失败先写教训,下轮先读(reflexion)

> 来源:Reflexion(把失败转成自然语言反思,存 episodic memory 喂下一次尝试)

build 红 / converge 不通过 / 调试失败时,**先写一行根因教训**(经 DEBUG REPORT / `## HANDOFF` **交由 cap-flow 追加**进 `STATE.Decisions log`——守 §6 STATE 单写者,不自行写 STATE),**下一轮迭代开始先读本叶教训栈**再动手——让每次失败成为下次的输入,而非白费。

- 教训格式(一行,自然语言):`<现象> ← <根因> ⇒ <下次怎么避>`。
- 与 §E5 三振互补:**三振是"停",reflexion 是"把失败变成输入"**;三振封顶前,每次失败都先沉淀教训。
- 复用既有 cap-implement DEBUG REPORT + `STATE.Decisions log`,**不新建载体**。

---

### E3. converge 自生成边界测试强化 oracle(flow-engineering)

> 来源:AlphaCodium(public tests + AI-generated tests + test anchors;弱 oracle 放过真 bug)

converge(§4)的"测试全绿"不应**只**跑 plan 列出的测试——**额外生成边界 / 反例测试**(空值 / 越界 / 并发 / 错误路径 / 非法输入)再判收敛,否则弱 oracle 会让"看着绿、实则错"的代码通过。

- **测试锚点(test anchors)**:已绿的测试集是锚,消缺口改代码时**不得让任何锚变红**(防"改 A 坏 B")。
- **入既有载体**:自生成测试加入 **repo 正常测试集** + 记入 `.cap/verify/logic-report.md` 回归项,**不是一次性抛弃、不新建载体**。
- **时序(关键)**:这些测试在 **build/verify 阶段生成并跑绿(在 review 之前)**,使 review 覆盖到它们;converge(§4)只**核对**、不在 converge 阶段新增改动。**若 converge 后产生任何 repo diff(补测/补实现)→ 必须回 verify + review 刷新 `cap-gate reviewed-head`**,绝不带过期 gate 直接 release。
- 与 cap-test logic check **叠加**:logic 跑既有 + 本条补生成;证据要求不变(真命令 + exit 0,§E5)。

---

### E4. 可选外脑交叉验证(evaluator-optimizer)

> 来源:Anthropic building-effective-agents(evaluator-optimizer:生成器与评估器分离,独立判据更稳)

review / converge 处,**若另一引擎可用**(典型:跑在 Claude 上、本机装了 Codex;反之亦然),**机会型**调它**只读**复核本叶 diff 是否满足 Done Criteria、找主引擎漏掉的坑。

- **探测 → 调用 → 优雅跳过**三态:可用 + 已认证 + 非自调(别用 Codex 调 Codex)→ 只读复核;不可用 / 未认证 → 记一行建议安装,**直接跳过**。
- **缺席永不卡 loop**:外脑不可用 → 跳过、loop 照跑。在场时也只"加分"——**发现有证据的 bug** 走既有 review 门处理;仅当**未决分歧**(外脑与主引擎判断冲突且无定论)才进 §E5 人工 checkpoint,**外脑自身从不自动阻断**。
- **写成原则、不写死命令**:具体调用属"某工具调用",留实现层 / 参考卡(同 languages 卡待遇),**本流程卡只述原则**(skill 写"做什么/为什么",不写死脆 shell)。
- 本质 = **跨引擎对抗验证**:两个引擎对同一份代码独立判,分歧点亮给人,比单引擎自评更可信。

---

### E5. 停止与 ground-truth 收紧

> 来源:Anthropic building-effective-agents(agent 每步从环境取 ground truth + 必须有明确停止条件)

对 §7 baseline 的收紧:

- **每步 ground truth**:每个 RED→GREEN、每次 converge,结论必须挂**本轮新鲜的真实执行证据**(命令 + 输出 + exit code);**无新鲜证据,不声称通过 / done**(沿用 cap-test 纪律,在 loop 每步强制)。
- **三振升级细则**:同一问题(**同根因**,非同症状)连续 3 次未解 → 判**架构问题、非简单 bug**,该叶 **gated** 停下回报,**不第 4 次硬试**(对齐 cap-implement 三振 + §4 per-leaf 上限 + §E2 教训栈)。
- **人工 checkpoint**:max-iterations 达成 / 遇 blocker / 外脑(§E4)与主引擎结论冲突 → 用纯文本编号停下交人判,**不自动放行风险**。
