---
role: design
triggers: ["web/**", "components/**", "**/*.tsx", "**/*.vue", "**/*.css", "**/*.scss", "**/*.swift", "**/*.kt", "**/*.dart", "mobile/**", "ios/**", "android/**", "**/*.html", "design-system.md", "DESIGN.md"]
updated: 2026-06-26
---

# design — 设计视角角色卡

> 一张"看问题的镜片"，不是流程。被 cap-implement / cap-test / cap-review 在改动命中前端/UI 面时加载。
> 工程实现细节归 client-dev 卡；本卡只管"设计意图、体验、可用性、视觉品质"。
> 两条腿：**(A) 视觉/前端代码审查**（AI-slop / 排版 / 交互态 / a11y，可从 diff 静态判定）+
> **(B) UX 深度**（CSS 系统 / 信息架构 / 用户旅程走查，需要理解意图或跑页面）。

## 关注点

设计视角在意四件事，从"能否在 diff 里抓到"到"必须看渲染结果"递进：

1. **不像模板（Anti-template / Anti-AI-slop）** —— 输出要看起来是有人在做决策，而不是默认库拼出来的。
   警惕：紫/靛渐变、3 列等距图标卡、全居中、所有元素同一个大圆角、"Welcome to X / Unlock the power of"套话文案、灰底白字配一个装饰色。
2. **层级与节奏** —— 通过尺度对比建立清晰层级；间距有意图（不是处处等 padding）；标题层级不跳级（h1→h3 不许跳过 h2）。
3. **排版纪律** —— 正文 ≥16px；字体家族 ≤2-3 个且有配对理由；禁用 Papyrus/Comic Sans/Lobster/Impact/Jokerman；文本容器有 max-width（行长 ≤75 字符）。
4. **交互态被设计过** —— hover / focus / active 都有，且 focus-visible 可见（绝不 `outline:none` 不补替代）；触控目标 ≥44px。
5. **可访问性（a11y）** —— 语义化 HTML 优先（header/nav/main/section/footer，而非 div 堆）；颜色对比 ≥ WCAG 2.1 AA；键盘可达 + 焦点顺序合理；尊重 `prefers-reduced-motion`。
6. **设计系统一致性** —— 颜色/字体/间距走 token（CSS 自定义属性），不重复硬编码调色板；若仓库有 `DESIGN.md`/`design-system.md`，所有判定以它为准（被它明确祝福的模式不算违规）。
7. **信息架构与用户旅程（UX 深度）** —— 主导航 5-7 项；内容层级有逻辑流；关键 CTA 在首屏可达；5 秒测试能答出"这是什么 / 适合我吗 / 我该做什么"。
8. **动效服务于流程** —— 只动 compositor 友好属性（transform/opacity/clip-path），不动 layout 属性（width/height/top/left/margin/font-size）；`will-change` 窄用即清。

## 检查清单

> 标注 `[diff]` = 能从源码静态判定（A 腿，build/review 即可跑）；`[render]` = 需要看渲染结果或跑页面（B 腿，归 verify journey 模式或 /design-review）。

### A. 视觉/前端代码审查（读改动文件全文，非仅 diff hunk）
- [ ] `[diff]` 无紫/靛渐变 AI-slop 配色（`#6366f1`–`#8b5cf6` 段、blue→purple）。
- [ ] `[diff]` 非"3 列等距图标卡 + 全居中"——`text-align:center` 密度 >60% 即标记。
- [ ] `[diff]` 圆角不是处处同一大值——≥16px 同值占比 >80% 即标记。
- [ ] `[diff]` 文案无套话（"Welcome to X""Unlock the power of""all-in-one solution""Revolutionize/Streamline your..."）。
- [ ] `[diff]` 正文 font-size ≥16px（body/p/.text/base）。
- [ ] `[diff]` 新引入字体家族 ≤3 个；无黑名单字体。
- [ ] `[diff]` 标题层级不跳级（同组件内 h1 后不可直接 h3）。
- [ ] `[diff]` 无新增 `!important`（特异性逃逸口，应正确修复）。
- [ ] `[diff]` 交互元素有 `:hover` + `:focus`/`:focus-visible`；无 `outline:none`/`outline:0` 不补替代焦点环。
- [ ] `[diff]` 文本容器有 max-width；固定 px 宽容器有 max-width 或 @media 兜底（防移动端横向滚动）。
- [ ] `[diff]` 间距/颜色/字体走 token，未重复硬编码；若有 DESIGN.md，颜色/字体/间距均在其声明范围内。
- [ ] `[diff]` 语义化 HTML 优先；动效只用 compositor 友好属性。
- [ ] `[diff]` **DESIGN.md 颜色对比度静态自检**：`python3 <cap-flow>/scripts/contrast_check.py <DESIGN.md>`（纯 stdlib，无需浏览器）——把 a11y 对比度从 B 腿 [render] 提到 A 腿静态可判。报 < WCAG AA 4.5:1 的前景/背景对（advisory，非强制必要条件）。默认启发式配对偏宽（语义底色当前景会有噪声），DESIGN.md 里写一行 `<!-- contrast: ink on bg, muted on panel -->` 可收窄到真正承载文字的对；oklch/lab 等会诚实标 skipped。**大 token 集（生产前端，几十个 token）务必用注释收窄**——裸启发式是笛卡尔积，噪声会淹没真信号（实测某项目 176 对 / 109 噪声 → 注释收窄到 3 个真问题）。**前缀归一**：token 带公共前缀（`--color-text-primary`）时注释写短名 `text-primary` 即可（自动匹配；歧义会报 info 不静默）。

