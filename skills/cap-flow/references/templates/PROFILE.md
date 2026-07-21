<!--
  PROFILE.md — 项目级长命记忆模板（capital-agent-skills / cap-*）
  ─────────────────────────────────────────────────────────
  作用：项目的"它是什么"长期画像。落在【目标仓库】的
        `<target-repo>/.cap/PROFILE.md`，不在 skill 里。
  生命周期：长命。由 cap-understand 建一次，被之后每个 feature 读取共享；
            仅在架构漂移时刷新（见下文 cap-flow 的漂移检测）。
  与 STATE.md 的区别：
    - PROFILE.md = 项目级、长命、所有 feature 共享（本文件）。
    - STATE.md   = feature 级、短命、单任务 handoff。
  核心职责：承载【架构 surface map】——路由决策函数的可追踪输入。
    决策 = resolve(git diff × PROFILE.surface-map × role-routing 规则)。
    其中 surface-map 是慢变、被追踪的输入；diff 是每次重算的临时输入。
  漂移检测：cap-flow 在 session 开始时拿 diff 路径对照本 surface map；
            若变更触及 map 里没有的模块/面（如全新服务、首个移动端目录），
            提示"架构已漂移——刷新 PROFILE？"并可重跑 cap-understand 相关部分。
  使用方式：
    1) 复制本模板到 <target-repo>/.cap/PROFILE.md
    2) 删除本注释块与所有 <填写...> 占位
    3) 由 cap-understand 据实填写；后续 feature 只读，不改（除非刷新）
  ─────────────────────────────────────────────────────────
-->

# Project Profile: <项目名>

<!--
  顶部元数据：技术栈用列表；带"原因"列的展开形式见下方 ## Tech stack 表。
  test-commands 是语言无关的命令抽象，verify/logic 据此发现并运行套件。
  v1 语言范围 = Python + Web(TS)；命令示例对应 pytest/coverage + vitest/playwright/tsc。
-->

tech-stack: [<填写，例如：next.js, fastapi, postgres>]
test-commands: { unit: "<例如 pytest>", coverage: "<例如 pytest --cov=<pkg> --cov-fail-under=80>", e2e: "<例如 playwright test>", typecheck: "<例如 tsc --noEmit>", build: "<例如 pnpm build>" }
<!-- 某槽位无对应套件/工具时，显式写 "none — <原因>"，不要留空；coverage 用具体包名替换 <pkg>、阈值替换默认 80/分支 70。 -->

## Verification environment

<!-- 测试环境画像只记录能力与 Secret 引用，不记录密钥值。cap-understand 建初始画像；真实 ENV_BLOCKED 再补 confirmed-gaps。 -->

- runtime: <jdk8-maven3 | node20 | python3.11 | unknown>
- execution-zone: <local | docker | enterprise-runner | ci | unknown>
- package-registry: <public | corporate | none | unknown>
- credential-refs: [<引用名；无则 none>]
- network-endpoints: [<名称/用途；不写 Token>]
- composable-services: [<例如 mysql:8, redis:7；无则 none>]
- enterprise-services: [<例如 nacos-test、payment-sandbox；无则 none>]
- confirmed-gaps: [<真实执行确认的缺口；未知写 unknown>]
- authoritative-stage: <local-skills | docker | enterprise-runner | ci>


## Tech stack

<!--
  技术栈明细表，带"原因"列（为何选它）——帮助后续 feature 理解约束与取舍。
-->

| 层 | 技术 | 选它的原因 |
|----|------|-----------|
| <例如 前端> | <例如 Next.js> | <例如 SSR + 团队熟悉> |
| <例如 后端> | <例如 FastAPI> | <例如 异步 + 自动 OpenAPI> |
| <例如 数据> | <例如 Postgres> | <填写> |

## Surface map

