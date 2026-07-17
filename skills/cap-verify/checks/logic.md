---
check: logic
triggers: [always]   # logic 是基线验证项:任意 diff 都跑
produces: .cap/verify/logic-report.md
---

# 验证项:logic（正确性底座）

> 职责:把"应该能跑"变成"已用本轮真跑的命令证明能跑"。这是 cap-verify 的**基线验证项**——
> 任何改动都触发它,它绿了再谈旅程 / 质量才有意义。引擎 = 一个能 Read/Edit/Bash/Grep 的模型,
> 零运行时依赖,Claude / Codex 都能跑。

---

## 何时触发

- **always**:进入 cap-verify 时 logic 永远在 active checks 里(见 `cap-flow/references/role-routing.md`)。
- 单独点名:`/cap verify --check=logic`;或 cap-map 拿它做 brownfield 基线健康检查(baseline)。
- 与其它验证项叠加:改用户可见面叠 journey,改 AI / 策略叠 model;logic 永远是底座。

---

## 这个验证项在乎什么(五条关注点)

1. **证据,不是断言**——任何"通过 / 完成 / 修好了"必须挂本轮真跑出来的命令 + 输出 + exit code。
2. **覆盖到行为,不是覆盖到文件**——测试要打中"它做了什么",不是"它能 import / 能渲染"。
3. **三态诚实**——每条需求 / 验收点只能是 COVERED / PARTIAL / MISSING,不许把 PARTIAL 说成 COVERED。
4. **填测试不改实现**——verify 阶段写测试暴露 bug;发现实现 bug **escalate 回 cap-build**,不在这里偷改实现。
5. **数字门控**——覆盖率有明确阈值,达不到就 fail,不靠肉眼看百分比。

---

## 步骤流程

### Step 0 — 发现测试基建（runtime → framework）

先探测语言 / 框架 / 跑测命令。**确定语言后,test / 覆盖率门 / typecheck 的确切命令优先取
`<repo>/.cap/PROFILE.md` 的 `test-commands`**(cap-map 已登记);缺失再回退下面的通用探测。

```bash
# runtime 探测
[ -f pyproject.toml ] || [ -f requirements.txt ] && echo "RUNTIME:python"
[ -f package.json ] && echo "RUNTIME:node"
# 已有测试基建
ls pytest.ini pyproject.toml tox.ini 2>/dev/null
ls vitest.config.* jest.config.* playwright.config.* 2>/dev/null
ls -d tests/ test/ __tests__/ spec/ e2e/ 2>/dev/null
```

| runtime | 首选框架 | 跑单测 | 覆盖率 |
|---------|---------|--------|--------|
| Python  | pytest  | `pytest` | `pytest --cov=<pkg> --cov-report=term-missing`(pytest-cov) |
| Node/TS | vitest  | `vitest run` | `vitest run --coverage`(c8/istanbul) |
| Next.js | vitest + playwright | `vitest run` | `vitest run --coverage` |

- **检测到框架**:读 2-3 个现有测试文件学约定(命名 / import / 断言风格 / setup·teardown),**照抄约定,
  不凭文件名臆测**。
- **无框架**:bootstrap(装框架 → 建最小 config → 建目录 → 写 1 个真测试验证基建跑通)。bootstrap 失败就
  `git checkout` 回滚相关文件,记 BLOCKED,不假装有测试。
- 把跑测 / 覆盖率命令 / 阈值回写进 `PROFILE.md` 的 `test-commands` 供下次复用。

### Step 1 — 列出"必须被证明的行为"

来源(按优先级):`.cap/spec.md` 验收标准 → `.cap/plan.md` 任务的 acceptance_criteria → 本轮 `git diff`
改动的函数 / 分支。每条变成一行:`{ 需求 / 行为, 触发条件, 期望结果 }`。这是后面三态判定的清单。

### Step 2 — 分类每个改动文件（logic / journey / skip）

读文件确认,不靠文件名。

| 类别 | 判据 | 归谁 |
|------|------|------|
| **logic(单测)** | 纯函数 / 可写 `assert fn(input)==output`:计算、定价、校验、解析、数据变换、状态机、工具函数 | 本验证项 |
| **journey(E2E)** | 需浏览器 / 真实交互才能验:快捷键、导航路由、表单、选择、拖拽、弹窗、数据网格 | 交给 **journey 验证项** |
| **skip** | 无逻辑:纯 CSS / 样式、配置、胶水、迁移、纯 CRUD、类型 / DTO | 不写 |

> journey 类不在 logic 里跑,路由到 journey 验证项。logic 负责单测 + 集成 + 覆盖率 + 非浏览器真跑应用。

### Step 3 — 补齐测试（填测试，不改实现）

对每条 MISSING / PARTIAL 的行为补单测 / 集成测试:

- **AAA 结构**:Arrange(造触发该行为的精确前置状态)→ Act(执行暴露行为的动作)→ Assert(断言**正确
  行为**,禁止 `toBeDefined()` / "不抛异常"这种空断言)。
- 顺手把追溯到的相邻边界也测了(null、空数组、边界值)。
- **铁律:填测试时不许改实现文件。** 若测试暴露实现 bug:
  - 记一条 `⚠ 实现 bug:{现象} / 期望 {x} / 实际 {y} / 文件 {path}`;
  - **escalate 回 cap-build**(build 内的 TDD↔调试子循环修),logic 这一轮该需求标 PARTIAL;
  - 单条 bug 调试 ≤ 3 次迭代仍无解 → escalate,不死磕。

### Step 4 — 真跑：单测 → typecheck/build → narrow → manual（验证阶梯）

按这个**优先级阶梯**取证,上层够用就不必下探:

```
1. 已有测试(最可信,零成本)       → 跑全量 / 相关子集
2. Typecheck / Build(编译级)      → 注意:linter ≠ compiler,build 要单独跑
3. Narrow 直接命令检查(窄)        → 针对单个行为的最小直接验证
4. Manual / 交互验证(最后手段)    → 描述步骤 + 收集可观察证据;非浏览器场景的"真跑应用"
```

每步都**完整跑、读全输出、看 exit code、数失败数**(Gate Function,见下)。
非浏览器的"真跑应用"smoke:CLI(`--help` / 子命令 happy path)、server(起服务 + 打 health endpoint)、
库(import + 调一个公共入口)。

### Step 5 — 覆盖率门控（数字化）

跑覆盖率命令,对**本轮改动相关**的行 / 分支覆盖率与阈值比较:

| 语言 | 命令 | 默认门控 |
|------|------|---------|
| Python | `pytest --cov=<pkg> --cov-report=term-missing --cov-fail-under=<X>` | 行 ≥ 80%,关键模块分支 ≥ 70% |
| TS | `vitest run --coverage` + config `coverage.thresholds`(c8/istanbul) | lines/statements ≥ 80%,branches ≥ 70% |

门控规则(写进 PROFILE,可按项目调):
- **新增 / 改动代码**的行覆盖 < 阈值 → **FAIL**,回 Step 3 补测试。
- 用 `--cov-fail-under` / `coverage.thresholds` 让工具自己以**非零 exit code** 把关,别靠肉眼读百分比。
- 阈值是"门"不是"分":达标即过,不刷高分;纯样式 / 配置 / 迁移文件可在 config 里排除出分母。
- 阈值缺失时:默认 行 80% / 分支 70%。

### Step 6 — 三态判定 + 回归保护

对 Step 1 每条行为打三态:

| 状态 | 判据 |
|------|------|
| **COVERED** | 有测试,打中该行为,**本轮真跑 green** |
| **PARTIAL** | 有测试但 failing / 不完整 / 被 escalate 的实现 bug 阻塞 |
| **MISSING** | 没有任何测试 |

**COVERED 必须 = runs-green。** 没真跑过的、上一次跑的、"应该会过的"一律不算 COVERED。

修过 bug 的,写**回归测试**:
1. 学最近的 2-3 个同类测试,照抄风格(像同一个人写的)。
2. **追 bug 的 codepath**:什么输入 / 状态触发?走了哪条分支?在哪行断?相邻还有哪些输入命中同一路径?
3. 只跑这个新测试文件确认 green;带 attribution 注释(`# Regression: <id> — 什么坏了 / 发现于 <date>`)。

### Step 7 — 写证据报告

结果写进 `.cap/verify/logic-report.md`(schema 见下),供本调度层汇总。

---

## 门控（exit gates，必须全过才算 logic 通过）

- [ ] 测试基建已发现或 bootstrap 成功(否则 BLOCKED,不假装)。
- [ ] Step 1 每条行为都有三态判定,无遗漏。
- [ ] 全量 / 相关测试**本轮真跑**:0 failures(贴命令 + exit 0 + 通过数)。
- [ ] typecheck / build 真跑 exit 0(linter 过不算)。
- [ ] 覆盖率门控达标(工具以非零 exit 把关,不靠肉眼)。
- [ ] 无 COVERED 项是靠"应该过 / 上次过"判定的。
- [ ] 实现 bug 全部 escalate 回 cap-build,未在 verify 偷改实现。
- [ ] 修过的 bug 有回归测试且单独跑 green。

任一项不过 → 本验证项 result = `GATED` 或 `BLOCKED`,调度层汇总时 STATE.next 指回对应阶段(多为 build)。

---

## Gate Function（取证纪律）

```
在任何"通过 / 完成 / 修好"的措辞之前:
1. IDENTIFY  哪条命令能证明这个声明?
2. RUN       完整、全新地跑(不是子集、不是上次)
3. READ      读全输出 + 看 exit code + 数失败数
4. VERIFY    输出是否真的支持这个声明?
   否 → 报实际状态 + 证据
   是 → 报声明 + 证据
5. 才能说出口
跳过任何一步 = 说谎,不是验证。
```

