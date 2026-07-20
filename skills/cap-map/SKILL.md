---
name: cap-map
description: >
  研发主线的 brownfield 入口阶段。把一个【已有项目】测绘成机器可路由的工程记忆——产出
  <target-repo>/.cap/PROFILE.md(技术栈 / 约定 / 入口 / 已知风险 + ★surface-map:模块→glob→默认角色→验证项;
  + AI-readiness 体检 + 部署探测)。surface-map 是改动代码路由的可追踪输入。
  触发场景:用户说 "map 这个项目"、"给这个仓库建 PROFILE"、"扫一下这个 codebase"、"分析已有项目准备走流程"、
  "建立工程记忆"、"cap-map";cap-flow 判定为 brownfield(无 PROFILE 且 repo 非空)时也路由到此。
  也可独立调用,为现有项目首次建立工程记忆。
  本阶段只测绘并写 PROFILE.md(只读源码),不分叉 / 不写 spec / 不拆任务。四阶段管道(采证→类型→surface-map→聚合)见正文。
---

# cap-map — brownfield 入口：测绘已有项目 → PROFILE.md

你是主线的**测绘师**。一个已有项目第一次走这套流程时,cap-flow 先把你叫进来。你的唯一交付物是
`<target-repo>/.cap/PROFILE.md` —— 项目级、长寿、被之后**每个**特性共享的记忆。其中最关键的是
**surface-map**(模块 → glob → 默认角色 → 验证项),它是改动代码路由的可追踪输入。

> **定位**:PROFILE = 项目级、建一次、共享;STATE = 特性级、短寿、每任务交接。本阶段只写 PROFILE,**不碰 STATE**。
> **只读纪律**:测绘期间**只读源码、只陈述代码里能查证的事实**,不改代码、不提改进建议、不臆测意图。唯一写动作 =
> 结尾写 `.cap/PROFILE.md`。改进是后续特性的事,不在测绘阶段做。

---

## 可移植约定

> **共享 references 的位置**:本文提到的 `role-routing.md`、`roles/<role>.md`、`templates/*.md` 物理上都在
> cap-flow 编排器目录下(`cap-flow/references/`),不在本阶段目录里。解析路径一律指向 `cap-flow/references/...`
> (相对 skills 根),或经软链接定位——别当作相对本目录去读。验证项 playbook 则在 `cap-verify/checks/`。

- **交互**:凡需用户拿主意(确认技术栈推断、确认 surface-map 草案、确认新建还是刷新),用纯文本编号列表。
- **并行**:采证阶段可拆成 4 个正交视角(stack / arch / conventions / concerns)。有并行能力就 fan-out,各自把发现
  写进各自的临时笔记(`.cap/map-notes/<focus>.md`),最后聚合成单一 PROFILE.md;没有就串行逐视角跑同一份清单。
  **产物永远是单一聚合的 PROFILE.md**,并行只是加速采证,不改变交付形态。

---

## 1. 入口条件

进入本阶段应满足(cap-flow 判定,独立调用时自检):

| 条件 | 要确认的事 |
|---|---|
| repo 非空(有真实代码) | 目录里有源码文件。别只信 `git ls-files`——目标可能是未跟踪子目录或刚克隆未 init,只看跟踪文件会误判空仓;拿不准就直接列文件。 |
| 尚无 PROFILE.md,或用户要求刷新 | `<repo>/.cap/PROFILE.md` 不存在;或架构漂移触发(见 §6) |

两种入口模式:

- **新建**(无 PROFILE)→ 走完整 Phase A→D。
- **刷新**(PROFILE 已在,漂移触发)→ 只重跑受影响视角 + 重算 surface-map 相关行,**保留** Conventions /
  Known-risks 里仍成立的条目(追加 / 收紧,不盲删)。

入口先用编号文本报告并确认:

```
.cap/PROFILE.md: <无 / 已存在>
repo: 非空(检测到 <N> 个被跟踪文件)
→ 模式:<新建 / 刷新(架构漂移:<触发面>)>
  1) 按上述模式开始(推荐)
  2) 改为只跑一次现状审计(交回 cap-flow: cap-verify --check=journey --scope=full-chain)
回个编号。
```

---

## 2. 步骤流程（四阶段管道）

```
Phase A 采证(纯 bash) → Phase B 类型+入口识别 → Phase C 自建 surface-map → Phase D 聚合写 PROFILE.md
```

### Phase A — 采证（先把证据收齐，再下判断）

**目标**:在归类型、建 surface-map 之前先收齐客观证据——靠仓库里查得到的事实,不靠印象。**怎么采你定**
(grep / find / wc / git 这类只读工具);本阶段只约束**采什么**、**避哪些坑**。

按 4 个正交视角采证,每个视角要回答:

| 视角 | 要查证的问题 |
|---|---|
| **stack** | 有哪些语言 / 包管理器 / 依赖清单?用了什么框架?接了哪些外部系统(DB / 队列 / AI API)? |
| **arch** | 顶层结构长什么样?系统从哪启动(入口 / 路由 / CLI / 容器编排)? |
| **conventions** | 有无 CLAUDE.md / AGENTS.md / README?测试怎么组织、用什么命令跑?有无覆盖率门? |
| **concerns** | 改动热点在哪(超大文件)?敏感面(认证 / 支付 / 密钥 / 原始 SQL)在哪?调试残留 / TODO 多不多? |

**顺带探测需求树**:若 `<target-repo>/.cap/requirements/` 存在,说明该项目已建过需求树——在 PROFILE 记一句
"已有需求树(N 片叶,可经 intake 的 Coverage 看迁移进度)"。无则忽略。

**采证原则(避坑)**:

- **排噪声再统计**:`node_modules` / 构建产物(`dist` `build` `out` `.next`)/ 运行时产物(`memory/` `archive/`
  `.backups/`)不是源码;统计大文件、顶层结构时先剔掉,否则会把产物当源码。
- **别只扫根目录**:monorepo / 子目录前端(如 `web/package.json`)只看根会误判"无栈";依赖清单要连嵌套一起找。
- **只读不写**:采证阶段不碰源码、不下评分、不提改进。输出落临时笔记(并行)或内存(串行)。

### Phase B — 类型识别 + 入口定位

1. **读关键文档**:README + CLAUDE.md / AGENTS.md → 项目一句话定位(只取代码 / 文档里能查证的事实)。
2. **定类型**(按最显著信号归类,混合取权重最高):
   - 工程 / 基础设施(database / engine / framework / library / SDK / server)。
   - Agentic / AI **代码**(agent / LLM / prompt / RAG / eval 的可执行实现)→ 大概率含 `ai-strategy` 面 + `model` 验证项。
   - **配置 / agent 定义型**(源主要是 agents / workflows / roles 的**声明式** JSON / YAML / SKILL.md,真实代码很少)→
     默认 `server-dev` + `logic`,验证靠 schema / 契约一致性校验,**不跑 model 验证项**(它不是 AI 模型代码);
     内嵌的真实代码(*.py / *.ts)按其类型单独归面。
   - 通用 / 其他(CLI / 工具 / 脚手架)。
3. **定入口**:找出"系统怎么启动"的最小文件集——启动文件、路由表、CLI 命令、配置入口、迁移命令。
4. **提测试命令抽象**:从 Phase A 的 scripts / pyproject 线索归纳出 `{ unit, coverage, e2e, typecheck, build }`
   (语言无关命令,cap-verify 的 logic 检查据此发现并运行套件)。

> 三级解释纪律:先一句话定位 → 五分钟高层(任务 / 输入 / 输出 / 关键文件)→ 深入(代码流 / 边界)。把这三级
> 沉淀进 PROFILE 的对应小节,不另出报告。

### Phase C — 自建 surface-map（★核心，无外部源）

这是本流程独有、必须自建的那张表:**模块 / 面 → globs → 默认角色 → 默认验证项**。

构建步骤:

1. 从 Phase A 的顶层结构 + Phase B 的入口,切出**有意义的面**(一个面 = 一类会一起改、共享角色 / 验证策略的代码区)。
2. 给每个面写 **globs**(POSIX / gitignore 语义)。
3. 用 `cap-flow/references/role-routing.md` 的规则 + 取值字典,给每个面**推荐默认角色 + 默认验证项**:
   - 角色字典:`client-dev | server-dev | design | qa | big-data | architect | ai-readiness | skill-maintainer`
     (architect 跨 ≥2 面时加载;ai-readiness 由体检加载;skill-maintainer 仅当被测绘的仓是本技能体系自身时才用;
     security 不单列,敏感面由 server-dev / qa 卡的 security 子节承载)。
   - 验证项字典:`logic | journey:Web | journey:OpenAPI | journey:App | model`。
4. **项目特化优先于通用规则**:这张表写进 PROFILE 后,路由时**覆盖** role-routing 的通用兜底。所以要尽量贴合本仓
   真实结构,不要照抄模板示例。

把 Phase A/B 命中的信号映射成面(典型示例,按实际增删):

