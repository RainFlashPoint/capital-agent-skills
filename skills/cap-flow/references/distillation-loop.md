# 蒸馏回路(Distillation Loop)—— 把复发经验沉淀进中心知识库

> 这份 playbook 是 **数据,不是 skill**。任何引擎(一个能 Read/Edit/Bash/Grep 的模型,Claude 或 Codex)
> 都能照着执行,不依赖任何运行时工具。
>
> **核心改锚(这是"真正是我们的"的一半)**:蒸馏的**最终出口是 capital-agent 中心知识库**——
> 通过 harvest-experience 的 `record_experience` 把复发经验推进 KB,带 **operator 归因**,让"某个人在某次
> loop 里踩的坑 / 悟到的套路"变成**全团队跨会话可复用**的资产。本地 `references/` 卡片仍是一个编译目标
> (就近可读),但护城河在共享 KB:越用越厚、跨人复用、可量化复用率。

---

## 0. 核心理念

cap-* 家族的知识(角色卡 / stage playbook / verify check playbook)不是一次写死的常量,而是 **被编译、
可增长的资产**。每当我们在一次 loop 里分析了一个新 repo、或实战中悟到一个更好的做法,就把可复用的方法
蒸馏出来,**沉淀进中心 KB**(并可就近追加进对应本地卡片),而不是新建散落文件、或让经验随会话蒸发。

两条洞察撑起这个回路:
- **知识应被编译一次、多次复用,而不是每次重新检索。** 中心 KB 就是这个"编译产物"——注入时(enrich_context)
  直接命中,不必每次重新爬。
- **别人的 skill / 别人的 loop 里隐含一套工作决策逻辑**(什么阶段做什么、什么条件走什么分支)。蒸馏就是把
  这套隐含逻辑显式化、去人格化,落成可执行的经验条目。

一句话目标:**让中心 KB 永远是"我们理解过、能直接注入复用"的版本,且随每个人的每次使用越来越厚。**

---

## 1. 何时触发(Triggers)

蒸馏是**人引导、按需触发**的(不自动归档,让贡献者决定)。下列场景应主动提示"要不要沉淀进中心 KB?":

| 触发场景 | 信号 | 典型来源 |
|---|---|---|
| 实战中发现更好的做法 | 某次 build/verify/review 里临场想出的检查清单、修复套路、踩坑 | 当前 session 的洞察 |
| 现有经验暴露缺口 | review/verify 时发现"这条 KB 没覆盖"、漏判了某类问题 | 失败复盘 |
| 复发 finding(★评审沉淀主入口) | 同类问题跨特性反复出现(见 §1.2) | cap-review 对抗 pass / 多角色评审 |
| 调研了一个新 repo / 框架 | 读完别家实现,抽出可复用方法 | 外部 repo |
| 新增语言 / 框架 / 模态 | 第一次碰到 Go / Rust / 移动端 / 新 E2E 工具 | 新项目接入 |
| 用户明确要求 | "把这个 pattern 沉淀进来"、"distill 这个"、"record 到 KB" | 显式指令 |

> 不触发:纯一次性脚本、与研发流程无关的领域知识、未经验证就想记的"猜测"(**先验证再记录**)。

### 1.1 来源:从跑过的 loop 复盘提炼(retro)

除了"分析外部实现",更应**从本系统自己的运行中学习**:

- **触发**:`STATE.stage=done`(一个 feature 走完整 loop 收口)后,或 build 调试 3-strike 后 → 可选跑一段轻量 retro。
- **★硬门(必须)**:**只有这个 session 真跑过 cap loop 才提炼** —— 即 `STATE` 存在且 `stage` 至少到过
  build/verify/review。半截 / 中断 / 没走流程的 session **不提炼**(否则是噪声 learning,污染 KB)。
- **提炼什么**:这次哪个 pattern 反复出现 / 哪里绊住了 / 哪类问题没覆盖 / 哪个修复套路值得固化。
- **去向**:走 §2 蒸馏 → §3 沉淀进中心 KB(带 operator),可就近追加进对应本地卡片。

### 1.2 来源:cap-review 复发 finding → 自动成经验(护城河主入口)

cap-review 的对抗 pass 与多角色评审里,**跨特性反复出现的同类 finding** 是最高价值的蒸馏原料——它证明
"这不是偶发,是团队系统性盲区"。此时:

1. cap-review 侧标出"复发"(同 `category` 跨 ≥2 特性命中)。
2. 走本 §2 把它蒸成一条可执行经验(检查项 / 修复套路 / 决策分支)。
3. 走 §3 `record_experience` 沉淀进中心 KB,`operator` = 该 finding 的贡献者,`intent` 写明"这类问题通常怎么防"。
4. 下次任何人开相关 loop,enrich_context 会把它注入 → 评审发现变成团队护城河。

---

## 2. 蒸馏流程(5 步)

