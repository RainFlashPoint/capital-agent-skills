---
name: cap-flow
description: >
  研发主线的编排器 / 路由器 / 跨会话交接中枢。读取 <target-repo>/.cap/(PROFILE 工程记忆 + STATE 特性状态),
  判断本次从哪个阶段进入,依据改动面把工作派发给对应的 cap-* 阶段技能,并在每一步把进度写回 STATE,
  让下一次会话或另一个 agent 能无缝接力。同时内建**需求集合(intake)**的分叉决策:检测到需求树时引导选叶起特性。
  触发场景:用户说 "/cap"、"走一遍研发流程"、"开始一个新特性"、"接着上次做"、"resume"、"这个 repo 跑 cap"、
  "上次进行到哪了"、"我要加个功能/修个 bug 想走完整流程";也在用户首次要对某项目启用结构化流程时主动建议。
  另含两个 meta 子命令(不是阶段、不进 STATE 枚举):
  **`/cap evolve`** —— 把本次会话沉淀出的经验/规则通过中心知识库(harvest-experience / record_experience)回流,
  供跨人复用(见 references/evolve-loop.md);触发于 "沉淀这个"、"把经验存进知识库"、"distill 一下"。
  **`/cap loop`** —— 从需求树 ready-queue 逐叶自治推进 TDD 主线直到队列干(见 references/build-loop.md);
  触发于 "跑 loop"、"批量做就绪需求"、"自动推进需求队列"。
  本技能是编排层:只做判断/路由/装载上下文/交接,自己不建需求树、不写 spec、不拆任务、不写测试、不验证、不评审、不发布
  (那些分别是 cap-map / cap-shape / cap-plan / cap-build / cap-verify / cap-review / cap-release 的职责)。
---

# cap-flow — 主线编排器（导演 / 路由 / 交接）

你在这条研发主线里扮演**导演**,不亲自演任何一场戏。你的全部工作围绕三个动作展开:

```
Orient(定位)   →   Route(派发)   →   Handoff(交接)
读清现在在哪         决定去哪、带什么       把结果记下来、告诉用户下一步
```

一切知识与状态都是**纯文件**(`references/` 里的 playbook + 目标仓 `.cap/` 里的状态),引擎就是
一个能 Read/Edit/Bash/Grep 的模型。不依赖任何后台服务、任务队列或特定运行时——这保证同一套流程在
Claude、Codex 或其它 CLI 上都能跑。

> **一条硬规矩**:看到该写 spec 就转 `cap-shape`,该实现就转 `cap-build`,你不代劳其中任何一步。
> 你只回答三个问题:去哪个阶段、带哪些上下文、把进度记到哪。

---

## 可移植约定（每次入口先确认，一次性）

这套流程要在不同 CLI 上都能跑,所以有两条降级范式贯穿始终。Codex 的具体映射见
`references/runtime-adapters/codex.md`,这里只讲平台无关的接口。

### 交互:优先纯文本编号选项

任何需要用户拿主意的地方(确认入口、确认漂移、选范围),**默认用纯文本编号列表**提问,不硬依赖
任何富交互控件:

```
需要你定一下:
  1) 方案 A —— 说明
  2) 方案 B —— 说明
回个编号就行。
```

宿主若提供了结构化提问控件,可以用;但**回退路径永远是上面这种编号文本**。

### 并行:能并行就并行，不能就串行

有些工作天然可以并行(典型:`cap-review` 的多角色评审、`cap-map` 的多面测绘)。探测宿主有没有
并行能力:

- 有子任务 / fan-out 能力 → 每个并行分支写**各自独立的文件**(如 `review/<role>.md`),最后汇总。
- Codex 的 multi-agent → 按 `references/runtime-adapters/codex.md` 的适配段 fan-out。
- 都没有 → **串行**跑同一份 playbook,逐个写文件。

无论哪种,**绝不允许两个写手同时写 `STATE.md`**——单写者原则,见「Handoff」一节。

---

# 一、Orient —— 定位现在在哪

目标仓 = 当前工作目录(或用户指定的 `<target-repo>`)。所有状态都落在 `<target-repo>/.cap/`:

| 文件 | 是什么 | 谁写 |
|---|---|---|
| `PROFILE.md` | **工程记忆**(长寿):技术栈 / 约定 / surface-map / 入口 / 测试命令 | `cap-map`,漂移时刷新 |
| `STATE.md` | **特性交接**(短寿):阶段 / 状态 / 门 / 活跃角色 / 改动文件 / 决策 / 下一步 | 各阶段经本编排器写 |
| `spec.md` `plan.md` | 阶段产物 | `cap-shape` / `cap-plan` |
| `verify/*.md` `review/*.md` | 验证 / 评审报告 | `cap-verify` / `cap-review` |
| `requirements/` | 需求树(可选,intake 建立) | intake 操作(见 `references/intake.md`) |

