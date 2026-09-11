# capital-agent-skills

一套面向 Coding Agent 的结构化研发与经验飞轮。它把需求理解、开发计划、编码实现、独立验证、代码评审和发布交付串成可恢复的研发主线，并将每次交付中验证过的经验沉淀为团队可复用的知识。

它解决的不只是“让 Agent 写代码”，而是让 Agent 的研发过程可控、交付结果可信、工程经验能够持续积累。

> **状态**：v0.10.0，持续演进中。Skills 可以脱离 Cap Server 独立运行，支持 Windows、macOS、Linux，以及 Codex、Claude Code 和 Cursor，不锁定单一模型、平台或公司环境。

## v0.10.0 更新

新增本地 [Ontology 语义底座](ontology/README.md)：从真实 `.cap` 读取状态和证据声明，将知识按机构、项目、渠道、产品和协议版本隔离，并提供可解释的冲突、权限与验证裁决。详情见 [需求与验收矩阵](docs/specs/ontology-foundation.md)。当前交付是本地语义内核，未替代 Server 鉴权或自动实现 CI/CD。

## v0.9.7 更新

- 新增无需手工填写源码目录的升级命令：从 `~/.capital-agent/install-manifest.json` 自动读取已安装源码位置。
- 团队模式与本地模式分别提供升级和 Doctor 命令，避免把本地安装误升级到团队模式。

## v0.9.6 更新

- 收紧独立复核报告协议：由主流程写入固定机器头部并重新绑定 Commit、指纹和源码未变证据。
- 非标准字段、缺失指纹或只有自然语言“已完成”的报告会保持阻断，不能冒充 Review PASS。

## v0.9.5 更新

- L3/L4 或命中支付、安全、权限、跨仓、MCP、状态机等高风险信号时，评审前自动启动 1 个全新上下文的只读复核 Agent。
- 独立复核绑定 source/base Commit 与工作区指纹，报告与主评审隔离；启动失败、证据过期或运行时不支持隔离时不伪造 PASS。
- L1/L2 简单改动保持原有短路径，不额外启动 Agent。

## v0.9.4 更新

- 跨项目切换会原子复制已审阅交接摘要；摘要缺失或落地失败时不改变原主仓。
- 新 Task 会记录目标仓原有脏路径，计划修改范围与旧改动重叠时主动阻断，避免混合提交。
- 旧项目已跟踪 `.cap` 活动态时不再静默移入 ignored 目录，避免一次 Task 切换制造大量 Git 删除。

## v0.9.3 更新

- 将项目本地 `.cap` 纳入所有研发阶段的必选前置：锁定 Git 根目录，核对任务、分支、工作树、计划、评审、验证和未完成门禁。
- 明确双模式闭环：团队/Server 模式使用 `enrich_context` / `record_experience`；显式本地模式不调用 MCP，改用并校验本地 `.cap/experience.md`。
- 交付前统一复核实际改动、diff、验证结果和 `.cap` 证据，减少上下文串台、重复调查和经验丢失。

## v0.9.1 更新

- 支持在同一聊天中显式切换到另一个独立项目继续开发，同时保留唯一可写主仓和误提交保护。
- 跨项目只传递带来源项目、Commit 和待验证状态的业务交接摘要；目标项目重新建立 Task、Session、代码事实和验证证据。
- 同一项目的不同 clone/worktree 仍需新会话，旧项目的 Gate、Delivery 和 Outbox 不会串到新项目。

## v0.9.0 更新

- 新增 Windows 10/11 原生 PowerShell 安装、升级和 Doctor 入口，不要求 WSL。
- Windows 支持 Skill/MCP 配置、Git 交付、团队 Task 与知识闭环；关键阶段门禁提供纯 Node 入口。
- Windows 本机独立 Test Provider 暂不启用，可信 Test/Review 交给 Server/Linux Runner；macOS/Linux 的本机 Provider 与现有全量门禁保持不变。

## v0.8.1 更新