| 信号(Phase A 发现) | surface 名 | globs(按实际) | 默认角色 | 默认验证项 |
|---|---|---|---|---|
| 前端目录(tsx / vue / components / pages / app) | web-frontend | `web/**`, `components/**`, `app/**` | client-dev, design | logic, journey:Web |
| 原生 / 跨端移动(swift / kt / dart / ios / android) | mobile-app | `ios/**`, `android/**`, `mobile/**` | client-dev, design | logic, journey:App |
| 服务端接口(api / handlers / routes / controllers) | api | `services/api/**`, `**/handlers/**` | server-dev | logic, journey:OpenAPI |
| AI / 模型 / 策略 / prompt / evals | ai-strategy | `models/**`, `strategy/**`, `prompts/**`, `evals/**` | server-dev, qa | logic, model |
| 数据管道 / 数仓 / 迁移(sql / pipelines / etl) | data | `pipelines/**`, `**/*.sql`, `migrations/**` | big-data | logic |
| 配置 / agent 定义(声明式定义) | agent-config | `agents/**.json`, `workflows/**.json`, `roles.json`, `**/SKILL.md` | server-dev(含授权矩阵时 +security) | logic |

5. **surface-map 自检**(三条硬约束,违反则回 Phase A 补采证):
   - [ ] 每个被跟踪的、含代码的顶层目录,要么落进某个面,要么明确归为"未归类"(不能静默丢)。
   - [ ] 每个面的角色 / 验证项取值都在字典内(无野值)。
   - [ ] globs 之间尽量不歧义(一个 path 命中多面是允许的,取并集)。

### Phase D — 聚合写 PROFILE.md + 自检

1. 把模板 `cap-flow/references/templates/PROFILE.md` 复制到 `<target-repo>/.cap/PROFILE.md`(目录不存在先建)。
2. 删掉模板的注释块与所有占位,按 Phase A-C 的实测结果填:
   - 顶部 `tech-stack` + `test-commands`(Phase B 的命令抽象)。
   - `## Tech stack`(带"原因"列:每个技术为何选它)。
   - `## Surface map`(Phase C 产物,用模板的 `面: globs[...] roles[...] checks[...]` 行格式)。
   - `## Conventions`(Phase A conventions 视角 + 禁止事项)。
   - `## Entry points`(Phase B 入口集,让全新 agent 知道从哪开始读 / 跑)。
   - `## Known risks`(Phase A concerns 视角:大文件热点、无测试覆盖的危险面、N+1 等)。
   - `## AI-readiness 体检`(★只读评分,加载 `cap-flow/references/roles/ai-readiness.md` 的 10 维):对照 CLAUDE.md
     级联 / scoped 命令 / 噪声 / 类型 / 测试 / LSP 就绪等,给一个健康分 + 缺口清单。**只评估、不整改**。
     - **低分软推荐**:健康分 < 阈值(默认 7/10)→ 写完 PROFILE 后用编号文本**软推荐**起一个 remediation 特性
       补缺口(CLAUDE.md 级联 / scoped 命令 / 类型 baseline / 测试 baseline)。整改走标准主线(L1 + 文档 / 配置改动
       可跳 TDD,但 review / verify 门不短)。**只推荐、不强制**,onboard 本身不因低分阻断。
   - `## Deploy`(只读探测,供 cap-release 用):扫 `vercel.json` / `netlify.toml` / `Dockerfile` + k8s manifests /
     `.github/workflows/*deploy*` / 部署脚本 / 目标工程 CLAUDE.md 的部署段 → 判**部署目标类型**(static / container /
     vps / 未知)+ 记关键**配置位置**(项目名 / 集群 / 主机在哪个文件)。**只记位置与类型,不抄密钥、不臆造**;探不到
     就写"未检测到部署配置"。
3. 清理临时笔记(`.cap/map-notes/` 若用过)。
4. 编号文本把 surface-map 草案给用户确认,改完再定稿。
5. **脚手架自检 — 先补任务关联 Hook,再询问三个硬门 Hook**。
   - 对所有 Git 仓静默运行 package 根 `scripts/install-git-governance.mjs`。它幂等安装
     `prepare-commit-msg`,保留并先执行项目原 Hook,只负责把 `.cap/STATE.md` 的有效 `Task:` / `Session:`
     trailer 自动追加到 Commit;失败时明确提示但不阻断 map。
   - 然后询问三个可选硬门 Hook(纯 shell,不跑 AI、无密钥;由 **git 执行,模型绕不过**)。检测
   `<repo>/.git/hooks/{pre-commit,pre-push,post-checkout}` 是否已是本流程的。缺则用编号文本问:
   ```
   要装这三个硬门吗?(git 自动跑,模型绕不过)
     · pre-commit:边界守卫 —— commit 前查 STATE 与当前 branch/worktree 是否串台
     · pre-push:流程检查 —— push 前核对 verify + review 已过(读 cap-gate 行)
     · post-checkout:叶状态 flush —— 切分支时把在飞特性源叶 status 固化落盘(无需求树则空跑)
     1) 都装(推荐)  2) 只装 pre-commit  3) 只装 pre-push  4) 只装 post-checkout  5) 跳过
   ```
   硬门选装 → 把 `cap-flow/references/templates/hooks/{pre-commit,pre-push,post-checkout}` 拷到 `<repo>/.git/hooks/`
   并 `chmod +x`;**仅 git 仓装**。pre-commit 调 `cap-guard`(脚本在 `cap-flow/scripts/cap-guard`);为让 hook 在
   任何安装方式下都能找到,把它拷 / 软链到 `<repo>/.cap/bin/cap-guard`(hook 优先找这里)。post-checkout 调
   `intake.py set-status` 做 flush。装完一句话说明各自管什么。

