# intake —— 需求集合的建立与维护（cap-flow 内联能力）

这是 cap-flow 编排器的一组**内联能力**,不是独立技能。它把两类东西收进一棵**递归需求树**:业务侧零星
冒出来的需求,以及一个待重写老系统的全部功能点。目的是让需求**不丢、可归类、覆盖度可观测**,并派生出
一个**就绪队列(ready-queue)**供 `/cap loop` 消费。

> **在生命周期里的位置**:需求树是**项目级**产物(和 PROFILE 同类,长寿、不属某个单特性)。从树里选中一片叶
> 之后,cap-flow 会**另起**一条单特性 STATE,从 `shape` 阶段起跑主线。需求树与单特性 STATE 互相解耦、互不覆盖。
>
> **边界**:这里只管"需求集合"。收敛单条需求成 spec = `cap-shape`;拆任务 = `cap-plan`;自治调度循环 = `/cap loop`。
> 知识与状态全在纯文件,引擎 = 一个能 Read/Edit/Bash/Grep 的模型。

## 可移植约定

- **交互**:凡需用户拿主意(确认骨架草案、归类二义、选主分类),默认用纯文本编号列表,不硬依赖富交互控件。
- **并行**:批量 Ingest 可一需求一分支起草,各写各的叶文件;无并行能力就串行。**任何时候不得两个写手同写
  同一叶文件或同一 `_index.md`**(单写者)。

---

## 1. 数据模型（事实源 = 叶 frontmatter）

### 1.1 树的存储（文件系统递归镜像）

数据落在**目标项目**里,不在本技能仓:

```
<target-repo>/.cap/requirements/
├── _index.md                 # 派生产物:覆盖 burndown + ready-queue 快照(随时可重建)
├── <domain>/
│   ├── _domain.md            # domain 元信息(老系统模块映射 + 新系统归属)
│   └── <subdomain>/
│       ├── _subdomain.md     # subdomain 元信息
│       └── <leaf-id>.md      # 一条具体需求(叶)
```

- **递归**:subdomain 下可再嵌 subdomain(`domain→subdomain→…→leaf`)。
- **每叶一个文件** → 单写者友好、git 可 diff、并行 Ingest 不互锁。
- **`_index.md` 是派生产物**,不是事实源;事实源永远是各叶的 frontmatter,`_index.md` 可由脚本随时重建。

### 1.2 叶 schema（`<leaf-id>.md` frontmatter，10 个必填字段）

```markdown
---
id: <domain>.<subdomain>.<slug>          # 全局唯一,与文件路径一致
title: <一句话需求>
domain_path: <domain>/<subdomain>        # 主分类(唯一)
cross_link: []                           # 次分类:跨 subdomain 时挂多父
old_system_ref: <老系统模块/页面/接口/故事编号>   # 迁移视图之一
new_domain_path: <新系统归属,可与 domain_path 不同>  # 迁移视图之二
status: captured                         # captured → shaped → planned → built → verified → shipped
priority: P2                             # P0 | P1 | P2 | P3
depends_on: []                           # 其它叶 id,构成依赖 DAG
risk_level: medium                       # low | medium | high
updated: <date>
# —— 以下 4 个为可选交叉视图字段(生成器填;非必填,存量叶不填仍 lint clean) ——
actor: <参与者/角色>
failure_class: <funds|consistency|compliance|experience>
contract_refs: []
data_owner: <数据真相源>
---

## 需求描述
（原文 + 澄清后的意图）

## 验收线索
（怎么算这片叶 done 的初步线索;正式验收在 cap-shape 阶段细化）

## 老系统行为参照
（old_system_ref 指向的实际行为，供重写对齐）
```

**双视图**:`old_system_ref`(老系统怎么做)和 `new_domain_path`(新系统归到哪)同时记——覆盖图既能按老系统
盘"迁完没",又能按新架构组织(重写不必 1:1 移植)。

**多父**:`domain_path` 唯一(主分类),其余归属写 `cross_link[]`;lint 会查"同一 `old_system_ref` 出现在多叶"的重复。