### B. UX 深度（理解意图 / 跑页面）
- [ ] `[diff]` 有意挑选了风格方向（编辑/瑞士/玻璃拟态/bento/暗奢…），而非"clean minimal"含糊默认。
- [ ] `[diff]` 有 CSS 设计系统基座：颜色/排版/间距(4px 或 8px 网格)/容器断点 token；响应式 mobile-first。
- [ ] `[render]` 5 秒测试通过：首屏能答"这是什么 / 适合我吗 / 该做什么"。
- [ ] `[render]` 关键 CTA 首屏可达，无需滚动；主导航 5-7 项。
- [ ] `[render]` 颜色对比达 WCAG 2.1 AA；键盘 Tab 顺序合理、焦点环可见。
- [ ] `[render]` `prefers-reduced-motion` 下动效降级；触控目标 ≥44px。
- [ ] `[render]` 320/375/768/1024/1440 各断点无溢出、无横向滚动。
- [ ] `[render]` 若双主题，明暗都看起来是被有意设计过的（非一个简单反色）。

## 好的样子

- **看起来有人在做决策**：层级靠尺度对比、节奏靠有意图的间距、深度靠叠层/阴影/表面/动效——满足 design-quality 必备清单里至少 4 条。
- **token 驱动**：调色板、排版尺度、间距、时长全是 CSS 自定义属性；换主题只改变量，不改组件。
- **交互态完整且可访问**：hover/focus/active 都被设计过，focus-visible 始终可见，键盘能走通全流程。
- **信息架构清晰**：用户在 5 秒内知道这是什么、是否适合自己、下一步做什么；CTA 在该出现的地方出现。
- **响应式真实**：从 320 到 1440 每个断点都成立，不是桌面端缩一缩。
- **校准到项目**：所有判定先读 DESIGN.md，被祝福的"违规"不误报；没有 DESIGN.md 才退回通用原则。

## 常见翻车

- **AI-slop 五件套**：紫靛渐变 + 3 列等距图标卡 + 全居中 + 统一大圆角 + 套话文案——一眼假，没有设计工作室会发货。
- **`outline:none` 不补焦点环**：直接干掉键盘可访问性（这是 a11y 红线，不是风格问题）。
- **正文 <16px / 字体满天飞 / 标题跳级**：排版三大基本功失守。
- **处处等 padding、处处同圆角**：均匀 = 没有层级 = 没有设计。
- **只测桌面**：固定 px 宽无 max-width/媒体查询，移动端横向滚动。
- **把工程问题当设计问题**（或反之）：组件性能/重渲染归 client-dev；本卡只管设计意图与体验。**边界要清。**
- **无视 DESIGN.md 乱报**：把项目刻意的设计选择当违规——失去信任。
- **拿"qualitative 走查"当统计证据**：persona 走查是强假设，需验证，不是已证事实——报告里要写明。
- **动 layout 属性做动画**：width/height/top/margin 动画 → 掉帧；应只动 transform/opacity。

## 介入哪些阶段

| 阶段 | 设计视角做什么 |
|------|----------------|
| **shape** | 当特性涉及 UI 面：确认风格方向（不要"clean minimal"含糊）、定调色板/排版策略、画信息架构骨架与关键用户旅程；这些进 spec，成为后续校准基线。**用具体参照物锚定风格而非形容词堆砌**（"1970 年代研究生讲义" > "modern/clean/premium"——参照物描述一个点、形容词描述一个区域，负约束随参照物自带）；DESIGN.md **散文为主、token 为辅**（token 是校准 context 不是渲染指令）。详见 cap-define §2.6b。 |
| **build** | 实现时守 token 化、语义化 HTML、交互态、a11y 基线；A 腿 `[diff]` 检查清单可即时自查。 |
| **verify (journey 模式)** | 跑页面执行 B 腿 `[render]` 检查：5 秒测试、断点无溢出、对比/键盘可达、reduced-motion；失败截图回灌 build。详见 verify-check `journey` playbook 下方。 |
| **review** | 对 diff 跑完整 A 腿审查（读改动前端文件全文），按下方证据 schema 出 findings；与 client-dev 卡并行但各写各的文件，互不抢 STATE。 |

---

## verify-check playbook：design 视觉/UX 审查（嵌入 journey 模式）

> design 卡本身无流程；但当 cap-test 的 **journey 模式**命中前端面时，按此 playbook 跑视觉/UX 那一刀。
> 可移植：Web 用 Playwright MCP（环境已装）；无 Playwright/无并行能力时降级——见"门控"。