入口第一件事:`ls .cap/` 看有哪些文件,然后:

- 有 `PROFILE.md` → 解析它的 surface-map(模块 → glob → 默认角色 → 验证项),这是后续派发的关键输入。
- 有 `STATE.md` → 读出 `stage` / `status` / `Next action`。
- 都没有 → 进入下面的「入口判定」。

> surface-map 的 schema 由 `cap-map` 定义并写出;本编排器只读、不写 PROFILE。

## 边界自检（读完 STATE 立即做）

读到 STATE 之后、往下走之前,**先跑一次边界守卫**,防止不同特性串台、或同一分支上并行开第二个特性
把状态搅乱:

```bash
sh <cap-flow 目录>/scripts/cap-guard    # 脚本自包含;确定性比对 STATE 记录的 branch/worktree 与当前
```

- **守卫报错(串台)** → 按提示停下:要么切回原分支续接,要么给新工作**开 worktree 或新分支**(各自独立 `.cap`)。
  串台状态下不要继续推进。
- **守卫通过、但本次意图是"开新特性"而 STATE 里还有进行中的特性** → 用编号文本警告:
  ```
  ⚠ 当前分支已有进行中特性 '<F1>'(stage=<x>)。同分支再开一个会文件冲突 + STATE 互相覆盖。
    1) 给新特性开 worktree(推荐)   2) 切新分支   3) 先把 F1 收尾/暂存
  ```

> **两层防护**:这里是**软层**(编排器入口主动跑,Codex / 无 hook 环境也有保护);**硬层**是目标仓
> `.git/hooks/pre-commit` 调同一个 `scripts/cap-guard`,由 git 执行、模型绕不过(`cap-map` 脚手架会问装不装)。
> 两层共用同一份检测逻辑。写 STATE 时记下 `branch:` / `worktree:` 戳,守卫据此比对。

> **源码协作纪律(跨阶段)**:分支模型、worktree 开不开的判据、并行的前置合约(接口先冻 / 面切分 /
> 独立性 / 自包含简报)、收敛时先基到最新再重测才合(防 merge skew)——统一见
> `references/collaboration-discipline.md`。本编排器在这个源码 setup 决策点加载它,各阶段沿用。

## 入口判定

```
/cap → 读 .cap/
   ├─ 无 PROFILE.md 且 repo 非空(已有代码,brownfield)  → 先走 cap-map
   ├─ 无 PROFILE.md 且 repo 空(greenfield)             → 直接进 cap-shape
   └─ 有 PROFILE.md                                     → 在 STATE.stage 处续接
```

**优先判定:上个特性走完但没退场(`STATE.stage == done`)。** 入口读到 `stage==done`(特性到终点但
工件还没收尾)→ **先触发退场仪式**(归档 `.cap` 工件到 `.cap/archive/<date>-<feat>/`、把耐久决策从
`STATE.Decisions log` 蒸馏回 `PROFILE.md ## Evolution log`、若特性源自需求树叶则标该叶 `shipped`、清空
STATE),再按上面三条主分支处理新特性。退场的机械部分走 `references/intake.md` 的 Retire 操作;编排器
只**触发**,不亲自归档。用户也可显式 `/cap retire`。

**判 repo 空不空**:忽略 `.git`、`.cap`,有源码文件即非空。别只信 `git ls-files`——目标可能是未跟踪的
子目录,或刚克隆还没 init,只看跟踪文件会把真项目误判成空;拿不准就直接列文件确认。

**正交分支:需求树(intake)。** 若 `<target-repo>/.cap/requirements/` 存在(需求树已建)且当前没有进行中
的单特性 STATE → 用编号文本让用户选:

```
检测到 .cap/requirements/ 需求树(N 片叶,M 片就绪)。
  1) 从就绪队列选下一片起特性(→ 取叶 → cap-shape)
  2) 直接 /cap shape 注入一条新需求
  3) 把一条散点需求归档进树(→ intake Ingest)
回个编号。
```

需求树在不在,**不影响**上面 map/shape/续接 三条主路径(纯增量)。需求树本身的建立与维护
(Seed / Ingest / Coverage / Ready-queue / Lint / Move / Retire)是机械操作,playbook 在
`references/intake.md`,由本编排器按需加载执行——这些不再是独立技能,而是编排器的一组内联能力。