- 会话首次进入仓库会锁定 canonical Git root；切换到另一个独立项目必须显式执行交接切换，同一项目的 worktree 或绝对路径仍不能导航主仓。
- 入口、阶段门禁和 Git Commit 三层共同阻断跨目录读写与误提交；B 目录即使拥有与自身完全一致的遗留 STATE，也不能覆盖 A 会话的仓库身份。
- 没有稳定会话 ID 的宿主保持原有可移植行为，继续使用 branch/worktree STATE 边界，不影响既有安装和本地模式。

## v0.8.0 更新

这一版本把“任务总结”升级为真正面向下一次 Agent 的经验原稿：

- 每个完成任务形成可逐字审计的 `.cap/experience.md`，不再从规格、STATE 或调用链自动猜经验。
- 原稿同时沉淀召回线索、根因、决策规则、实现锚点、不变量、验证配方和失效信号，让后续 Agent 能直接用于定位、实现与验收。
- 只有调用链、宽泛结论、缺少同 Commit 证据或不可观察验证结果时明确阻断，不用低质量内容凑沉淀数量。
- 本地模式同样生成并归档经验原稿，下一任务可先从历史索引自动命中再读取精确原稿；团队模式在此基础上同步中心知识库，本地与团队使用同一质量标准。

## v0.7.3 更新

这一版本建立了结构化经验的确定性 Server 载荷；v0.8.0 进一步补齐可审计原稿与 AI 可用质量契约：

- 从规格、决策、验证和评审证据确定性生成结构化经验，不再依赖模型二次萃取。
- 证据不完整时明确阻断沉淀，不产生看似成功、实际不可召回的 draft。
- 外发前限制证据路径并脱敏敏感值；经验是否发布仍由同 Task、同 Commit 的 Server Gate 决定。

## v0.7.2 更新

这一版本让客户端展示与平台真实状态保持一致：

- 平台可用时，阶段、状态和下一动作以 Server canonical projection 为准，并纠正本地游标。
- 只有最终候选 Commit 与对应 Test Action 同时成立时，才显示“平台正在测试验证”。
- Server 已幂等接收普通 Delivery 时，客户端自动清理对应 Outbox，不再重复补报。

## v0.7.1 更新

这一版本把经验闭环从“能够召回”收紧为“能够证明被采用”：

- Task 冻结快照与本轮实际注入都提供同一知识 ID，只有交集才能记为采用。
- 经验晋级只相信同一 Task、同一 Commit 的 Server Gate，客户端自报 PASS 不再直接发布。
- 升级与 Doctor 会识别并隔离旧 Codex Skill，避免新旧流程在同一客户端混用。

## v0.6.5 更新

这一版本建立了经验闭环的服务端契约；v0.7.1 进一步补齐真实客户端 ID 传递和可信发布门禁：

- 完整结构化经验直接进入知识库，不再被不必要的模型二次萃取阻断。
- 沉淀与离线重放共享稳定幂等身份，重复请求不会重复累计经验和指标。
- 后续任务只对实际采用的知识精确归因，并绑定来源 Task、冻结知识快照与最终 Gate 结果。
- 服务端具备“第一次踩坑、第二次精确召回并首轮通过”的证据模型；真实 MCP 客户端链路由 v0.7.1 补齐。

## v0.6.4 更新

这一版本重点收紧了 Skills 的真实可用性和交付边界：

- **本地使用更稳**：没有 Cap Server 也能完整运行研发主线，新仓库尚未产生首个 Commit 时也可以直接开始。
- **安装诊断更可信**：Doctor 会检查各客户端实际注册的 Skills 与 MCP，明确暴露旧路径或连接问题，不再出现“看起来正常、实际不可用”。
- **团队交付边界更清楚**：业务项目继续使用独立 Test / Review Gate；Skills 和工具仓只保留本地维护证据，不会误触发业务测试任务。
- **使用方式保持不变**：仍然只需描述研发目标；本地模式和团队增强模式使用同一套流程，可以按团队需要平滑升级。