<!--
  ★ 路由决策的可追踪输入。
  每个模块/面：globs（匹配的文件路径）→ 默认角色卡 → 默认 verify 验证项。
  进入 build/verify/review 时，git diff 的路径对照本表 + role-routing 规则，
  动态解析出本轮活跃角色与验证项（结果快照进 STATE.md，不在此持久化）。
  取值字典（单一事实源 = role-routing.md §3/§4，下面与之对齐）：
    roles  = client-dev | server-dev | design | qa | big-data
             （security 不是独立角色卡、不写进 surface 的 roles[]；敏感面由
              server-dev/qa 卡的 security 子节 + cap-review 安全 10 域承载——见 role-routing §3）
    checks = logic | journey:Web | journey:OpenAPI | journey:App | model
             （journey 子模态一律用冒号形式 journey:Web，与 role-routing §4 字典一致）
  下面为示例行，按实际仓库结构增删改。
-->

- web-frontend:  globs[ web/**, components/** ]   roles[client-dev, design]   checks[logic, journey:Web]
- mobile-app:    globs[ ios/**, android/** ]      roles[client-dev, design]   checks[logic, journey:App]
- api:           globs[ services/api/** ]          roles[server-dev]           checks[logic, journey:OpenAPI]
- ai-strategy:   globs[ models/**, strategy/** ]   roles[server-dev, qa]       checks[logic, model]
- data:          globs[ pipelines/** ]             roles[big-data]             checks[logic]

## Conventions

<!--
  项目约定：命名、目录结构、提交规范、代码风格要点、不可变/错误处理等本仓约束。
  source: gsd-map-codebase 的 conventions focus + startup-claude-md-init 的"禁止事项"。
-->

- <填写，例如：所有 API 响应用统一 envelope（success/data/error）>
- <填写，例如：禁止就地变更，始终返回新对象>

## Entry points

<!--
  关键入口：服务启动命令、主程序文件、路由表位置、配置入口、迁移命令等。
  让全新上下文的 agent 知道"从哪开始读/从哪开始跑"。
-->

- <填写，例如：服务启动 = uvicorn services.api.main:app>
- <填写，例如：路由表 = services/api/routes.py>
- <填写，例如：前端入口 = web/app/layout.tsx>

## Known risks

<!--
  已知风险/坑点：脆弱模块、技术债、性能热点、易踩的历史问题。
  source: gsd-map-codebase 的 concerns focus + arch-aifriendly-doctor 采证。
-->

- <填写，例如：orders 模块有 N+1 查询，改动时注意>
- <填写，例如：无 e2e 覆盖的支付回调，改动需手动验证>

## Deploy

<!--
  部署事实（cap-understand 只读探测；供 cap-release 用）。只记类型 + 配置位置，不抄密钥。
  source: 扫 vercel.json/Dockerfile/.github/workflows/部署脚本 + 目标工程 CLAUDE.md 部署段。
-->

- target-type: <static-site | container | vps | 未知>   # 决定加载哪个 targets/<type> 适配器
- config 位置: <例如 vercel.json / Dockerfile + k8s/ / deploy.sh>   # 项目特定值(项目名/集群/主机)在这些文件,ship 运行时抽
- 环境: <dev/staging/canary/full 各对应什么；如 staging=preview, full=prod>
- 密钥来源: <例如 env / secret-manager；只记来源,不记值>
- <未检测到部署配置 → 写 "none — 尚未配置部署">

## Evolution log

> 演进史（append-only，每特性退场由 cap-flow 的退场流程（intake.md Retire op）追加）见**同目录 `EVOLUTION.md`**。
> 本文件只留此指针——Evolution log 是无界流水，独立成文件，避免撑爆每会话整篇加载的 PROFILE
> （PROFILE 六节是有界快照、EVOLUTION.md 是无界流水，本性不同故分文件）。
> 与 `Known risks` 区别：Known risks = onboard 测绘的静态风险快照；EVOLUTION.md = 已完成特性沉淀的动态决策/教训。
