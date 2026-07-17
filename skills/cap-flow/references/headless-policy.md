---
title: 无头运行策略（unattended / 夜间自治的边界、隔离与降级）
scope: methodology                # 通用、跨语言、跨目标——不含项目特定值
applies-to: cap-flow(/cap loop) + build-loop.md §2/§4/§7   # loop 无人值守时加载;人跑时不激活
updated: 2026-07-09
---

# 无头运行策略 · headless-policy

> 这份卡是**数据,不是 skill**(与 `build-loop.md` / `collaboration-discipline.md` 并列)。回答一个问题:
> **`/cap loop` 在没人盯着的时候(夜间自治 / CI / 后台容器)怎么安全地一圈圈转,而不越界、不裸奔、不污染主干。**
> 人跑 loop 时本卡不激活(人就是闸);仅当 loop 以 headless 模式启动(无交互终端 / 显式 `--headless`)时按本卡收紧。

---

## 0. 核心原则:决策/执行阶段边界 = 安全脊梁

把 cap 的八个 stage 切成两半,headless 只碰后一半:

| 阶段段 | stage | 谁拍板 | headless 能否发起 |
|---|---|---|---|
| **决策段** | map · shape · plan | **人**(白天,CLI 交互) | **禁止**——headless 不得发起 |
| **执行段** | build · verify · review · release | 机器(可无人值守) | **允许**——按已获批 plan 执行 |

第一性原理:**headless 只执行已获批的意图,绝不发明意图。** map/shape/plan 是"决定要做什么 + 怎么算对";
一旦它们产出并经人批准,build→verify→review→release 就是"把已冻结的判断兑现成代码",这段可以无人值守。

- **cap-shape 的 HARD-GATE 在 headless 下一律判 STOP+gated**:遇到"需求需要人确认 / spec 未获批 / 出现二义"→
  不猜、不自批,标该叶 `gated`,记 STATE 待晨审,继续下一叶(§3)。**headless 永不代替人过 shape 的批准门。**
- **ready-queue 的入队前提**:只有 `status >= planned`(spec 已批 + plan 已拆)的叶才允许被 headless 取用。
  `captured` / `shaped` 但未 `planned` 的叶 → 不是 headless 的活,跳过留给白天人跑决策段。

---

## 1. 分支 + PR 隔离协议(产物永不碰 main)

headless 的产物**必须**落在隔离分支上,经 PR 交人晨审,**绝不 commit / push 到 main**。这是"晚上额外产出"
之所以安全的结构基础——夜里跑错了,最坏也只是一条待关的 PR,主干始终干净可发布。

**每叶进 build 前(§build-loop.md §2 取叶后立即)**:

```bash
git fetch origin
git switch -c cap/<leaf-id> origin/main      # 从最新主干切;分支名 = cap/<叶 id>,天然可追溯到源叶
#   或用 worktree 并行隔离(见 collaboration-discipline.md §4):
#   git worktree add ../<repo>-cap-<leaf-id> -b cap/<leaf-id> origin/main
```

- 该叶内循环的**所有提交**落 `cap/<leaf-id>` 分支;`main` 只读(切分支的基),永不写。
- **收敛后开 PR**:oracle 通过(build-loop.md §4)+ release 完成后,开 PR 交晨审:

  ```bash
  git push -u origin cap/<leaf-id>
  gh pr create --base main --head cap/<leaf-id> \
    --title "cap(<leaf-id>): <叶 title>" --body "<intent + verify/review 判定摘要 + 数据点指针>"
  ```

- **`gh` 不可用 / 无推送凭据 → 优雅降级**:不阻塞、不硬试。把 **pr-intent** 写进 STATE(分支名 + 摘要 + head sha),
  留给晨审的人手动建 PR。headless 缺 PR 通道**永不使 loop 停摆**——分支已在,产物没丢。
- **多叶隔离**:串行 loop 一叶一分支,天然不撞;若开 worktree 并行(collaboration-discipline.md §5.4),
  各叶各 worktree + 各自 `.cap` 状态,收敛串行过一道集成闸。

---

## 2. 交互降级:headless 默认 + 记 STATE 待晨审

人跑 loop 时每个"回个编号"的确认点由人即时答;headless 无人可答,统一按下表降级——**能预设默认就走默认并记账,
必须人拍板的就 gated**:

| 确认点 | 人跑 | headless |
|---|---|---|
| cap-plan §6.4 定稿 plan 确认 | 人过目 | 前提已满足(叶须 `planned`,plan 早已人批);headless 不重开此门 |
| MISSING 项处置(cap-plan §6.1) | 人选 A/B/C | **不自选**——出现未覆盖需求 = 决策段漏洞 → 标 `gated` 记 STATE,下一叶 |
| 复杂度定级确认 | 人确认 | 用 plan 里已定级,不重定 |
| converge 缺口追加任务(build-loop.md §4) | 自动(本就无需人) | 同人跑,自动 |
| cap-shape HARD-GATE / 二义 | 人拍板 | **STOP+gated**(§0),永不自批 |
| 三振阻塞(build-loop.md §E5) | 人判 | 标该叶 `gated` 记 STATE,**跳下一叶**(§3) |

**原则**:凡 headless 遇到"本该人拍板"的点,一律**转成 `gated` + 一行 STATE 记录**(现象 + 卡在哪 + 建议),
让晨审的人一眼看懂为什么停,而不是猜或自作主张放行。降级路径**全走纯文本 + STATE 文件**,不引入任何富交互
控件依赖(守可移植铁律)。

---

## 3. runner 身份 + 归因(owner / runner 双字段)

headless 跑要能和白天人跑区分,以便 A/B 晋级时单独看机器自治产出的质量:

- **owner** = 叶子的人类归属(当初在 shape/plan 拍板的人;从叶 frontmatter / STATE 取)。
- **runner** = 谁执行了这轮 build→verify→review:人跑 = `<operator>`;headless 夜间 = `night-factory`(或配置的 bot id)。
- 两者都写进 STATE 顶层,并在退场时随数据点经 `record_experience` 一起吐出(见 intake.md §6 Retire + harvest-experience)。

> 为什么双字段:同一片叶,决策是人做的(owner),执行可能是机器(runner)。混成一个字段就分不清"这条经验/数据点
> 是人的判断还是机器自治产出"——而这正是 A/B 测机器改进效果时要切分的维度。

---

## 4. 停下就是安全:headless 的 fail-safe 默认

- **遇疑必停该叶,不猜**:契约 / 边界 / 需求之外受阻 → 标 `gated`,记 STATE,跳下一叶(对齐 collaboration-discipline.md §5.4
  "把猜改成停")。
- **产物隔离在分支**:任何一叶跑坏,回退只到该分支;main 不受影响。
- **wallclock 兜底**:除 max-iterations / queue-empty / blocker 外,headless 长跑设**墙钟上限**(build-loop.md §7),
  到点即停并回报已 ship / 剩余,防无人值守下失控空转烧资源。
- **晨审是唯一放行闸**:headless 只产出 PR + gated 记录,**不自 merge、不自发布**。是否并入 main、是否推开源仓,
  全部留给白天的人(对齐飞轮"人工闸"设计)。

---

一句话:**headless 只兑现已获批的意图(执行段),产物走分支+PR 永不碰 main,遇需人拍板的点一律 gated 记账跳下一叶,
runner 身份与 owner 分记——晚上安全地多产出,早上人来放行。**