具体修复和兼容性说明见 [CHANGELOG](CHANGELOG.md)。

## 它解决什么问题

普通 Coding Agent 已经能快速生成代码，但真实研发还面临几个更难的问题：

- **过程容易失控**：需求、计划、实现、测试和评审散落在对话中，长任务容易偏航，换会话后难以继续。
- **结果缺少可信证据**：Agent 既写代码又给自己判定通过，本地测试、代码评审与真实 Commit 之间缺少稳定绑定。
- **经验无法形成复利**：一次任务中发现的好方法和踩过的坑，往往随着会话结束而消失，下个人还会重新摸索。
- **工具之间难以迁移**：流程绑定某个 CLI、模型或专有能力后，团队很难形成统一研发方式。

Capital Agent Skills 在 Coding Agent 之上补齐研发流程、可信门禁、持久状态和知识积累层，让 Agent 从“代码生成工具”走向可协作、可验证、可持续改进的研发执行者。

当前仓库同时维护一层轻量 `ontology/` 语义契约：它从 Skills 提取研发实体、关系、状态、策略和证据，供本地 Agent 消费，并作为未来 Server/Platform 投影的稳定中间层。Ontology 与 Skills 一起版本管理，但不替代 Skills；`.cap/` 保存这些概念在具体项目和任务中的实例。

## 核心能力

### 完整的 Agent 研发主线

研发只需描述目标，系统会根据任务复杂度组织项目了解、需求确认、开发计划、编码实现、测试验证、代码评审和发布上线。简单任务走轻量路径，复杂任务保留完整阶段与门禁。

### 与真实代码版本绑定的可信交付

本地模式会把测试、评审和发布证据随研发状态保存；接入 Cap Server 后，编码、测试和评审进一步职责分离，由独立 Test / Review Harness 针对精确 Commit 产出可信 Gate。出现问题时，修复产生新 Commit，并重新进入验证闭环。需要连续处理不同项目时，可显式切换唯一可写主仓；目标项目重新建立 Task、Session 和验证事实，来源项目只通过带来源 Commit 的交接摘要提供业务线索。

团队模式下，统一 Task 是唯一业务真值：普通开发 Commit 只记录过程，最终候选 Commit 才进入 Test → Review；客户端直接展示当前 Commit、阻塞原因、处理动作与最终证据，不再从历史 Action 猜测状态。Provider 健康由实时心跳和容量推导，过期执行器不会继续显示为可用。

### 可恢复的持久研发状态

需求、计划、阶段游标和验证证据保存在仓库文件中，而不是依赖不断膨胀的聊天上下文。任务可以跨会话、跨 Agent 接力，也能在中断后从明确阶段继续。

### 跨会话、跨团队的经验飞轮

会话开始时注入与当前任务相关的历史经验，完成后沉淀经过验证的问题、解法和证据。个人经验由此进入团队知识库，在后续项目中被再次检索、采用和校正。

### 开放且可移植

流程由纯文件 Skill 和清晰协议组成，核心研发主线不依赖 Cap Server，支持 Codex、Claude Code、Cursor 及其它兼容 CLI。个人、开源团队和其他公司都可以只使用本地能力，也可以接入自己的 Git、CI、测试和发布环境。

## 两种使用模式

Cap Server 是可选的团队增强层，不是运行 Skills 的前置条件。

| 能力 | 本地模式（无 Cap Server） | 团队增强模式（接入 Cap Server） |
|---|---|---|
| 结构化研发主线 | 支持 | 支持 |
| `.cap/` 持久状态与跨会话接力 | 支持 | 支持 |
| 本地测试、代码评审和发布流程 | 支持 | 支持 |
| 可审计的本地经验原稿与任务归档 | 支持 | 支持 |
| 自有 Git / CI / 测试环境 | 可直接接入 | 可直接接入 |
| 统一 Task 与团队看板 | — | 支持 |
| 跨成员中心知识库 | — | 支持 |
| 独立 Test / Review Harness Gate | — | 支持 |
| 经验归因与效果统计 | — | 支持 |
| 线上运行版本、Schema 与存储模式证明 | — | 支持 |