### 1.3 ready-queue 契约（对外稳定面）

```
由 `scripts/intake.py readyqueue` 派生,写入 _index.md 的 ready 段:
[
  { leaf_id, title, priority, deps_resolved: true, old_system_ref, risk_level, status },
  ...
]   # 就绪 ⟺ 自身 status != shipped 且 depends_on 全部 shipped(或为空)
    # 按 priority 升序(P0<P1<P2<P3),同级按 id 排序
```

`/cap loop` 只依赖这个结构,不依赖树的内部存储细节。终态 `shipped` 的回写由 **Retire 操作**(§6)负责,
ready-queue 据此自动解锁下游叶。

---

## 2. Seed —— 老系统 → 骨架

**何时**:启动一个老系统重写,先把"有哪些域 / 模块"立成骨架,再往里填需求。

**行为**(只建骨架,不造叶):

1. 与用户对齐 domain 划分(编号文本给草案让其增删改)。
2. 建 `<root>/<domain>/<subdomain>/` 目录,写 `_domain.md` / `_subdomain.md`,各记:老系统对应模块、
   新系统预期归属、一句范围说明。
3. **不自动造叶**——空 subdomain 就是"待覆盖清单",后续靠 Ingest 填(Coverage 会把空 subdomain 高亮成"未迁功能")。

**纪律**:只立结构、不臆造需求。拿不准某模块归哪个域就问,不硬塞。

## 2b. Generate —— 从代码逆向出带叶的树

Seed 建空骨架靠人 Ingest;Generate 更进一步:**分析已有代码库 → 自动产出带叶的需求树**,打通"已有项目 →
树 → 看板 → 选叶起特性"的闭环。这是**判断性的 agent 工作**(像 cap-map 那样读代码),机械落盘交给脚本。

> **产物用途 = PM 与业务对齐**,所以主轴必须业务可读。

**主轴与叶**:

- **主轴 `domain_path` = 功能 / 用户故事**:domain = 功能域(入驻 / 商品 / 订单 / 结算…),叶 = 业务可读的
  用户故事「作为<角色>,我要<能力>,以便<价值>」。
- **禁用工程术语命名叶**(不叫"实现 OrderService.settle()",叫"运营能对已履约订单发起结算");工程细节只进
  `## 老系统行为参照` 或交叉字段,不进标题。
- **叶粒度自适应**:一条可独立交付的用户故事;内部可用状态跃迁辅助定粒度(让 `depends_on` 天然无环),但
  不主导标题;每域叶数软上限约 12,超了就合并或上提 subdomain。
- **status 推断只是代码完整度的草稿猜测,不是生命周期真值**:空实现 / TODO → `captured`;实现了但有缺口 →
  `built`;完整实现 + 有测试 → `verified` 封顶(**不要给 `shipped`**——是否上线代码里看不出来)。推断值在
  预览 / 落盘时**显式标为草稿**,靠人逐域校正,不可当权威。

**输入**(不重造分析轮子):先读 `<target-repo>/.cap/PROFILE.md` 的 surface-map(无 PROFILE 就先跑 cap-map);
再深读 `contracts/`(OpenAPI)、模块子目录、`db/schema`、`CLAUDE.md` / `docs`。

**运行 = 两阶段并行**:

1. **归纳域列表**(单趟,便宜):从 surface-map + 业务线索归纳功能域骨架;可先给人审一眼再 fan-out。
2. **fan-out**:一功能域一分支,各自深读该域代码 → 产该域用户故事叶,**各写各的草稿** `<tmp>/gen/<domain>.json`,
   互相隔离(避免锚定)。无并行能力就串行。
3. **合并**(单写者):跨域去重 + 跨域 `cross_link` + 跨域 `depends_on` 保无环 + 每域叶数上限 → 一份 merged JSON。
   - **规范化门(落盘前必做)**:fan-out 的原始输出常不严格合 schema——逐叶规范化:`priority ∈ {P0..P3}`;
     `domain_path` 斜杠分隔且 ≥2 级;`new_domain_path` 是域路径非代码路径;`failure_class` 若存在须合枚举;
     `contract_refs` 须为 list。不合规就地修或回退该叶,否则落盘后 lint 必挂。
