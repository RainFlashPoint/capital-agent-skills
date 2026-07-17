# capital-agent-skills — 维护契约(给在本仓工作的 coding agent 读)

> 本文件被 Claude Code 自动加载;`AGENTS.md`(指向本文件)供 Codex 等读。
> **任何修改本项目的 agent,先读这里再动手。** 用户向导见 `README.md`;设计依据见 `docs/specs/`。

## 这是什么
一套自洽、可移植、纯文件的 cap 研发流程技能族。结构、用法见 `README.md`。核心:**Roles=职能视角(知识卡) / Skills=流程阶段**;验证类(journey/model)是 `cap-verify` 的 **check** 不是独立 skill。

## 三条不可破的铁律(改任何东西都要守)
1. **不新增顶层 skill**(除非是 cap 主线缺的真·生命周期阶段,如新增 release 那样的重大决策)。家族 = `cap-flow` driver(含 intake 需求树)+ **7 流程 skill**(map / shape / plan / build / verify / review / release)+ harvest-experience。新增能力优先走:职能视角→`references/roles/<r>.md`;验证手法→`cap-verify/checks/<check>.md`;语言→`references/languages/<lang>.md`;部署目标→`cap-release/targets/<type>.md`;流程纪律→`references/*.md`。**真要加流程阶段**=改 stage 枚举(driver + STATE 模板)+ driver 路由表 + 计数,慎重。
2. **可移植**:不硬依赖 Workflow / AskUserQuestion / subagent。交互用 text_mode(纯文本编号),并行用 Task-or-sequential 降级。必须在 Codex 下也能跑。
3. **纯文件 + 单写者**:知识/状态都是文件;`STATE.md` 单写者,并行产物各写各的。
4. **skill 约束"做什么/为什么/避哪些坑",不规定"怎么执行命令"**。流程 skill 是约束与原则,不是命令手册——别写死带一堆 flag/转义/shell 怪癖的 `find`/`grep`/`awk` 一行流(模型自己会写,写死只会脆、只会在某个 shell 崩)。把"坑"写成**原则**(如"统计大文件先排掉构建产物""别只扫根目录"),让模型自己选实现。例外:① `git diff --name-only` 这类**稳定且是契约输入**的单命令可留;② `references/languages/<lang>.md`、`cap-release/targets/<type>.md` 这类**参考卡**——它们的职责就是记录某语言/目标的具体 lint/test/build 命令,命令本身即交付物,保留。判据:这条命令是"流程怎么走"还是"某环境的具体工具调用"?前者→原则化,后者→留在参考卡。

## 怎么迭代(常见改动 → 要同步哪些地方)

| 改动 | 步骤(缺一即不一致) |
|---|---|
| **加一个角色卡** | ① 写 `skills/cap-flow/references/roles/<role>.md`(关注点/检查清单/好的样子/常见翻车/介入阶段)→ ② role-routing.md:§2 加触发规则 + §3 取值字典 + §5 自检 → ③ `templates/STATE.md` 角色取值字典 → ④ `cap-map` Phase C 角色字典 → ⑤ 跑 `scripts/validate-skills` |
| **加一个 verify check** | ① 写 `skills/cap-verify/checks/<check>.md` → ② role-routing.md §4 字典 + §2 触发 → ③ `cap-verify` 调度层引用 → ④ validate-skills |
| **加/改路由规则** | 只改 `references/role-routing.md`(它是改动→角色+check 的**单一事实源**);driver 只调用不内联 |
| **加一个流程阶段** | **慎重**(要改 stage 枚举:`cap-flow/SKILL.md` + `templates/STATE.md` + 各 skill)。一般别加,优先用角色/check 扩展 |
| **改 shape/plan/build 等流程** | 改对应 `skills/cap-<x>/SKILL.md`;保持 §0 可移植前置不动 |
| **加/改 intake 需求树派生操作** | ① 在 `scripts/intake.py` 加子命令 + `scripts/test_intake.py` 加用例(TDD)→ ② `cap-flow/references/intake.md` 加操作章节 + 顶部 op 枚举 → ③ 若涉及特性生命周期(如 Retire 在 done 触发):driver §2/§4 + `templates/STATE.md` 同步 → ④ validate-skills。**不新增 stage/skill**(派生 op 挂在 cap-flow intake 下) |
| **加/改 meta 能力(改工具自身)** | meta 能力(如 evolve 沉淀回流)**不新增顶层 skill**,用"角色卡 + playbook + driver 子命令"表达:`references/roles/skill-maintainer.md`(维护者视角)+ `references/evolve-loop.md`(回流 playbook)+ driver 的 `/cap evolve` 入口 + role-routing **R10**。小改走 `/cap evolve`(append-only),结构性大改对本仓跑完整 `/cap` |
| **改/扩 loop 编排** | loop(自治批量推进)同 evolve 范式:`references/build-loop.md`(playbook)+ driver `/cap loop` 入口,**不新增 skill、不进 STATE 枚举、只编排既有阶段**。往 `build-loop.md` append 一条原则(如 §E 蒸馏区)= 小改走 `/cap evolve`;改 loop 骨架/converge 契约 = 大改走完整 `/cap` |

