---
check: model
triggers: [models/**, strategy/**, "*.prompt*", ai/**, evals/**, prompts/**, agents/**]
produces: .cap/verify/model-<scope>-report.md
---

# 验证项:model（AI / 模型 / 策略质量评估 + 性能基准）

> cap-verify 的可插拔验证项之一,与 `logic`(功能正确性 + 覆盖率门控)、`journey`(用户旅程)并列。
> 本验证项回答的是:**"这次对 AI / 模型 / 策略的改动,质量是变好了还是变差了?"**——这是单测 / E2E
> 答不了的问题,因为 AI 系统是非确定性的:同样输入 X 不可靠地产出 Y。
>
> 核心契约:**评估标准(rubric / 数据集 / 指标 / 阈值)在 `cap-shape` 阶段就定好**(spec 是 AI 工作的
> 一等公民),本验证项只负责**按既定标准执行并出判定**。spec 没定标准 = 先回退到"对 AI 工作的一般
> 最佳实践审计"并报警(见"门控"),调度层把本验证项记为 gated,STATE.next 指回 cap-shape 补 eval 契约。

---

## 这个验证项在乎什么

- **改的是不是"AI 表面"。** 只在改动触及模型 / prompt / 策略 / agent / 检索 / 评估装置时才跑。改纯业务
  CRUD 不跑本验证项(那是 logic 的活)。
- **product eval ≫ model eval。** 通用基准(MMLU / HumanEval)只是入场过滤器,不是判据。80% 的评估精力
  花在"在我们这套系统、我们的数据、我们的领域规则下它表现如何"。
- **三测量法的优先级:code → judge → human。** 能用确定性代码检查的(JSON 合法、必带免责声明、延迟阈值、
  分类标志)先用代码;主观维度(语气、推理、是否该升级人工)才上 LLM judge;human 只用于校准 / 边界 /
  高风险。最有效的系统三者都用。
- **judge 必须先对人类校准。** 未校准的 LLM judge 产出的是噪声不是信号。校准目标 ≥0.7 相关性才可信任。
- **先验证评估装置没坏,再信分数。** 跑真模型前先确认"已知好的样本应得高分、已知坏的样本应得低分"。
  装置坏了,所有分数都是垃圾。
- **回归用 baseline-diff 双阈值。** 不是看绝对分高低,是看"相对上一版"涨跌,用 WARNING / REGRESSION
  两道阈值卡。**→ 这一关就是"AI 回归测试"**:每次改 AI / 模型 / 策略,对参考集跑分并和 baseline diff,
  **让以前好的输出变差 = REGRESSION = 阻断**。所以不另起 AI 回归验证项——AI 回归 = model 的 baseline-diff
  这一关。(额外保险:若担心非 AI 改动也可能让 AI 漂移,可在 spec 把 model 标为该特性的常驻验证。)
- **有效性甄别。** 一次 eval 跑挂了,要分清是"模型答得差"(valid,算进分数)还是"环境 / provider / 超时 /
  限流挂了"(invalid,剔除、重试,不算进分数)。
- **guardrail vs flywheel 二分。** 出错会不会对业务是灾难性的?是 → guardrail(线上实时拦截 / 升级,但加
  延迟,要克制);否 → flywheel(离线批量分析,喂回系统迭代)。

## ★ 护城河钩子:F1 proof-of-value（接入中心知识库后模型有没有变准）

本验证项不只是"过 / 不过"的门,它同时是**中心知识库价值的量化证据源**。cap-shape 定的 reference dataset
+ verdict 规则,天然也是"接入中心 KB 后模型预测有没有变准"的可回归基线:

- **对接 server 端 eval 打分**:model 验证项产出**预测契约**(对参考集的结构化预测输出),server 端 eval
  装置(如文件预测 F1)对其打分。skill 侧只负责产出可复跑的预测 + 落盘,打分在 server 侧。
- **baseline 就是 proof-of-value 的锚**:同一份参考集,记录"未接 KB"与"已接 KB"两条 baseline,F1 的
  Δ 就是知识库带来的准确率增量证据。
- **可复跑,非一次性**:数据集与阈值必须写成能反复跑的文件(路径 + 阈值明确),这样每次 KB 更新都能重跑
  出新的 F1,形成"知识库越用越准"的可观测回归。
- **repoTail 不变量**:预测契约与打分必须锚在**同一 repo_url 派生的 projectKey** 上,否则归因静默断裂——
  别把 A 项目的预测喂给 B 项目的 baseline 比。

---

## 检查清单（执行前逐条核对）

**前置(标准从哪来)**
- [ ] spec 里有 Eval 契约段?拿到:评估的 AI 系统类型、3-5 个"绝不能错"的失败模式、各维度 rubric
      (1/3/5 分定义)、每个维度用 code/judge/human 哪种、reference dataset 规模与构成、判定阈值。缺失 →
      走"门控"里的回退路径。
- [ ] reference dataset 存在且 ≥10-20 个高质量样本(不是 200 个平庸样本),覆盖:关键成功场景、常见用户
      工作流、已知边界、历史失败模式。

**评估装置自检(oracle/nop 门,跑真模型前必做)**
- [ ] 拿 1-2 个"已知应通过"的样本喂评估流程 → 应得高分(oracle 通)。
- [ ] 拿 1-2 个"已知应失败"的样本喂评估流程 → 应得低分(nop 不通)。
- [ ] 两者都符合预期才继续;否则停下来修评估装置,**不要**拿坏装置去评模型。

**judge 校准(用了 LLM judge 才需要)**
- [ ] 抽样让 human 对一批样本打分,与 judge 打分比对,相关性 ≥0.7 才信任。
- [ ] judge 的 prompt 里嵌入了 rubric 的 1/3/5 锚点 + 领域正反例,不是裸"打个分"。

**执行**
- [ ] 对每个 reference 样本,按维度跑出 actual(含中间步骤 / 工具调用 / 推理轨迹,不只看终值)。
- [ ] 多模型对比时:同一输入喂所有候选模型,judge 用同一 rubric 0-10 打分。
- [ ] 性能 bench:先 `--baseline` 采当前基线 JSON,再 diff。
- [ ] **多模型 / 多 provider dry-run 预检**:先确认哪些 provider 已认证可跑,未认证的干净跳过、不中止整批。

**有效性甄别(出判定前)**
- [ ] 逐条跑结果分类:pass / valid 失败(答得差,算分)/ invalid(环境挂,剔除重试)。
- [ ] invalid 跑不算进质量分和 pass@k;只用 valid 观测算最终判定。

**判定 + 落证据**
- [ ] 三态打分(COVERED / PARTIAL / MISSING)× 加权 × 阈值 → verdict。
- [ ] baseline 对比给出 WARNING / REGRESSION 标记。
- [ ] 写入 `.cap/verify/model-<scope>-report.md`,含本次 baseline JSON 路径,供下次 diff。

---

## 好的样子（达标长什么样）

- 评估装置 oracle/nop 双向自检通过,judge 与 human 校准 ≥0.7 —— **先证明尺子是准的**。
- rubric 是领域化的、有 1/3/5 锚点和正反例的,不是"helpfulness 打个分"这种空泛指标。
- 每个分数都能追到:哪个样本、哪个维度、code/judge/human 哪种测量、原始 actual 在哪。
- 回归判定基于 baseline-diff(相对涨跌 + 双阈值),不是孤立看一个绝对分。
- invalid 跑被显式剔除并说明原因(限流 / 超时 / auth),最终分只由 valid 观测算出。
- 报告里 guardrail 维度(灾难性失败模式)单独列出并标记线上拦截策略,与 flywheel 维度分开。
- spec→verify 契约清晰:报告头部引用了 spec 里 rubric / 数据集 / 阈值的来源位置。

## 常见翻车

1. **拿通用基准当产品判据。** MMLU 高分 ≠ 你的客服 bot 好用。基准是过滤器不是 verdict。
2. **信未校准的 judge。** judge 没对人类校准就拿它的分做决策 = 拿噪声做决策。
3. **第一天就追求全覆盖。** 上来铺 200 个假想样本,不如 10-20 个真实关键样本,再从生产失败模式扩充。
4. **不自检评估装置就跑。** 跳过 oracle/nop 门,结果"全员高分"其实是 judge 一直返回满分;或"全员 0 分"
   其实是数据集路径错了。
5. **不做有效性甄别。** 把限流 / 超时 / 容器构建失败当成"模型答得差"算进分数,得出错误结论。
6. **只看终值不看轨迹。** AI 系统的失败常在中间步骤 / 工具调用,只对比最终输出会漏掉真因。
7. **孤立看绝对分。** 不和 baseline diff,看不出这次改动到底让它变好还是变差。
8. **什么都测。** 只追踪能驱动决策的指标;"全都收集"产出噪声。
9. **工程师独自定 rubric。** 领域专家必须共定标准,否则漏掉关键细微差别(如医疗里"知道何时不该回答")。
10. **把评估当一次性配置。** 用户行为会演化、失败模式会涌现;评估是持续过程,不是搭完就完。

## 介入哪些阶段

| 阶段 | 本验证项的角色 |
|------|-------------|
| **shape** | **定标准(上游契约)**:为 AI 工作产出 Eval 契约段 —— 系统类型、关键失败模式、rubric、数据集需求、测量方式分配、阈值。本文件是该段的执行端规范,spec 端见 `cap-shape`。 |
| **build** | 实现期建议:从第一天加 tracing、与实现并行构建 reference dataset、code 检查先于 judge。 |
| **verify** | **主战场**:按 spec 标准执行 eval / bench,出 verdict + baseline diff,写报告。由改动路由在"AI / 模型 / 策略改动"时自动选入本验证项。 |
| **review** | 把本验证项的 verdict 作为 review 的输入证据之一;REGRESSION / 灾难性失败模式未消解 → 阻断合并。 |

---

# ── 验证项 Playbook（可执行规范）──

## 何时触发

由 cap-verify 在进入时跑 `git diff`、匹配 `cap-flow/references/role-routing.md` 自动选入。触发条件:

- 改动路径命中 AI 表面 glob:`models/** strategy/** ai/** evals/** prompts/** agents/** *.prompt*`
- 数据管道改动且涉及**数据质量**(big-data 域)时,可附加选入本验证项。
- 也可**独立运行**做现状审计:`/cap verify --check=model --scope=<feature|full>`。

**不触发**:纯业务 / UI / CRUD 改动 —— 那是 logic / journey 的范围。

## 步骤流程

```
0. 读契约   ← 从 .cap/spec.md 拿 Eval 契约段(rubric/数据集/指标/阈值/测量分配)
            └─ 缺失 → 走门控的回退路径(best-practice 审计 + 报警,调度层记 gated → 回 cap-shape)
1. 备齐数据 ← 定位 reference dataset;校验 ≥10-20 高质量样本、覆盖四类场景
2. 装置自检 ← oracle 样本应高分 / nop 样本应低分;不符 → STOP 修装置
3. judge校准 ← 若用 LLM judge:human 抽样比对,相关性 ≥0.7 才信任
4. dry-run  ← 多模型/多 provider 时先预检认证状态,未认证干净跳过
5. 执行     ← 逐样本逐维度跑 actual(含轨迹);code→judge→human 按 spec 分配
            └─ 性能 bench:先采 baseline.json,再 diff
            └─ 产出预测契约喂 server eval 打分(F1 proof-of-value,见上方护城河钩子)
6. 甄别     ← 每条结果分类 pass / valid失败 / invalid;invalid 剔除并重试
7. 打分     ← 三态(COVERED/PARTIAL/MISSING) × 加权 × 阈值 → verdict
            └─ baseline-diff 双阈值标 WARNING/REGRESSION
8. 出报告   ← 写 .cap/verify/model-<scope>-report.md(含本次 baseline JSON 路径)
9. 回环     ← REGRESSION/灾难性失败模式 → escalate 回 cap-build 修;否则 gate 通过
```

**可移植性(Codex 能跑)**:全程纯文件 + git + 命令行;无子代理硬依赖。需要向用户提问时用**纯文本编号
列表**。多模型并行评估若环境无并行能力,降级为串行逐模型跑。所有 rubric / 数据集 / 阈值 / baseline 均
落盘为文件,不依赖技能调用上下文。

## 产物

- `.cap/verify/model-<scope>-report.md` —— 本次评估报告(schema 见下)。
- `.cap/verify/baselines/model-<scope>-<date>.json` —— 本次 baseline,供下次 diff。
- 供 cap-verify 调度层汇总:本轮 active checks 含 `model`;门控结果;verdict;next action。

## 门控（exit gates）

| 门 | 条件 | 不满足时 |
|----|------|---------|
| **标准就位** | spec 有 Eval 契约段(rubric+数据集+阈值) | 回退:跑 best-practice 审计 + 报警"AI 工作缺评估标准,建议补 spec Eval 契约段";调度层记 gated,STATE.next 指回 cap-shape;verdict 标 PARTIAL 上限 |
| **装置健康** | oracle 通 + nop 不通 | **STOP**:评估装置坏了,先修,不出分 |
| **judge 可信** | 用 judge 则校准 ≥0.7 | judge 结果降级为"参考",关键维度回退 code/human |
| **有效样本足** | valid 观测 ≥2(剔除 invalid 后) | 重试 invalid 跑;仍不足 → verdict 标 UNVERIFIABLE |
| **无回归** | 无 REGRESSION 且灾难性(guardrail)失败模式全 PASS | **阻断**:escalate 回 cap-build 修,REGRESSION 必须消解 |

**verdict 分级**:`PRODUCTION READY` / `NEEDS WORK` / `SIGNIFICANT GAPS` / `NOT IMPLEMENTED`。
只有 PRODUCTION READY(或用户显式接受 NEEDS WORK 的非关键缺口)才放行到 review。

## 证据 schema（model-<scope>-report.md）

```markdown
# Model Report: <feature/scope>
check: model
scope: feature | iteration | full
updated: <stamp>
spec-source: .cap/spec.md#eval-contract    # rubric/数据集/阈值的来源(spec→verify 契约)
dataset: <path>  size: <n>                 # reference dataset 位置与样本数
baseline: .cap/verify/baselines/model-<scope>-<prev>.json   # 对比基线(无则首跑)
proof-of-value: F1 <未接KB baseline> → <已接KB current>  Δ=<+x>   # 护城河钩子(如适用)

## Harness self-check(先证明尺子准)
- oracle sample(s): PASS  (已知好样本得高分)
- nop sample(s):    PASS  (已知坏样本得低分)
- judge calibration: 0.74 corr vs human  → TRUSTED   # 用 judge 才有此行

## Validity filter(有效性甄别)
- total runs: 24 | valid: 22 | invalid: 2 (1 rate-limit, 1 timeout — 已剔除并重试)

## Dimension scores(按 spec rubric)
| 维度 | 测量法 | 状态 | 分数 | baseline | Δ | 标记 | guardrail? |
|------|-------|------|------|----------|---|------|-----------|
| factual-accuracy   | code  | COVERED | 0.92 | 0.90 | +0.02 | OK       | -    |
| hallucination      | judge | COVERED | 0.81 | 0.88 | -0.07 | WARNING  | -    |
| escalation-accuracy| judge | PARTIAL | 0.70 | 0.85 | -0.15 | REGRESSION | ✅ guardrail |
| output-structure   | code  | COVERED | 1.00 | 1.00 | 0.00  | OK       | -    |

## Performance bench(如适用)
| 指标 | baseline | current | Δ | 状态 |
|------|----------|---------|---|------|
| p50 latency | 800ms | 1600ms | +800ms | REGRESSION |
| cost/call   | $0.01 | $0.012 | +20%   | WARNING    |

## Verdict
overall: <weighted score> → SIGNIFICANT GAPS
critical (guardrail) failures: 1   # escalation-accuracy 回归且属灾难性失败模式
→ 阻断:escalate 回 cap-build 修 escalation 逻辑,重跑 model

## Failure evidence(valid 失败样本,附轨迹定位)
- sample #07: escalation missed — judge note: "应升级人工却自答";trace: <path/step>
- ...

## Next action
-> escalate 回 cap-build 修复 escalation-accuracy 回归
```

**阈值参考**(可被 spec 覆盖):质量分相对 baseline 跌 >5% = WARNING,>10% 或灾难性(guardrail)维度任何
下跌 = REGRESSION;性能 timing >20% = WARNING,>50% 或 >500ms = REGRESSION,bundle / 成本 >10% =
WARNING,>25% = REGRESSION。