4. **人审预览(硬门)**:渲染成看板(§4.5)让人剪枝 / 改 / 确认。
5. **落盘**:`python3 scripts/intake.py write-tree --root <root> --from <merged.json>`(机械写叶,已存在跳过)→
   `lint` 必须 clean。

**降级**:无 PROFILE 且用户不想 map → 仅从顶层结构 + contracts 粗生成、标 PARTIAL;推断不出某交叉字段就留空。

---

## 3. Ingest —— 散点需求 → 叶

**何时**:业务侧冒出一条需求,或从会话线索 / 老系统某行为,要把它归一条进树。

**行为**:

1. **归类**到 `domain→subdomain`:命中已有 subdomain → 建叶;未命中 → 问"新建 subdomain 还是挂到最近的
   cross_link";跨多个 subdomain(二义)→ 让用户选**主分类**(写 `domain_path`),其余写 `cross_link[]`。
2. **建叶文件** `<domain>/<subdomain>/<leaf-id>.md`,`id` 与路径一致,填全 §1.2 的 10 字段:`status` 默认
   `captured`;`priority` / `risk_level` 询问或默认 `P2` / `medium`;`old_system_ref` 尽量填;`updated` 用 caller
   传入日期。
3. 需求原文写进 `## 需求描述`,老系统行为写进 `## 老系统行为参照`。
4. 批量 Ingest 可并行(各写各叶)。

**纪律**:一条需求归一片叶(主分类唯一);拿不准就问,别把一条需求拆成多叶(lint 会抓重复)。

---

## 4. 派生操作（Ready-queue / Coverage / Lint / set-status / Tree / Board）

这些是**机械、确定性**的派生,由 `scripts/intake.py`(纯标准库)承载,避免每次用易错的 ad-hoc grep。
**事实源永远是叶 frontmatter**,脚本只读派生、不改树。下文 `<root>` = `<target-repo>/.cap/requirements`。

### 4.1 Ready-queue

```
python3 scripts/intake.py readyqueue --root <root>
```

输出 §1.3 的就绪队列 JSON(按 priority 排序)。`/cap loop` dequeue 下一片来跑;也可写进 `_index.md` 的 ready
段作快照(快照非权威)。

### 4.2 Coverage —— 迁移 burndown

```
python3 scripts/intake.py coverage --root <root>
```

按顶层 domain 输出 `{total, by_status:{...}}`。看重写迁到哪了;空 subdomain = 老系统里还没 Ingest 进来的功能。

### 4.3 Lint —— 树的正确性门

```
python3 scripts/intake.py lint --root <root>
```

报问题并以非 0 退出码标记:① 断依赖(depends_on 指向不存在的 id)② 重复(同 old_system_ref 出现在多叶)
③ 缺字段(10 必填缺任一)④ 孤儿(叶不在 `<domain>/<subdomain>/` 形态下)⑤ 非法 status ⑥ 非法交叉字段。
lint 只报不修,清单交用户决策。这是需求树的正确性门。

### 4.4 set-status —— 机械改叶 status

```
python3 scripts/intake.py set-status --root <root> --leaf <id> --to <status>
```

把指定叶的 `status` 机械改为目标值(须合法枚举:captured→shaped→planned→built→verified→shipped)。只校验
目标合法,不查迁移合法性(可前进可回退)。这是叶生命周期同步的共享写原语,主要由两处自动调用:

- **post-checkout git 钩子**(硬层):切分支时把在飞特性源叶的 status flush 落盘。
- **cap-flow 入口对账**(软层):叶 status 落后于 STATE.stage 映射值时补齐(只前进)。

稳态(captured / shipped)落盘持久;过渡态平时由看板惰性叠加显示,离开特性时由钩子 / 对账 flush。

### 4.5 Tree / Board —— 全貌视图