```
新 repo / 实战洞察 / 复发 finding
    │
    ▼
① 深读源 ──── 读完整实现 / 完整 loop 上下文,不靠摘录
    │
    ▼
② 提炼 pattern ── 抽出"方法 / 检查清单 / 决策分支 / 状态机",去掉运行时与人格 fluff
    │
    ▼
③ 定位归处 ──── 判断这条 pattern 属于哪个 stage / 角色 / verify check(一条可落多处)
    │
    ▼
④ 沉淀 + 合并 ── 主出口:record_experience 推进中心 KB(带 operator);就近追加进对应本地卡片
    │
    ▼
⑤ 标记溯源 ──── 经验条目带 operator + repo_url(repoTail 不变量);本地卡片顶部维护来源行;防孤儿自检
```

### ① 深读源

- **读完整,不读摘录。** 外部实现读整篇 + 它引用的文件;实战洞察读整段 loop 上下文(STATE + 相关报告)。
- **先分类,再定深读维度。** 先判类型(工程项目 / agentic 项目 / 通用工具),不同类型值得抽的东西不同。
  对本系统额外问一句:**"这个源对应我们哪个 stage / 角色 / verify check?"**
- **识别并丢弃噪声**:别人实现里的运行时 preamble、特定二进制 / 子代理 / 目录约定、agent 人格
  (vibe / emoji / memory)→ 只取 mission / concerns,丢人格。

### ② 提炼 pattern(去运行时、去人格)

把源里**可复用的工作逻辑**显式化,目标产物是下面几类之一:

| pattern 类型 | 形态 | 落进哪种卡 |
|---|---|---|
| 方法 / 流程步骤 | 编号步骤、状态机、阶段门 | stage playbook |
| 检查清单 | 关注点 / 检查项 / "好的样子" / "常见翻车" | 角色卡 |
| 决策分支 | "什么条件走什么分支" | stage 或 verify check |
| 验证手法 | 具体跑法、证据 schema、门控阈值 | verify check playbook |

**可移植铁律(必须执行)**:凡蒸馏出的 pattern,都要把运行时依赖降级为 **纯文件 + git + 基础工具**:
- 结构化提问控件 → **纯文本编号列表**(让用户回数字)。
- 子代理并行 → **能并行就并行、不能就串行**(探测有无并行能力,没有就串行 inline)。
- 任何二进制 / node 工具 → 等价的 `Read/Edit/Bash/Grep` 步骤。

> 若一条 pattern 离开它的运行时就不成立,**不蒸馏**,记一句"该能力依赖 X,cap 暂不复刻"即可。

### ③ 定位归处(roles vs stages vs checks)

按"视角 vs 动作"两轴判断:

```
这条 pattern 是"视角/知识"还是"动作/流程"?
        │
   ┌────┴─────┐
   视角         动作
   │             │
   ▼             ▼
角色卡        是不是"一种验证"?
roles/<r>.md   ┌───┴───┐
              是       否
              │         │
              ▼         ▼
        verify check   stage 逻辑
        (logic/journey/ 内联进 cap-<stage>/SKILL.md
         model)
```

- **角色卡**(`roles/`):某职能视角"在意什么"。无动作 → 检查清单 / 关注点。
- **stage 逻辑**:内联在对应 `skills/cap-<stage>/SKILL.md`。某一步"我们怎么做" → 进度、门、状态机。
- **verify check playbook**(`cap-test/checks/`):某种验证手法。属于 logic / journey / model 三者之一 →
  跑法 + 证据 + 阈值。
- **role-routing.md**:若蒸出的是"什么改动该上什么角色 / check"的映射(新语言 glob、新模态)→ 追加进路由表。

> 一条 pattern 可落多处(如"安全审查"源 → server-dev 角色卡检查清单 + review 的安全门)。允许,但每处独立
> 写清、独立标溯源。**禁止**为一条 pattern 新建游离文件——必须挂进既有卡片体系,或进中心 KB。

### ④ 沉淀 + 合并

**主出口 = 中心 KB**(护城河)。用 harvest-experience 的 `record_experience`:

- `intent`:这条经验解决什么(一句有信息量的总结,不是 "fix bug" 空话;太短服务端会跳过)。
- `changed_files`:相关文件**路径**(只传路径,绝不传代码内容)。
- `repo_url`:当前仓库地址——**必须与注入(enrich_context)时同一个**,否则归因静默断裂(见 §5 repoTail)。
- `operator`:贡献者归因(谁悟到 / 谁踩的坑)。
- `session_id`:可选,会话标识。
- `experience`:必须显式提供 `problem / solution / conditions / counterexamples / evidence_refs / outcome`。没有结构化教训和验证引用时只允许进入 candidate draft，不能作为团队建议注入。
- `verify_verdict` / `review_verdict`:至少一项有明确 PASS，经验才能成为当前项目的 validated published 知识。

**就近合并进本地卡片**(可选、二级出口),照搬编译式合并纪律:
1. **合并、不覆盖**:融进目标卡对应 section,保留有价值旧内容。
2. **标矛盾、不裁决**:与已有说法冲突 → 加 `<!-- CONFLICT: 旧:… / 新:… -->`,留人决策。
3. **更新时间戳**:目标卡 frontmatter 的 `updated` 刷新为当天(stamp 由调用方传入,不硬编造)。
4. **保持精炼**:卡片是门面不是仓库,抽精华(方法 / 判据),别把源全文糊进来。
5. **交叉维护**:这条 pattern 若影响别的卡(改角色 → 路由表也加 glob),顺手更新关联卡。

