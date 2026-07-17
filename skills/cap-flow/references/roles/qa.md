---
role: qa
triggers: ["**/*.test.*", "**/*.spec.*", "e2e/**", "tests/**", "__tests__/**", "any-diff (baseline)"]
---

# QA 角色卡（质量保证视角）

> 这是一张**知识卡**，不是流程。它定义"以质量保证的专业眼光看，什么重要"。
> 它的**活动**（跑套件、覆盖率门控、写回归测试）落在 verify 阶段的 logic / journey 模式里。
> QA 是**每次 diff 都加载的 baseline 角色**——任何改动都至少过一遍 QA 视角。

## 关注点

QA 的核心立场：**不证明它行，就当它不行。** 默认"还没做完 / 还有问题"，要求证据来推翻这个默认值。

1. **覆盖的是 codepath，不是文件** —— 每一个新增/修改的**分支**（if/else、try/catch、guard、early-return、三元、switch）都要有对应测试覆盖**真**和**假**两条路。文件级"有测试"不算数。
2. **负路径优先于正路径** —— happy path 谁都会写；错误分支、拒绝、非法输入、权限"被拒"的那一支，才是 bug 真正藏身处。负路径缺测 = 最高优先级缺口。
3. **用户旅程 ≠ 代码覆盖** —— 一条没测的用户流程（点击→校验→请求→成功/失败屏）和一个没测的 if/else 一样是缺口。要从路由 / OpenAPI paths / PRD / diff 反推真实用户怎么触碰这段代码。
4. **回归是最高优先级** —— 改了既有行为、旧测试没覆盖到改动路径、给既有调用方引入新失败模式 = 回归。回归测试**无条件加**，因为它证明"有东西坏了"。
5. **测试本身的健康** —— 隔离、确定性、不 flaky。一个会偶发失败、依赖时钟/时区/真实网络/执行顺序的测试，是负资产。
6. **测试装置先于结论** —— 在相信"测试通过/失败"之前，先确认测试装置没坏（能跑、断言非平凡、覆盖率工具真在统计）。绿灯如果来自空断言，比红灯更危险。

## 检查清单

### A. 覆盖追踪（逐 codepath）
- [ ] 对每个改动入口（route handler / 导出函数 / 事件监听 / 组件 render），跟数据流：输入从哪来 → 谁变换它 → 去哪 → 每步能出什么错（null/undefined、非法输入、网络失败、空集合）。
- [ ] 每个条件分支两侧都有测试（true **和** false）。
- [ ] 每个错误处理器都有一个**触发该错误条件**的测试。
- [ ] 被调用的 helper 如果自己有分支 → 那些分支也要测。
- [ ] 用质量 rubric 给每条覆盖打分（见"好的样子"），不是只数"测了没"。

### B. 负路径 / 边界（红队心态）
- [ ] 错误分支、拒绝、非法输入、guard/early-return —— 有失败路径测试？
- [ ] 边界值：0、负数、max-int、空字符串、空数组、单元素集合（off-by-one）、null/nil/undefined。
- [ ] Unicode / 特殊字符在用户输入里。
- [ ] 权限/认证检查 —— 有"被拒绝(denied)"那一支的测试？
- [ ] 攻击 happy path：10x 负载？同资源并发请求？慢 DB(>5s)？外部服务返回垃圾？
- [ ] 静默失败：吞异常的 catch-all、部分完成（5 件处理了 3 件就崩）、失败时留下不一致状态、无人告警的后台任务。
- [ ] 信任假设：前端校验了但后端没校验？内部 API 假设"只有我们调"就不鉴权？用户输入拼路径/URL 不消毒？

### C. 用户旅程 / 交互边界
- [ ] 每条主要用户流程（多步）有 E2E/集成测试走通整条？
- [ ] 交互边界：双击/快速重提、操作中途离开（后退/关页/跳走）、陈旧数据提交（session 过期）、慢连接(API 10s 用户看到啥)、并发（两个 tab 同表单）。
- [ ] 用户可见的错误态：是清晰报错还是静默失败？用户能恢复（重试/返回/改输入）还是卡死？
- [ ] 空/零/边界态 UI：0 结果？10000 结果？1 字符？最大长度？

### D. 测试隔离 / 反 flaky
- [ ] 没有测试间共享可变状态（类变量、全局单例、未清理的 DB 记录）。
- [ ] 没有顺序依赖（随机化执行顺序仍通过）。
- [ ] 不依赖系统时钟 / 时区 / locale。
- [ ] 不打真实网络（用 stub/mock）；随机测试数据有 seed 控制。
- [ ] 没有"sleep / 紧 timeout 的 waitFor / 断言无序结果顺序"这类定时脆弱点。

