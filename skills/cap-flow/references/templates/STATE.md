<!--
  STATE.md — feature 级 handoff 模板（capital-agent-skills / cap-*）
  ─────────────────────────────────────────────────────────
  作用：跨 session 的"我们到哪了"单一事实源。落在【目标仓库】的
        `<target-repo>/.cap/STATE.md`，不在 skill 里。
  生命周期：短命。每个 feature/topic 一份；feature 完成（stage=done）后由 cap-flow 的退场流程
        （intake.md 的 Retire op）退场——归档到 .cap/archive/<date>-<feature>/、耐久决策回流
        PROFILE.md ## Evolution log（无 PROFILE 兜底 .cap/EVOLUTION.md）、（若源自需求树）标源叶
        shipped、清空本文件。由 cap-flow 在下次 /cap 检测到 stage==done 时触发（见 cap-flow §2 退场前置 / §4 路由）。
  与 PROFILE.md 的区别：
    - PROFILE.md = 项目级、长命、所有 feature 共享（cap-understand 建一次）。
    - STATE.md   = feature 级、短命、本任务的 handoff 载体（本文件）。
  写入规则：
    - 单写者（single-writer）：同一时刻只有主线（cap-flow）在写 STATE.md。
    - 并行产物写各自的文件（如 .cap/review/<role>.md），不并发写本文件，避免竞态。
    - 阶段 skill 与 cap-flow 的接口是 `## HANDOFF` block；cap-flow 是 canonical writer。
      schema 见 cap-flow/SKILL.md §5 与 references/runtime-adapters/codex.md。
    - verify-checks 与 Active roles 是【每次运行从 git diff 动态重算】的快照，
      仅供 handoff/审计，不是持久化的事实源（diff 一变就过时）。
  使用方式：
    1) 复制本模板到 <target-repo>/.cap/STATE.md
    2) 删除本注释块与所有 <填写...> 占位
    3) 每个阶段结束时由当前阶段 skill 先输出 `## HANDOFF` block；cap-flow 读取该 block 后作为
       单写者更新本文件。独立直调阶段 skill 时，也必须先产同一 HANDOFF block，再作为单写者应用。
  ─────────────────────────────────────────────────────────
-->

# Cap State: <feature/topic 一句话标题>

stage: understand | define | plan | implement | test | review | release | done
status: in-progress | gated | blocked
work-type: feature | remediation | hotfix     # 流程画像(中央旋钮):各阶段读它自适应走多重。见下方说明
branch: <写 STATE 时记 `git rev-parse --abbrev-ref HEAD`>     # 并发边界戳:cap-guard 据此防串台
worktree: <写 STATE 时记 `git rev-parse --show-toplevel`>     # 同上(worktree 隔离)
source-leaf: <若本特性源自 requirements 树则记叶 id，否则 (none)>   # Retire 据此回写源叶 status=shipped（见 cap-flow §2 退场前置）
owner: <本特性的人类归属：当初需求确认/计划拍板的人；缺省 (none)>   # 归因用；退场随数据点吐出
runner: <谁执行本轮：人跑=<operator>，无头/夜间自治=night-factory>   # 与 owner 分记；A/B 时切分人机产出。见 headless-policy.md §3
updated: <时间戳，由调用方传入，例如 2026-06-04T15:30>
task-context: .cap/task-context.md @ <调查时 HEAD 或 working-tree>   # 意图/分支/HEAD 变化时刷新
verify-checks: [logic, journey, model]   # 本次运行从 diff 动态解析；未进入 verify 前可留 []
cap-gate: <未设置>   # cap-review 全过(verdict=PASS)时写 `PASS reviewed-head=<HEAD的sha>`，否则写 `BLOCK`。本地 pre-push hook(若装)只认这一行来决定放不放行 push。

## External operation authorization

<!-- 仅保存授权边界，不保存账号、证件、卡号、手机号、Token、密钥或请求参数正文。无外部操作时填 not-applicable。 -->
- environment: <local/test/staging/production/unknown/not-applicable>
- scope: <已授权动作与最小影响范围摘要，或 not-applicable>
- granted-by: <用户/既有项目规则/不需要授权；不得写敏感身份资料>
- invalidates-on: <环境、动作范围、影响或可逆性变化时失效>