**Iron Law:没有本轮新鲜验证证据,不得做任何完成声明。**

---

## 反合理化表（看到这些借口立刻 STOP）

| 借口 | 现实 |
|------|------|
| "现在应该能跑了" | 去跑验证命令 |
| "我很有信心" | 信心 ≠ 证据 |
| "就这一次" | 没有例外 |
| "linter 过了" | linter ≠ 编译器 ≠ 测试 |
| "覆盖率看着挺高" | 用 `--cov-fail-under` 让工具判,别肉眼读 |
| "agent 说成功了" | 看 git diff 独立验证 |
| "部分检查就够了" | 部分检查什么都证明不了 |
| "换个说法规则就不适用了" | 精神高于字面 |

红旗词:should / probably / seems to / "Great!" / "Perfect!" / "Done!" —— 出现在验证之前即违规。

---

## 好的样子

- 报告里每个 COVERED 都挂着本轮命令 + `34/34 passed` + `exit 0`。
- 覆盖率由 `--cov-fail-under=80` / `coverage.thresholds` 强制,输出里能看到工具自己 fail / pass。
- 发现的实现 bug 干净地 escalate 回 build,verify 的实现文件 0 改动。
- 每个修过的 bug 配一条会红绿验证过的回归测试,带 attribution。
- 三态清单完整,PARTIAL / MISSING 都写明缺口和下一步。

## 常见翻车

- 把"测试能 import / 组件能渲染"当作 COVERED(空断言)。
- 只跑改动文件那一个测试就宣布全绿,没跑全量 → 漏掉回归。
- 在 verify 里顺手改实现把测试改绿(应 escalate 回 build)。
- linter 过了就说 build 过(linter 不查编译)。
- 肉眼看覆盖率百分比,没让工具以 exit code 把关 → 阈值形同虚设。
- journey 类行为塞进 logic 硬跑,应路由到 journey 验证项。
- bootstrap 失败却继续,假装"已测试"——必须报 BLOCKED。
- 单条 bug 死磕超过 3 次迭代,不 escalate。

## 介入哪些阶段

- **verify(主场)**:logic 是基线验证项,每次都跑。
- **map**:被 cap-map 当 brownfield 基线健康检查调用,产出初始覆盖率 / 绿灯快照写进 PROFILE。
- **build(回流)**:暴露的实现 bug escalate 回 build 的 TDD↔调试子循环;修完再回 logic 复跑。
- **review 之前**:logic 全绿 + 覆盖率达标是进入 review 的前置门。

---

## 证据 schema：`.cap/verify/logic-report.md`

```markdown
# Logic Report: <feature/topic>
check: logic
updated: <stamp>
runtime: python | node-ts
test-commands: { unit: "pytest", coverage: "pytest --cov=app --cov-fail-under=80", build: "tsc --noEmit" }

## Summary
- result: PASS | GATED | BLOCKED
- tests: <pass>/<total> passed   (exit 0)
- coverage: lines <X>% (gate 80%) | branches <Y>% (gate 70%)  → PASS/FAIL
- build/typecheck: exit 0 | FAIL

## Requirement coverage (three-state)
| requirement / behavior | status | evidence (command + result) |
|------------------------|--------|------------------------------|
| <行为1> | COVERED | `pytest tests/x.py::test_a` → 1 passed, exit 0 |
| <行为2> | PARTIAL | 测试 failing:暴露实现 bug,已 escalate(见下) |
| <行为3> | MISSING | 无测试,建议路径 tests/y.py |

## Escalated implementation bugs (→ cap-build)
- ⚠ <现象> / 期望 <x> / 实际 <y> / 文件 <path> / 调试迭代 <n>/3

## Regression tests added
- <test file> — Regression: <id>,单独跑 green(exit 0)

## Coverage gaps / not verified
- <说明哪些没测到、为什么;非浏览器 smoke 用了什么手法>

## Gates
- [x] suite green (fresh)
- [x] build/typecheck exit 0
- [ ] coverage gate met
- [x] no impl changed in verify
- [x] regressions covered

## Next action
-> 覆盖率不达标,回 cap-build 补 tests/z.py  (或 -> cap-review)
```

---

## 可移植降级

- 全程只用 Read/Edit/Bash/Grep + git,无富交互控件 / 子代理 / 特定目录依赖。
- 需要用户决策时(如选测试框架)用**纯文本编号列表**让用户回数字,不硬依赖结构化提问控件。
- 无并行能力时(Codex)串行跑各步骤即可——logic 本就是单会话线性流程,无 fan-out。
- 所有产物落 `.cap/verify/logic-report.md` 纯文件 + STATE,任何 caller 不依赖 Skill 机制即可续跑。