### ⑤ 标记溯源

- **中心 KB 条目**:靠 `operator` + `repo_url` 归因——谁贡献、来自哪个项目。这是复用率统计与 F1
  proof-of-value 的锚点(见 `cap-test/checks/model.md`)。
- **本地卡片**:frontmatter 维护 `updated`;来源用稳定标识(外部 repo 用 `owner/repo`,实战洞察用
  `session:<topic>-<date>`),作为审计与防孤儿的锚点。

---

## 3. 产物去向(Where output lands)

| 蒸馏出的东西 | 落点 | 不该去哪 |
|---|---|---|
| 可复用经验(护城河主出口) | **中心 KB**(`record_experience`,带 operator + repo_url) | ❌ 让它随会话蒸发 |
| 职能视角 / 检查清单 | `references/roles/<role>.md`(就近二级出口) | ❌ 新建顶层 skill |
| 流程步骤 / 阶段门 | 内联进 `skills/cap-<stage>/SKILL.md` | ❌ 散落 md |
| 验证手法 / 阈值 / 证据 schema | `cap-test/checks/{logic,journey,model}.md` | ❌ 新建 verify skill(验证永远是 check,不是 skill) |
| 改动代码 → 角色 / check 的映射 | `references/role-routing.md` | — |
| 项目级架构事实(surface map) | 目标 repo 的 `.cap/PROFILE.md`(由 cap-understand 维护) | ❌ references/ |

**反膨胀红线**:蒸馏**永远不新增顶层 skill**。家族边界恒为 **1 driver(cap-flow)+ 7 stage + harvest**。
所有增长发生在中心 KB 与 `references/` 既有卡片里。验证类 pattern 一律进 verify check(数据),不 graduate 成 skill。

---

## 4. 防孤儿(Anti-orphan)—— 轻量 Lint

蒸馏最大风险是**写了游离文件 / 断链 / 没人引用**。每次蒸馏完跑一遍轻量自检:

| 检查 | 怎么查(Grep/Read) | 不通过的修法 |
|---|---|---|
| **无游离文件** | 新写的每个 `.md` 都必须被某处引用(被某 SKILL.md / playbook 读到、或被 `role-routing.md` 指向) | 没人引用 → 挂进既有卡,或删 |
| **路由闭环** | 新增 / 改名的角色卡、verify check 都在 `role-routing.md` 有对应 glob 入口 | 存在但无 glob 触发 → 补路由或说明"仅手动调用" |
| **反向引用** | `role-routing.md` 引用的每个角色 / check 文件都真实存在 | 路由指向不存在文件 → 断链,补文件或改路由 |
| **矛盾标记** | `grep -r "CONFLICT" references/` 列出待人决策的冲突,不自动裁决 | 汇总给用户 |
| **KB 归因完整** | 沉淀的经验条目有 `operator` + `repo_url`,且 repo_url 与注入侧一致 | 补归因;repo_url 不一致 → 修(否则闭环断) |
| **不空洞** | 新卡 / 新 section 不少于实质 5 行,不是占位符 | 补实质内容或不要写 |

> 自检遵循"不自动裁决矛盾"原则:发现冲突只标记 + 上报,由人定夺。

---

## 5. repoTail 不变量(归因不能静默断裂)

注入(enrich_context)与沉淀(record_experience)**必须锚在同一 `repo_url` 派生的 projectKey** 上。若两侧
repo_url 不一致(如一个用 git remote URL、一个用本地路径),中心 KB 会把它们当成两个项目——注入命不中、复用率
统计失真、F1 proof-of-value 断链。**规则**:整个 loop 里固定用同一种 repo_url 表达(优先 `git remote get-url
origin`),harvest-experience 首尾两次调用都用它。

---

## 6. 端到端示例

> 场景:cap-review 连续两个特性都命中"LLM 输出未校验就落库"(信任边界类 finding),判为复发。

1. **① 深读**:回看两次 finding 的上下文——都在 server 侧把模型输出直接写进 DB,没做 schema 校验。
2. **② 提炼**:抽成检查项 pattern("LLM / 外部 API 输出落库前必过 schema 校验 + 白名单字段")——纯知识,无运行时。
3. **③ 定位**:职能视角 → server-dev 角色卡"检查清单";同时是安全门 → cap-review 安全 10 域的"信任边界"域。
4. **④ 沉淀**:`record_experience(intent="LLM 输出落库前的信任边界校验套路", changed_files=[...], repo_url=<同注入>, operator=<发现者>)`;就近把检查项融进 `roles/server-dev.md`,刷新 `updated`。
5. **⑤ 溯源**:KB 条目带 operator + repo_url;本地卡片记 `session:trust-boundary-2026-07`。
6. **防孤儿自检**:server-dev 卡被 `role-routing.md` 的 `**/api/**` glob 触发 ✅;KB 归因完整 ✅;repo_url 首尾一致 ✅。