没有 Server 时，测试和评审结论属于本地研发证据；接入 Server 后，才能获得绑定同一 Commit 的独立 Provider Gate。两种模式使用同一套研发阶段和文件协议，后续可以平滑升级，不需要重建流程。

判断团队模式是否真正完成，不看 Session 是否结束，也不看 Agent 自己说“已通过”，只看当前候选 Commit 的必需 Server Gate 是否全部通过。平台不可用时会明确降级为本地证据，不冒充团队可信交付。

## 工作方式

完整的端到端状态边界见[研发流程总览](docs/研发流程总览.md)，中断、离线和验证阻塞的处理步骤见[故障恢复手册](docs/故障恢复手册.md)。

```text
描述研发目标
    ↓
理解项目与确认需求
    ↓
计划 → 实现 → 独立测试 → 独立评审
    ↓                       ↑
    └──── 发现问题 → 修复新 Commit ────┘
    ↓
发布交付 + 沉淀可复用经验
```

本地模式下，整个流程由 Git、项目命令和 `.cap/` 文件驱动。MCP 可用时，Skills 会进一步自动创建或绑定统一 Task，关联真实 Commit、独立验证证据和经验记录。两种模式下代码正文都只通过 Git 交付。

## 安装

### 本地模式：没有 Cap Server

克隆仓库后运行本地安装命令，不需要配置 MCP、平台地址或个人凭据：

```bash
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
cd capital-agent-skills
bash scripts/setup.sh --local
```

Windows 10/11 使用 PowerShell（需要 Git for Windows、Node.js 18+；完整需求树与任务退场操作另需 Python 3，可通过 `py -3` 调用）：

```powershell
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
Set-Location capital-agent-skills
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local
```

升级和诊断：

```bash
bash scripts/setup.sh --local --upgrade
bash scripts/setup.sh --local --doctor
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local --upgrade
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local --doctor
```

已有本地模式安装时，也可以在任意目录直接运行下面的自动定位命令（不需要重新 `git clone`，也不需要填写源码路径）：

macOS / Linux：

```bash
CAPITAL_AGENT_SRC="$(node -e 'const fs=require("fs");const p=process.env.HOME+"/.capital-agent/install-manifest.json";console.log(JSON.parse(fs.readFileSync(p,"utf8")).sourceRoot)')" && bash "$CAPITAL_AGENT_SRC/scripts/setup.sh" --local --upgrade && bash "$CAPITAL_AGENT_SRC/scripts/setup.sh" --local --doctor
```

Windows PowerShell：

```powershell
$src = (Get-Content "$HOME\.capital-agent\install-manifest.json" | ConvertFrom-Json).sourceRoot; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$src\scripts\setup.ps1" --local --upgrade; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$src\scripts\setup.ps1" --local --doctor
```

安装或升级后，请完全退出并重新打开 ChatGPT/Codex/Claude/Cursor，再新建任务使用新版本。已打开的会话不会可靠地热加载 Skill；现有 Git 分支和工作区改动不会丢失。

安装后直接在任意 Git 项目中描述研发任务，Skills 会以显式本地模式运行。平台握手、中心知识注入、Task、MCP、独立 Harness、Delivery 和 Outbox 会主动跳过，不影响项目了解、需求确认、计划、实现、本地验证、评审和发布流程；完成任务仍会生成并归档本地 `.cap/experience.md`。

### 团队增强模式：接入 Cap Server

有 Cap Server 时，推荐使用一键安装器。它会打开浏览器完成授权，并自动配置 Codex、Claude Code、Cursor 与 Capital Agent MCP；macOS/Linux 同时配置本机 Test Provider：

```bash
bash /path/to/capital-agent-skills/scripts/setup.sh --server "https://your-server"
```