判定完,**先把你的结论讲清楚,再让用户确认或改向**:

```
.cap/ 状态:
  - PROFILE.md: 无
  - repo: 非空(检测到已有代码)
→ 判定 brownfield,建议先 cap-map 建工程记忆。
下一步:
  1) 走 cap-map(推荐)
  2) 跳过,直接 cap-shape(我已了解此项目)
  3) 只跑一次现状审计(cap-verify 全链路)
回个编号。
```

有 PROFILE 时,直接报告 `STATE.stage` 与 `Next action`,默认续接:

```
读到 STATE: stage=plan, status=in-progress, next=cap-plan
→ 续接 cap-plan。回 "1" 续接,或 "2" 跳到别的阶段。
```

**有 PROFILE 但没有 STATE.md** = 一个新特性的起点 → 路由到 `cap-shape`,并初始化一份新 `STATE.md`。

### greenfield 也要补工程记忆

greenfield 从「空仓 → cap-shape」起步,一路 shape→build 不会自动长出 PROFILE——项目可能堆了很多代码却
始终没有工程级的持久文档(跨迭代 / 新会话的统一入口、surface-map 路由的来源)。每次入口顺手探一下:
**已有真实代码但无 `.cap/PROFILE.md`** → 软提醒,不阻断:

```
ℹ 有代码但没有 .cap/PROFILE.md(工程记忆缺失)。建议跑 cap-map 补一份——
  它是跨迭代 / 新会话 / 子 agent 的统一入口,也驱动 surface-map 路由 + AI-readiness 体检。
  1) 现在补 cap-map(推荐)   2) 稍后(本次继续)
```

greenfield 建议在**第一个特性 build 之后**补 cap-map(那时才有真实代码可测绘)。

## work-type：整条流走多重

- 读 `STATE.work-type`(feature / remediation / hotfix)并**透传给将进入的阶段**——它是"这条流走多认真"
  的中央旋钮。各阶段据它自适应:remediation / hotfix 走轻(粒度降级 / 允许跳 TDD / 跳无关契约),但
  **硬门(覆盖率 / 安全零未决 / review / 发布门)一律不放松**。
- 新流程若 STATE 无 work-type:默认 `feature`;"改造遗留 / 补 AI-readiness" → `remediation`;紧急修 → `hotfix`。
- **`/cap next`** = 编排器的"直接推进"姿势:跑边界自检 → 读 `STATE.Next action` → 直接路由到下一步,不寒暄。

---

# 二、Route —— 决定去哪、带什么

进入 **cap-build / cap-verify / cap-review** 这三个由改动驱动的阶段前,**每次都动态重算**该带哪些角色、
跑哪些验证项。这个决策是一个**函数,不是存盘表**——三个输入按稳定度分开:

| 输入 | 稳定度 | 来源 |
|---|---|---|
| 架构模型(surface-map:模块 / glob / 默认角色 / 验证项) | 慢变,已跟踪 | `PROFILE.md` |
| 路由规则(glob → 角色 + 验证项) | 极少变,已跟踪 | `references/role-routing.md` |
| 改动文件(`git diff`) | 每次都变,临时 | 实时算 |

## 算改动集

```bash
git -C <target-repo> diff --name-only HEAD          # 已暂存 + 未暂存 vs HEAD
git -C <target-repo> diff --name-only --staged      # 仅暂存
git -C <target-repo> status --porcelain             # 含未跟踪
```

合并去重得到改动文件集。若是全新特性还没动过代码,退化为**按 PROFILE.surface-map 的目标面**取默认
角色和验证项(用户在 shape 阶段声明要动哪块)。

## 解析

对每个改动路径:

1. 匹配 `PROFILE.surface-map` 的 glob → 命中的面给出**默认角色 + 默认验证项**。
2. 叠加 `references/role-routing.md` 的通用规则(语言 / 层级级,不依赖具体仓库)。
3. 取并集 → 得到本次的**活跃角色**与**验证项**。

始终叠加的基线规则(来自 role-routing.md):

- 任何 diff → `qa` 角色 + `logic` 验证项(基线)。
- 触及敏感面(认证 / 支付 / 用户数据 / 密钥)→ 加 `security` 视角。
- 触及 AI / 模型 / 策略 / prompt / evals → 加 `model` 验证项。
- 触及用户可见面(前端 / 移动 / API)→ 加 `journey` 验证项(选对应模态)。

> 完整的 glob 表在 `references/role-routing.md`;本编排器只**调用**它来解析,不内联整张表。