```
python3 scripts/intake.py tree  --root <root>              # 整树嵌套 JSON(agent 视角)
python3 scripts/intake.py board --root <root> [--out ...]  # 自包含 HTML 看板(人看 + 对话编辑)
```

- **tree**:整棵树导成 `domain→subdomain→leaf` 嵌套 JSON + summary,供 agent 一次拿全貌。只读。
- **board**:渲染自包含 HTML 看板(内联 CSS/JS,离线可开):左侧三级折叠树(叶卡带 status / priority / risk /
  依赖 + 每域覆盖进度条),右侧选中叶的详情 + 对话面板。看板只读,改树仍由 agent 经 Edit / move 落地(守单写者)。

**起服**:把看板输出复制为 `index.html`,放到 `cap-flow/references/web-review/server.py` 同目录,`python3
server.py <port>` 绑 127.0.0.1 开页。要实时对话就让 agent 切入 `/wait` 监听循环(present → await → act →
reply → re-arm,细节见 `web-review/playbook.md`)——agent 阻塞 `/wait` 期间会占住会话,一次只一个活跃渠道。

> 这等于给需求树补一道人看 + 对话可编辑的审阅门:树渲染出来给人审,选叶看详情,聊天里直接让 agent 改 / 迁 / 补。

---

## 5. Move —— 叶迁域

**何时**:一片叶归错了域,或评审中决定把它移到另一个 `domain/subdomain`。

```
python3 scripts/intake.py move --root <root> --leaf <leaf-id> --to <domain>/<subdomain>
```

**行为**(确定性写):① mv 叶文件到目标目录;② 改 frontmatter 的 `id`(= `<目标域>.<slug>`)与 `domain_path`;
③ 改写全树中指向旧 id 的 `depends_on` 引用(防断依赖)。**幂等守卫**:目标已存在同 id → 拒绝、非 0 退出、不动
文件;源叶不存在 → 非 0。

**纪律**:迁域只动归属,不改需求语义;跨域二义(既属 A 又属 B)用 `cross_link` 而非 move。

---

## 6. Retire —— 特性退场 / 收尾

**何时**:一个单特性走到 `stage=done`。cap-flow 在入口检测到 `STATE.stage==done` 时触发进来,给完成的特性
收尾。这是需求集合在生命周期**末端**的职责,与"选就绪叶起特性"(开端)首尾呼应。

**四步**(确定性部分 = `scripts/intake.py retire`;判断性部分 = 模型蒸馏):

| 步 | 动作 | 谁做 | 适用 |
|---|---|---|---|
| ① 归档 | `.cap/{spec.md,plan.md,verify,review,STATE.md}` → `.cap/archive/<date>-<slug>/` | 脚本 | 全部特性 |
| ② 回流 | 从 `STATE.Decisions log` 蒸馏耐久决策 / 教训 / 新风险成一行,append `.cap/EVOLUTION.md` | 模型蒸馏 + 脚本追加 | 全部特性 |
| ③ 标 shipped + 写叶记录 | 源叶 `status=shipped` → ready-queue 自动解锁下游;若传了 `--evolution-entry`,同条也 append 进该源叶的 `## cap 记录` 段 | 脚本 | 仅源自需求树的特性 |
| ④ 清栈 | STATE.md 随①移走 → 顶层留空,交还给下个特性 | 脚本 | 全部特性 |
| ⑤ 吐带标签数据点 | 组装本特性的 labeled datapoint,经 harvest-experience 的 `record_experience` 吐进中心 KB(见下) | 模型组装 + MCP 调用 | 有 MCP 时;无则跳过 |

```
python3 scripts/intake.py retire --cap <target>/.cap --slug <feat> --date <YYYY-MM-DD> \
  [--leaf <leaf-id> --req-root <target>/.cap/requirements] \
  [--evolution-entry "<蒸馏出的一行>"]
```

**确定性 vs 判断性**:文件移动 / 标 shipped / 追加 = 脚本。**"哪些决策值得回流" = 模型判断**——判据:跨特性
仍成立的架构 / 契约决策、踩过的坑、新发现的风险才回流;一次性实现细节不回流。