### E. 工具 / 类型选择
- [ ] 用 E2E/集成还是单测，按决策矩阵判（见下）。
- [ ] 安全敏感面（auth/authz/限流/输入消毒/CSRF/CORS）有对应的"被拒/被挡"测试。
- [ ] 数字化覆盖率门控：行/分支 ≥ 阈值（shape 阶段定，default 行 80% / 分支 70%），否则 fail。

### 单测 / E2E / EVAL 决策矩阵
| 选 | 何时 |
|----|------|
| **单测** | 纯函数（清晰输入→输出）；无副作用的内部 helper；单函数的边界（null/空数组）；冷门非用户面流程 |
| **E2E/集成** `[→E2E]` | 跨 3+ 组件/服务的常见用户流程；mock 会掩盖真实失败的集成点（API→队列→worker→DB）；auth/支付/数据销毁这类太重要不能只靠单测 |
| **EVAL** `[→EVAL]` | 关键 LLM 调用需质量评估；prompt 模板 / system 指令 / 工具定义的改动 → 交给 verify 的 model 模式 |

## 好的样子

**覆盖质量 rubric（每条覆盖都用它评级，不是只看红绿）：**
- ★★★ 测了行为 **+ 边界 + 错误路径**
- ★★  测了正确行为，**仅 happy path**
- ★   smoke / 存在性检查 / 平凡断言（"it renders"、"不抛异常"）—— **基本等于没测**

- 覆盖报告以 **ASCII 覆盖图** 呈现：代码路径 + 用户流程并列，每条标 `[★★★ TESTED — file:line]` / `[GAP]` / `[→E2E]` / `[→EVAL]`，底部给 `COVERAGE: x/y (z%) | QUALITY: ★★★:n ★★:n ★:n | GAPS: n`。
- 回归测试**像同一个开发者写的**：设置触发 bug 的精确前置状态 → 执行暴露 bug 的动作 → 断言**正确行为**（非"不抛异常"）→ 带 attribution 注释（`// Regression: ISSUE-NNN — {坏了什么} / Found by verify on {date} / Report: <path>`）。
- 有 **baseline 健康分**：本次跑分对比上次 baseline，明确列出"修复的 / 新增的 / 分差"。分数变差 → 显著 WARN。
- 每条结论都挂**证据**：失败用例的 file:line、截图（E2E）、实测覆盖率数字、报错堆栈。"零问题"是红旗——再看一遍。

## 常见翻车

| 翻车 | 表现 | 纠正 |
|------|------|------|
| **文件级假覆盖** | "billing.ts 有测试" 但只测了 happy path | 追到 codepath，每个分支真假两侧都要 |
| **只测 happy path** | 错误分支、guard、catch 全裸奔 | 负路径优先；红队心态主动找 |
| **平凡断言充数** | 一堆 ★ smoke test 凑覆盖率数字 | 用 rubric 评级，★ 不算真覆盖 |
| **flaky 测试当通过** | 偶发失败被无视 / 加 retry 掩盖 | 修隔离/确定性，不靠 sleep 和重试 |
| **改实现去配测试** | verify 阶段为了让测试绿，改了被测代码 | **铁律：填测试不许改实现**；发现实现 bug → escalate 回 build，不在 QA 阶段偷改 |
| **跳过测试** | "这个先 skip 掉" | No-skip 铁律：要么写，要么按矩阵明确判 EVAL/不可测并记录理由 |
| **回归被当新功能跳过** | 改坏了旧行为却没补回归测试 | 回归无条件加，标 CRITICAL，说明坏了什么 |
| **幻想通过(fantasy approval)** | "98/100 production ready" 无证据 | 默认 NEEDS WORK；证据不压倒就不放行 |
| **测试装置坏了还信结论** | 空断言/覆盖工具没统计仍报绿 | 先验证装置（oracle/nop 自检），再信红绿 |
| **mock 太狠掩盖集成失败** | 全 mock 的"集成测试"实际啥都没集成 | 关键集成点判 [→E2E]，少 mock |

## 介入哪些阶段

| 阶段 | QA 视角做什么 |
|------|--------------|
| **shape** | 为"怎么算 done"提前定可验证的验收判据；AI 工作的 eval rubric / 数据集 / 阈值在此前置（交 model 执行）。 |
| **plan** | 审 plan 的测试覆盖：逐 codepath 追踪，标 GAP，把缺的测试**作为 plan 任务补进去**（不是事后补丁）；识别回归点标 CRITICAL。 |
| **build** | TDD 红灯阶段把关——测试是否真覆盖分支、是否含负路径、断言是否非平凡。 |
| **verify（主场）** | 跑 logic 模式（套件 + 覆盖率门控 + baseline 对比）；驱动 journey 模式（用户旅程 + 截图报告）；发现 bug → 写回归测试 → escalate 回 build 修实现。 |
| **review** | 作为 review 的 testing 专家维度：缺负路径 / 隔离违规 / flaky / 覆盖缺口逐条出 finding（severity + confidence + path:line + fix）。 |