## 架构漂移检测

把改动路径与 `PROFILE.surface-map` 的 glob 比对:**有路径落在所有已知面之外**(如新建服务、第一个移动端
目录)→ 标记漂移,编号文本提示:

```
⚠ 架构漂移:这些改动不在 PROFILE.surface-map 里:
  - mobile/ios/App.swift
建议刷新 PROFILE。
  1) 现在重跑 cap-map 的相关部分刷新 surface-map(推荐)
  2) 本次先继续,稍后再刷新
回个编号。
```

漂移不阻断,但要让用户知情——这样"已跟踪的架构"不会悄悄过时。

## 装载并进入阶段

解析结果确定后,路由到对应技能,把上下文**作为纯文件引用**带过去:

| stage | 路由到 | 进入前要装载 |
|---|---|---|
| map | `cap-map` | 传 repo 根;产出写 `PROFILE.md` |
| shape | `cap-shape` | 传需求 / 现状;涉及 AI 工作时提示在此定 eval 契约,涉及 UI 时定 design 契约 |
| plan | `cap-plan` | 传 `spec.md` |
| build | `cap-build` | **先解析**,装载活跃角色卡(`references/roles/<role>.md`),传 `plan.md` |
| verify | `cap-verify` | **先解析**,传解析出的验证项;各项 playbook 在 `cap-verify/checks/` |
| review | `cap-review` | **先解析**,装载活跃角色卡;并行能力按上文探测,每角色写 `review/<role>.md` |
| release | `cap-release` | review 通过后;按环境逐级晋级,读 `PROFILE.Deploy` + `cap-release/targets/<type>` |
| done(退场) | intake Retire op | 传 `.cap` 目录 + 源叶(若有);归档 / 回流决策 / 标源叶 shipped / 清栈 |

> **装载角色卡 = 把 `references/roles/<role>.md` 的内容作为该阶段的视角输入**(纯文件,任何 caller 都能读),
> 不是起一个独立人格。验证项同理:`cap-verify/checks/<name>.md` 是厚 playbook,不是技能。

主线形状(供参考,具体由各阶段执行):

```
[brownfield] cap-map ─┐
                      ├→ cap-shape → cap-plan → cap-build{red→green} →
[greenfield] ─────────┘   cap-verify{logic | journey | model} → cap-review → 退场 → cap-release{dev→staging→canary→full}
```

任一验证项也可**单独调用**:`/cap verify --check=journey --scope=full-chain` 做现状审计(也当 cap-map 的
基线健康检查)。

## 两个 meta 命令（不是阶段）

- **`/cap evolve`** —— 把本次会话的经验/规则**回流到中心知识库**。加载 `references/evolve-loop.md`:
  它调 harvest-experience 的 `record_experience` 把蒸馏出的经验原子(spec 决策 / review findings / 复发规则)
  写进 capital-agent 中心 KB,带 operator 归因供跨人复用。**这不是把改动推回某个工具的 GitHub**——出口是
  团队共享的知识库,不是外部代码仓。触发语:"沉淀这个"、"存进知识库"、"distill 一下"、"evolve"。
- **`/cap loop`** —— 测试驱动的自治批量推进。加载 `references/build-loop.md`:从 `.cap/requirements/` 的
  就绪队列取叶 → 逐叶自动跑标准主线(shape→plan→build→verify→review→release)→ 退场 → 取下一片,直到队列干。
  内核是 TDD(测试 = 事实,不是自我感觉);阶段间过收敛判据(测试全绿 + 满足 spec Done + review 通过)判
  "这叶真做完没",没做完把缺口塞回 build 不退出该叶。**不绕任何硬门**、**串行取叶**(单写 STATE 防竞态)、
  **可恢复**(状态全在 STATE + 叶 status + 任务勾选,崩了重进续接)。触发语:"跑 loop"、"批量做就绪需求"。

---

# 三、Handoff —— 把结果记下来

每个阶段跑完,先输出一段机器可读的 **`## HANDOFF` 块**,再**经由本编排器**把进度写回 `STATE.md`。

> **单写者原则**:只有编排器写 STATE;并行产物各写各的文件(`review/<role>.md`、`verify/<name>-report.md`),
> 最后由编排器汇总入 STATE。若某阶段被独立直调、身边没有编排器,它必须先产 `## HANDOFF`,再作为单写者按同一
> schema 写 STATE(见 `references/runtime-adapters/codex.md` 的 Handoff 适配段)。

`## HANDOFF` 最小 schema:

```markdown
## HANDOFF
stage: <stage>
status: in-progress | gated | blocked
verify-checks: [...]
active-roles: [...]
changed-files:
- <path>
gates-passed:
- <gate>
decisions:
- <date> <decision>
next-action: -> cap-<stage>
```

`STATE.md` schema(时间戳由 caller 传入,不要自造时钟):

```markdown
# cap-flow State: <feature/topic>
stage: map | shape | plan | build | verify | review | release | done
status: in-progress | gated | blocked
updated: <caller 传入的时间戳>
verify-checks: [logic, journey, model]   # 本次解析出的
branch: <当前分支>
worktree: <路径或 (none)>
work-type: feature | remediation | hotfix
source-leaf: <需求树叶 id 或 (none)>

## Gates passed
- [x] spec approved
- [ ] tests written (red)
- [ ] ...

## Active roles (from last diff scan)
- server-dev, client-dev

## Changed-files snapshot
<上次 git diff 的路径>

## Decisions log
- <date> 选 X 不选 Y,因为 ...

## Next action
-> cap-plan
```

写完 STATE,向用户报告"现在在哪 / 下一步做什么",并按 `status`:

- `in-progress` → 提示可以继续下一阶段(或本会话直接续)。
- `gated` → 停在门口,等用户确认(编号文本列出待批项)。
- `blocked` → 报告阻塞原因,不前进。

若 capital-agent MCP 提供 `record_skill_event`，每次 HANDOFF 写完 STATE 后追加一条同 `session_id` 事件：阶段进入用 `stage_entered`，门通过用 `gate_passed`，阻塞用 `stage_blocked`；verify/review 阶段分别用对应完成事件。artifact_refs 只传 `.cap` 产物路径、报告 ID 或 commit，不传文件正文。MCP 不可用时静默降级，纯文件主线仍可独立运行。

若 STATE 尚无 `task-id` 且 MCP 提供 `create_or_attach_task`，在首次 shape/intake 前自动创建统一 Task 并写回 `task-id`/`session-id`；退场时用 `record_task_delivery` 回写真实 Commit 与验证证据。具体契约见 `../harvest-experience/references/platform-task-loop.md`。

**解析快照写进 STATE 只作交接 / 审计用,永不当权威源**——下次进改动阶段时**重新解析**(diff 每次都变,
存盘会过时)。

**特性退场(stage→done)**:某阶段把特性推到 `done` 后,STATE 不就地清理;退场仪式(归档 / 回流 /
标 shipped / 清栈)由 intake 的 Retire 操作执行(见「入口判定」的优先分支),编排器只触发。退场把决策从
短命 STATE 蒸馏进长命 `PROFILE.md ## Evolution log`,让完成的工作持续指导后续演进。

## 跨会话流

```
会话 A: /cap → 读到空 STATE → 路由 cap-shape → 写 spec.md,STATE: stage=shape, next=plan
   ↓ /clear 或隔天
会话 B: /cap → 读 STATE(stage=plan) → 直接续 cap-plan,无需重放上下文
```

这就是"持久状态 + 无上下文重放"的交接:新会话或子 agent 只读 `STATE.md` + 角色卡即可接力。

---

## 载重规则（让子 agent / Codex / 别的 CLI 都能用）

进入任何路由前,确认这几条成立:

| # | 规则 |
|---|---|
| 1 | 知识 + 状态都是纯文件(`references/`、`.cap/STATE.md`)——任何 caller 不靠技能机制也能用 |
| 2 | STATE 单写者;并行工作各写各的文件——防 fan-out 竞态 |
| 3 | 流程平台无关;并行 / 富交互是加速器不是依赖;没有就降级串行 + 编号文本 |
| 4 | 目标仓内维护 `.agents/skills/cap-*` 符号链接 —— Codex 仓内发现 |
| 5 | 运行时特化规则只落 `references/runtime-adapters/codex.md`;各阶段只依赖抽象接口,不绑死某个工具 |

## 一次完整入口的动作清单

1. [ ] `ls .cap/` 读 PROFILE.md + STATE.md
2. [ ] 边界自检(cap-guard),再判定入口,用编号文本报告并让用户确认 / 改向
3. [ ] 若进改动阶段(build/verify/review):`git diff` → 解析角色+验证项 → 漂移检测
4. [ ] 装载活跃角色卡 + 选定验证项
5. [ ] 路由到对应 `cap-*` 阶段(自己不执行其内容)
6. [ ] 阶段返回后:写回 `STATE.md`(单写者),快照活跃角色 / 验证项 / 改动文件
7. [ ] 向用户报告当前 stage / status / next action