<!--
  字段取值说明：
  - stage：当前所处阶段，枚举见上。done = 全部 gate 通过且测试验证完成。
      · understand：与需求树维护同为【项目级】工作 —— cap-understand 产出 PROFILE.md；需求树
        （`<target-repo>/.cap/requirements/` 递归 domain→subdomain→leaf）由 cap-flow 内联的 intake
        流程维护，不属单特性生命周期。从需求树选中一片叶后【另起】单特性 STATE，stage 从 define 起跑。
  - status：
      in-progress = 阶段进行中
      gated       = 卡在某个 exit gate（等待批准/等待修复后重测）
      blocked     = 被外部依赖/缺口阻塞，无法推进（在 Decisions log 记原因）
  - updated：调用方传入的时间戳，skill 不自造时间。
  - verify-checks：本轮 diff 解析出的验证项子集。可能值见 cap-test/checks/ 目录：
      logic（总是跑）/ journey（用户可见面变更）/ model（AI/模型/策略变更）。
  - work-type（流程画像 / 中央旋钮）：由 define/understand 在流程开始时定；各阶段入口读它来自适应"走多重"。
      · feature（默认）：完整 define→plan→implement→test→review，按 L1-L4 + 各门控正常自适应。
      · remediation（遗留改造 / AI-readiness 整改）：spec 一段话、eval/design 契约通常 N/A、plan 默认 L1、
        implement 文档/配置改动走 Skip-TDD；**走轻,但 review/test 门不短**(改的是全仓结构,更该审)。
      · hotfix（紧急修)：直奔 implement 调试子循环 + 最小验证;**仍过 review 与 push 门**,事后补 spec/plan 记录。
    原则:work-type 只**偏置默认granularity**,不取消任何硬门(覆盖率/安全 open=0/review)。
-->


## Gates passed

<!--
  exit gate 清单。每个阶段 skill 完成自己的出口条件后勾选对应项。
  下面是覆盖完整主线的默认清单；按 feature 实际经过的阶段保留/删减。
  [x] = 已通过，[ ] = 未通过/未到。
-->

- [ ] understand：PROFILE.md 已建立 / 已确认无漂移
- [ ] define：spec.md 已获批（含 AI 工作的 eval 标准，若适用）
- [ ] context：task-context.md 已基于当前任务与代码 HEAD 刷新
- [ ] plan：plan.md 已拆分（阶段含依赖、任务含三字段）
- [ ] implement：tests written (red) — 测试先行且确认失败
- [ ] implement：implementation (green) — 实现使测试通过
- [ ] test：logic 通过（套件 + 覆盖率门控）
- [ ] test：journey 通过（用户旅程，若有可见面变更）
- [ ] test：model 通过（达 rubric/阈值，若有 AI 变更）
- [ ] review：多角色评审无 CRITICAL/未决项
- [ ] release：晋级完成 / 收口通过

## Active roles (from last diff scan)

<!--
  上一次 git diff 解析出的活跃角色卡（见 role-routing.md）。
  仅快照，不是事实源；下次进入 build/verify/review 时重算。
  取值字典：qa, client-dev, server-dev, design, big-data, architect（改动跨 ≥2 面/全链路时，
  看接缝:全链路数据结构对齐/跨边界契约/blast-radius）, ai-readiness（动 AI-上下文/构建配置，
  或 map 体检/遗留改造时:面向 AI 友好度/可维护性）, skill-maintainer（改技能体系自身时，
  防臃肿/additive/防孤儿/溯源/可移植/semver/自我修改安全）；security（敏感面触及时，
  为视角叠加标签，无独立 roles/security.md，由 server-dev/qa 卡的 security 子节承载）。
-->

- <填写，例如：server-dev, qa>

## Changed-files snapshot

<!--
  上一次 git diff 的变更路径清单（解析角色/验证项的依据）。一行一个路径。
-->

- <填写，例如：services/api/orders.py>
- <填写，例如：tests/test_orders.py>

## Decisions log

<!--
  关键决策与阻塞原因的追加式日志（append-only）。每条带日期 + 选了什么 + 为什么。
  blocked 状态的原因必须记在这里。
-->

- <date> 选 X 而非 Y，因为 ...

## Next action

<!--
  下一步动作。给"全新上下文的下一个 agent/session"看：不需要回放历史即可继续。
  写成可直接执行的指令，例如 "-> invoke cap-plan"。
-->

-> <填写，例如：invoke cap-plan>