---

## verify-check playbook：QA 在 verify 阶段的可执行流程

> 角色卡是视角；下面是该视角在 verify 阶段落地的 playbook。logic 模式总是跑；journey 模式在用户面改动时跑（多模态见 `checks/journey.md`）。

### 何时触发
- **logic**：每次进 verify 都跑（baseline 角色）。
- **journey**：diff 触及用户面（前端/移动/API）时；scope = feature / iteration / full-chain。
- **model**：diff 触及 AI/模型/策略时，交 `checks/model.md`（QA 只负责把 spec 定的 rubric/阈值接过来）。

### 步骤流程
1. **探测框架**（语言无关）：读 PROFILE.test-commands；没有则从仓库探测（pytest/coverage、vitest/playwright/tsc）。检测不到 → 仍产出覆盖图，跳过自动生成测试。
2. **bootstrap baseline**：先跑现有全量套件 + 覆盖率，记录 baseline 健康分（首跑则建 baseline）。
3. **逐 codepath 追踪**（检查清单 A）：对 `git diff` 的每个改动入口画执行图，列出所有分支/错误路径/用户流程。
4. **比对现有测试**（检查清单 B/C/D）：每条分支/流程找覆盖，按 ★ rubric 评级，标 `[GAP]` 与 `[→E2E]/[→EVAL]`。
5. **覆盖率门控**：行/分支覆盖率 < 阈值 → **fail**，列出未覆盖行。
6. **补缺 / 修 bug**：
   - 缺测 → 按决策矩阵补测试（**不改实现**）。
   - 发现实现 bug → 写回归测试复现 → **escalate 回 build** 修实现，不在 QA 阶段偷改实现。
7. **回归测试纪律**（发现 bug 时）：追 bug codepath（精确前置 / 走哪条分支 / 哪行断的 / 还有哪些输入会命中同路径）→ 写测试（设前置→执行→断正确行为→顺手测相邻边界）→ 带 attribution 注释 → 只跑新测试文件 → 过则提交 `test(qa): regression test for ISSUE-NNN`，2 分钟内搞不定则 defer。
8. **回归对比**：跑完对比 baseline，输出"修复的 / 新增的 / 分差"；分数变差则显著 WARN。
9. **journey（若触发）**：选 scope → 反推用户旅程 → 分派 Web/OpenAPI/App 用例 → 执行 → 失败回 build 定位源码 → 出截图 test-as-report（详见 `checks/journey.md`）。

### 产物
- `.cap/verify/logic-report.md`：覆盖图 + 覆盖率数字 + baseline 对比 + GAP 清单 + 新增回归测试列表。
- `.cap/verify/journey-<scope>-report.md`（若跑 journey）：用户旅程 × 截图 × pass/fail × 失败源码定位。
- `baseline.json`（或等价）：本次健康分快照，供下次回归对比。
- STATE 更新：`checks` 解析结果 + 本阶段 gate 状态。

### 门控（exit gates，全过才放行到 review）
- [ ] 全量套件绿（无 skip 滥用、无 flaky 掩盖）。
- [ ] 行/分支覆盖率 ≥ 阈值（shape 定，default 80%/70%）。
- [ ] 改动 codepath 的每个分支真假两侧 + 负路径有覆盖（★★ 及以上）。
- [ ] 识别出的回归全部有回归测试且通过，标 CRITICAL 的已修。
- [ ] baseline 健康分未下降（下降必须有书面理由）。
- [ ] 实现 bug 已 escalate 回 build 修复（QA 未私改实现）。
- [ ] journey（若触发）：关键用户旅程全 pass，失败项已定位源码。
- **默认 NEEDS WORK**：以上任一缺证据即不放行。

### 证据 schema（每条 finding 一行，与 review 统一）
```json
{
  "severity": "CRITICAL | HIGH | MEDIUM | LOW | INFORMATIONAL",
  "confidence": 1-10,
  "path": "<file>",
  "line": <N>,
  "category": "testing | coverage | regression | flaky | isolation | negative-path | e2e",
  "summary": "<一句话问题>",
  "evidence": "<file:line | 覆盖率数字 | 截图路径 | 报错堆栈>",
  "fix": "<具体修法>",
  "test_stub": "<可选：建议的测试骨架>",
  "fingerprint": "<path:line:testing>"
}
```
无 finding → 输出 `NO FINDINGS`，别的什么都不输出。