Windows 团队模式需要 Node.js 20.18.1+，本机不启用独立 Test Provider，Test/Review Gate 由 Server/Linux Runner 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --server "https://your-server"
```

升级和诊断：

```bash
bash scripts/setup.sh --upgrade
bash scripts/setup.sh --doctor
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --upgrade
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --doctor
```

已有团队模式安装时，可在任意目录自动读取安装清单并升级：

macOS / Linux：

```bash
CAPITAL_AGENT_SRC="$(node -e 'const fs=require("fs");const p=process.env.HOME+"/.capital-agent/install-manifest.json";console.log(JSON.parse(fs.readFileSync(p,"utf8")).sourceRoot)')" && bash "$CAPITAL_AGENT_SRC/scripts/setup.sh" --upgrade && bash "$CAPITAL_AGENT_SRC/scripts/setup.sh" --doctor
```

Windows PowerShell：

```powershell
$src = (Get-Content "$HOME\.capital-agent\install-manifest.json" | ConvertFrom-Json).sourceRoot; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$src\scripts\setup.ps1" --upgrade; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$src\scripts\setup.ps1" --doctor
```

安装器会幂等更新受管理配置，保留已有个人规则和其它 MCP Server；同时检查并选择兼容的 Node.js 运行时。安装或升级后建议完全退出并重新打开 ChatGPT/Codex/Claude/Cursor，再新建任务让 MCP 生效。若团队配置已经存在、但当前会话没有加载 Capital Agent MCP，Skills 会让用户选择“重启后使用团队模式”或“本次明确改用本地模式继续”；本地继续不会修改机器配置，但本任务不创建平台 Task、不回写经验或 Server Gate。需要手工连接自建 Server 时，参见 [MCP 接入说明](skills/harvest-experience/references/setup-mcp.md)。

平台地址和个人身份只保存在研发机器配置中。开源仓库不内置公司地址、个人凭据或项目代码。

## 怎么用

安装后正常描述研发任务即可：

```text
实现订单退款功能
修复登录偶发失效的问题
给这次改动补测试并做代码评审
把已经通过评审的版本发布到测试环境
```

Git 仓库中的实现、修复、重构、测试、评审和发布请求会自动进入 Cap；纯问答、讨论和调研不会创建平台 Task。

没有 Cap Server 时，“自动进入 Cap”表示启动本地研发主线，不会尝试创建远程 Task，也不会阻塞工作。团队未来接入 Server 后，继续使用相同命令即可获得中心知识库和可信 Gate 增强。

需要显式启动时，Codex 使用 `$cap`，Claude Code 使用 `/cap`。也可以使用 `/cap 需求`、`/cap 计划`、`/cap 开发`、`/cap 测试`、`/cap 评审`、`/cap 发布` 等直白表达，不需要记忆内部 Skill 名称。

维护或发布 Skills 前运行完整本地门禁：

```bash
bash scripts/release-check
```

该命令在显式本地模式下统一执行结构检查、Node/Python 行为回归、并发与安全边界测试以及补丁检查；任一失败都不得升级版本或打标签。

安装或升级会在 `~/.capital-agent/install-manifest.json` 记录源码 Commit、插件版本和受管理文件哈希。Doctor 会比较当前运行源码与安装清单；如果显示“源码 Commit 漂移”“文件内容漂移”或“运行副本与源码目录不一致”，先运行升级命令，再完全退出并重新打开客户端。

## 演进方向

- [x] 建立覆盖需求、实现、验证、评审和发布的 Agent 研发主线
- [x] 建立与真实 Commit 绑定的独立测试和评审机制
- [x] 建立跨会话、跨项目、跨团队积累的工程经验飞轮
- [x] 建立统一 Task、候选 Commit、独立 Gate 与运行版本证明的业务真值链路
- [ ] 完善人类与 Agent 协作效能的可观测体系
- [ ] 持续衡量知识积累对研发质量和效率的提升
- [ ] 扩展更多执行环境、验证能力和交付目标

## License

MIT。见 [LICENSE](LICENSE)。