### 步⑤ 带标签数据点(飞轮适应度函数的原料)

脚本①–④ 收完尾后,cap-flow 在退场编排层**组装一条完整的 labeled datapoint** 并经 harvest-experience 的
`record_experience` 吐进中心 KB。**每片 shipped 叶天然产出一条**——eval F1 基准集 = 这些数据点的累积,不是从零
单独搭的数据集。字段:

```
intent          # 叶意图(叶 title + spec 目标)
predicted_files # 来自 plan 的整体预测面(cap-plan §7 的 Predicted files 汇总块)—— 预测
changed_files   # 真实 git diff --name-only(本特性分支相对分叉点)—— 真值
verify_verdict  # logic / journey / model 各 check 的通过判定(来自 .cap/verify/*)
review_verdict  # review gate = PASS / findings(来自 .cap/review/ + cap-gate)
owner           # 叶的人类归属(当初 shape/plan 拍板的人)
runner          # 谁执行的:人跑=<operator>,无头/夜间=night-factory(见 headless-policy.md §3)
leaf_id         # 源叶 id(无需求树的特性可空)
repo_url        # 与注入时同源(repoTail 不变量,否则归因静默断裂)
session_id      # 会话标识
```

- **predicted vs changed 是关键一对**:predicted_files(plan 时的预测)对 changed_files(退场时的真值)打文件预测
  F1——这是"接入 KB/经验后模型预测有没有变准"的**适应度函数**,也是并行分支 A/B 测 skill 变体的第一把尺。
- **组装 = 模型判断 + 读文件**:脚本不碰 MCP;数据点由编排层读 plan / git diff / verify / review 汇总后经
  `record_experience` 吐出。字段**前向兼容**——server 现在忽略它不认识的字段不报错(见 `harvest-experience`)。
- **无 MCP → 跳过**:`record_experience` 不可用时跳过步⑤,①–④ 照做;数据点没吐不影响本地退场。

**回流去向**:`<cap>/EVOLUTION.md`(脚本统一 append,缺则建头)。PROFILE.md 不承载流水,仅留一行指针——
Evolution log 是无界流水、PROFILE 是有界快照,本性不同故分文件。这是长寿、可跨会话复用的演进记忆,区别于
archive(本地工件留存)。

> **与中心知识库的关系(两条出口,别混)**:①**教训**——EVOLUTION.md 是**本仓本地**的演进记忆;要让耐久教训
> **跨人复用**,退场后跑 `/cap evolve`(见 `evolve-loop.md`)经 `record_experience` 推进中心 KB。②**数据点**——
> 步⑤ 每片 shipped 叶自动吐一条 labeled datapoint(predicted vs 真实 diff + 判定 + 归因)进中心 KB,喂 eval F1
> 适应度函数。两者都走 harvest-experience 的 `record_experience`、都带 owner/runner 归因,但**教训是精炼的经验卡、
> 数据点是打分原料**,用途不同。本地 EVOLUTION 与中心 KB 并行:前者私有档案,后者团队共享池。

**降级**:无 `requirements/` 树、或特性非源自叶 → 跳过③,①②④照做。**幂等安全**:`archive/<date>-<slug>/` 已
存在 → 拒绝覆盖、非 0 退出、不动任何文件。

---

## 7. 出口 / 边界

- intake 操作不推进单特性 stage;它维护项目级需求树 + 特性退场。
- 选中一片就绪叶进入开发 → cap-flow 另起单特性 STATE(stage=shape),把该叶的 `id` / 需求描述 / `old_system_ref`
  作为 cap-shape 的输入。
- 特性 done → cap-flow 触发 Retire 收尾:归档 + 回流 + 标源叶 shipped + 清栈。
- 需求树的"正确性" = `scripts/intake.py lint` 干净。

**不做**:不收敛单条需求成 spec(cap-shape);不拆任务 / 不写测试 / 不写实现(cap-plan / cap-build);不把
`_index.md` 当事实源;Seed 不臆造需求;Ingest 不把一条需求拆成多叶。