### 何时触发
- diff 命中前端 glob（`web/** components/** *.tsx *.vue *.css *.html` 或移动端 `*.swift *.kt ios/** android/**`）。
- 或显式 `/cap 测试 --check=journey`（视觉子项随 e2e 一起跑）。
- 若 `git diff --name-only` 命中的路径**没有任何一条**匹配前端/UI glob（按 role-routing R1/R2 的 web/移动 glob，或 PROFILE.surface-map 的前端面）：**静默跳过**，不出任何输出。（可移植：不依赖任何 gstack 二进制，只用 diff + role-routing glob。）

### 步骤流程
1. **校准**：若仓库根有 `DESIGN.md`/`design-system.md`，先读，作为所有判定基准；否则用通用原则。
2. **A 腿（静态，无需浏览器）**：对 diff 命中的前端文件**读全文**（非仅 hunk），逐条跑上面"检查清单 A"。
   - **对比度静态自检**：若仓库有 `DESIGN.md`，跑 `python3 <cap-flow>/scripts/contrast_check.py DESIGN.md`——确定性算出 < WCAG AA 的前景/背景对，作为 a11y 对比度的 advisory 证据（info/warning，**非强制必要条件**；不改"以 DESIGN.md 为准、无则退回通用原则"的语义）。findings 并入下方 NEEDS INPUT（category: a11y）。诚实门：oklch/lab 标 skipped 的颜色未被检查，须在 scope-declaration 注明。
   - 机械可自动修（HIGH 置信、无需设计判断）：`outline:none` 补 `:focus-visible{outline:2px solid currentColor}`、删新增 `!important` 并修特异性、正文 <16px 提到 16px。
   - 其余（AI-slop、排版结构、间距、交互态缺失、DESIGN.md 违规）→ 需设计判断，列 NEEDS INPUT。
   - LOW 置信项 → 标 "Possible: …，请视觉核验或跑 /design-review"，绝不自动改。
3. **B 腿（渲染，需跑页面）**：Playwright MCP 起页面 →
   - 推导 1-3 条用户旅程（读路由/PRD/diff 命中的页面）；对关键页跑 5 秒测试三问。
   - 逐断点截图：320 / 375 / 768 / 1024 / 1440（必要时 1920），查溢出/横向滚动。
   - 键盘 Tab 走一遍：焦点顺序 + 焦点环可见；查颜色对比（可借 `zai-mcp-server` ui_diff_check / 自动 a11y 检查）。
   - 开 `prefers-reduced-motion` 复跑，确认动效降级。
   - 双主题则明暗各截一遍。
4. **失败回灌**：任一 `[render]` 项失败 → before/target/after 三联截图 + 源码定位（file→route），作为 finding 回灌 cap-implement 修复，修后复跑该项。

### 产物
- 写入 `<target-repo>/.cap/verify/journey-<scope>-report.md` 的 **design 小节**（与功能 e2e 同文件、分节）。
- review 阶段的纯静态 findings 写 `<target-repo>/.cap/review/design.md`（单写者，避免与 client-dev 抢文件）。
- 截图证据存 `.cap/verify/` 下，三联（before/target/after）命名可追。

### 门控（gate）
- **静默跳过门**：`git diff` 无任何路径匹配前端/UI glob（role-routing R1/R2 或 PROFILE 前端面）→ 整个设计审查跳过，零输出。（可移植，不依赖 gstack。）
- **a11y 硬门**：`outline:none` 无替代焦点环、对比 < AA、键盘走不通 → **FAIL**（属可访问性回归，非风格建议，必须修后才放行）。
- **AI-slop 软门**：命中 AI-slop 五件套任意项 → WARN + NEEDS INPUT，需人确认或修复（除非 DESIGN.md 明确祝福）。
- **降级门（可移植）**：无 Playwright MCP → 只跑 A 腿（静态 `[diff]`），B 腿 `[render]` 项标 "UNVERIFIED — 需浏览器环境"，诚实声明不能测的范围，不假装跑过。
- **诚实门**：每条 finding 标证据等级 TESTED / PARTIAL / INFERRED；qualitative 走查（persona/5 秒测试）须注明"强假设，待验证，非统计证据"。

### 证据 schema
```markdown
## Design Review: <N> issues (<X> auto-fixed, <Y> need input, <Z> possible)  [scope: <feature/iteration/full-chain>]
calibrated-against: DESIGN.md | universal-principles

### AUTO-FIXED
- [file:line] <问题> → <已应用的修复>   (HIGH, mechanical)

### NEEDS INPUT
- [file:line] <问题描述>
  category: ai-slop | typography | spacing | interaction-state | a11y | design-system
  severity: FAIL | WARN | INFO
  evidence: TESTED | PARTIAL | INFERRED
  recommended-fix: <建议>

### POSSIBLE (verify visually)
- [file:line] Possible: <描述> — 视觉核验或跑 /design-review  (LOW)

### RENDER FINDINGS (B 腿)
- [route @ breakpoint] <问题>  evidence: TESTED  screenshots: before/target/after
- scope-declaration: 能测=<...>; 不能测=<... + 原因（如无浏览器）>

若无前端改动：静默跳过，无输出。
若无 issue：`Design Review: No issues found.`
```