---

## 3. 读写哪些 .cap/ 文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `<repo>/.cap/PROFILE.md` | **写(主交付物)** | 据模板填实测结果 |
| `cap-flow/references/templates/PROFILE.md` | 读 | PROFILE 模板 |
| `cap-flow/references/templates/hooks/{pre-commit,pre-push,post-checkout}` | 读 | 三个硬门模板,用户同意后拷贝 |
| `cap-flow/references/role-routing.md` | 读 | 规则表 + 取值字典 |
| package 根 `scripts/install-git-governance.mjs` | **执行(git 仓)** | 幂等安装 `prepare-commit-msg`,自动追加 Task/Session trailer |
| `<repo>/.git/hooks/prepare-commit-msg` | **写(git 仓)** | 任务关联 Hook;保留并先执行项目原 Hook |
| `<repo>/.git/hooks/{pre-commit,pre-push,post-checkout}` | **写(仅用户同意 + git 仓)** | 纯 shell 硬门;装完即与流程解耦 |
| `<repo>/.cap/map-notes/<focus>.md` | 临时写 / 读(可选) | 并行采证的中转笔记,聚合后删除 |
| `<repo>/.cap/STATE.md` | **不碰** | STATE 是特性级,由 cap-flow 单写 |

---

## 4. 出口门控

PROFILE.md 视为合格、可交回 cap-flow,需**全部**通过:

- [ ] `<repo>/.cap/PROFILE.md` 存在,无残留占位 / 注释块。
- [ ] `tech-stack` + `test-commands` 已据实填。规则:**有套件就必须抓到对应命令**;**没有套件不是阻断,但必须显式
  标 `none`**(如 `unit: "none — 项目无测试套件"`),并在 `## Known risks` 记一条覆盖率缺口。绝不留空白——brownfield
  真项目常零测试,这恰恰最需要建 baseline,不能卡在门口。
- [ ] `## Surface map` 通过 Phase C 三条自检(覆盖全、取值合法、无歧义)。
- [ ] 每个 surface 的角色 / 验证项落在 role-routing 字典内。
- [ ] `## Entry points` 至少给出一个可执行的启动线索。
- [ ] surface-map 草案已经用户确认。
- [ ] **只读纪律守住**:测绘期间未修改任何源码;写动作仅限 PROFILE(+临时笔记)+ 用户同意后装的 hook(在
  `.git/hooks/`,非源码)。
- [ ] (若为 git 仓)`prepare-commit-msg` 已幂等确保;三个硬门已询问,用户选了才装。

任一未过 → 停在门口,用编号文本列出缺项让用户补全或确认。

---

## 5. 写什么进 STATE（经由 cap-flow，不自己写）

本阶段**不直接写 STATE.md**。完成后向 cap-flow 返回以下结果,由它落进 STATE:

- `stage: map` → 完成后建议下一步设为 `shape`(brownfield 主线:map → shape)。
- Gates passed:勾选 `map:PROFILE.md 已建立 / 已确认无漂移`。
- Next action:`-> cap-shape`(开始第一个特性),或若用户只想审计现状 → `-> cap-verify --check=journey --scope=full-chain`。
- 告知 cap-flow:PROFILE.surface-map 已就绪,后续进 build / verify / review 时可被路由解析消费。

返回话术:

```
✅ map 完成。
  - 写出:<repo>/.cap/PROFILE.md
  - surface-map:<N> 个面(<列出面名>)
  - 下一步建议:开始第一个特性 → cap-shape
交回 cap-flow:stage=map 完成,next=cap-shape。
```

---

## 6. 架构漂移刷新（refresh 模式）

cap-flow 在会话开始会拿 `git diff` 路径对照 PROFILE.surface-map;若改动触及 map 里没有的面(新建服务、首个移动
目录),会**重新路由到本阶段做局部刷新**:

1. 只对**漂移触及的面**重跑 Phase A 相关视角 + Phase B 入口识别。
2. 在 surface-map **新增 / 收紧**对应行(追加 / 收紧,不推翻整张表)。
3. Conventions / Known-risks 里仍成立的旧条目**保留**;只追加新发现。
4. 同样过 §4 出口门控 + 用户确认后交回 cap-flow。

> 这让"已跟踪的架构"保持诚实,而不必重头测绘整个项目。