## 每次提交前必做
1. **跑结构 lint**:`bash scripts/validate-skills`(角色名↔文件、check 名↔文件、frontmatter、引用一致)。**不过不提交。**
2. **更新 `CHANGELOG.md`** + 必要时升 `.claude-plugin/{plugin,marketplace}.json` 的 `version`(语义化)。
3. 行为变更 → 用 dogfood 验证(见下"测试")。

## 测试这套 skill(两层,markdown playbook 没法单测)
- **结构 lint(可重复回归)**:`scripts/validate-skills` —— 一致性/悬空引用/frontmatter。
- **行为 dogfood**:把某个流程 skill 真跑在一个**通用 fixture/真实项目**上,对照判据查产出(如 cap-map 产的 surface-map 是否过 Phase C 三条自检)。产出样例见 `examples/`。**别把内部项目产物 commit 进来**(`docs/dogfood/` 已 gitignore,只在本地跑)。

## 内容怎么"长大"(时用时新)
分析到新的好 pattern/项目 → 按 `skills/cap-flow/references/distillation-loop.md` 把可复用 pattern **蒸馏**进对应角色卡/check/阶段:主出口是中心知识库(`record_experience`,带 operator 归因),可就近追加进对应本地卡片。**蒸馏方法论,不搬代码、不引入运行时依赖。**

## 路径约定(给别的 agent)
跨 skill 引用的共享数据(role-routing / roles / templates / languages)**物理上只在 `skills/cap-flow/references/` 下**;verify 的 checks 在 `skills/cap-verify/checks/`;release 的 targets 在 `skills/cap-release/targets/`。解析共享数据时按"相对 skills 根的 `cap-flow/references/...`"定位,不要当作相对调用方 skill 目录。

## `.cap/` track 策略(二分)
`.cap/` 按生命周期二分,gitignore 用 `.cap/*` + `!` 反忽略实现(见 `.gitignore`):
- **在飞工作态**(顶层 `spec.md`/`plan.md`/`STATE.md`/`verify/`/`review/`)→ **本地忽略**(churn 不污染 git 历史)。
- **已完成 / 已蒸馏**(`archive/<date>-<feat>/` 退场归档 + `EVOLUTION.md` 演进流水 + `PROFILE.md` 项目记忆)→ **纳入 git** 跨机器/团队持久。退场(Retire op)是把前者转后者的那道闸。
- **Evolution log 独立成 `EVOLUTION.md`**(唯一正屋),PROFILE 仅留指针——无界流水不塞进每会话整篇加载的有界 PROFILE。
- ⚠ **隐私**:track 前确认 archive/EVOLUTION 无密钥——Decisions log 可能含敏感配置位置 / 内网地址 / token。有则先脱敏再入仓。
- 这是本技能族自身采用的**推荐约定**,各项目可自选 track 粒度。
