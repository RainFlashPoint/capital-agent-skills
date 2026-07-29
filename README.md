# capital-agent-skills

一套面向 Coding Agent 的结构化研发与经验飞轮。它把需求理解、开发计划、编码实现、独立验证、代码评审和发布交付串成可恢复的研发主线，并将每次交付中验证过的经验沉淀为团队可复用的知识。

它解决的不只是“让 Agent 写代码”，而是让 Agent 的研发过程可控、交付结果可信、工程经验能够持续积累。

> **状态**：v0.4.8，持续演进中。支持 Codex、Claude Code 和 Cursor，不锁定单一模型或运行时。

## 它解决什么问题

普通 Coding Agent 已经能快速生成代码，但真实研发还面临几个更难的问题：

- **过程容易失控**：需求、计划、实现、测试和评审散落在对话中，长任务容易偏航，换会话后难以继续。
- **结果缺少可信证据**：Agent 既写代码又给自己判定通过，本地测试、代码评审与真实 Commit 之间缺少稳定绑定。
- **经验无法形成复利**：一次任务中发现的好方法和踩过的坑，往往随着会话结束而消失，下个人还会重新摸索。
- **工具之间难以迁移**：流程绑定某个 CLI、模型或专有能力后，团队很难形成统一研发方式。

Capital Agent Skills 在 Coding Agent 之上补齐研发流程、可信门禁、持久状态和知识积累层，让 Agent 从“代码生成工具”走向可协作、可验证、可持续改进的研发执行者。

## 核心能力

### 完整的 Agent 研发主线

研发只需描述目标，系统会根据任务复杂度组织项目了解、需求确认、开发计划、编码实现、测试验证、代码评审和发布上线。简单任务走轻量路径，复杂任务保留完整阶段与门禁。

### 与真实代码版本绑定的可信交付

编码、测试和评审职责分离。独立 Test / Review Harness 针对精确 Commit 产出证据，避免 Agent 自测、自评、自签通过；出现问题时，修复产生新 Commit，并重新进入验证闭环。

### 可恢复的持久研发状态

需求、计划、阶段游标和验证证据保存在仓库文件中，而不是依赖不断膨胀的聊天上下文。任务可以跨会话、跨 Agent 接力，也能在中断后从明确阶段继续。

### 跨会话、跨团队的经验飞轮

会话开始时注入与当前任务相关的历史经验，完成后沉淀经过验证的问题、解法和证据。个人经验由此进入团队知识库，在后续项目中被再次检索、采用和校正。

### 开放且可移植

流程由纯文件 Skill 和清晰协议组成，支持 Codex、Claude Code、Cursor 及其它兼容 CLI。并行执行和富交互是加速能力，不是运行前提。

## 工作方式

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

MCP 可用时，Skills 会自动创建或绑定统一 Task，关联真实 Commit、验证证据和经验记录。代码正文始终通过 Git 交付，不上传知识平台。

## 安装

Skills 与 MCP 在研发机器上安装一次即可。推荐使用一键安装器，它会打开浏览器完成授权，并自动配置 Codex、Claude Code、Cursor 和 Capital Agent MCP：

```bash
bash /path/to/capital-agent-skills/scripts/setup.sh --server "https://your-server"
```

升级和诊断：

```bash
bash scripts/setup.sh --server "https://your-server" --upgrade
bash scripts/setup.sh --server "https://your-server" --doctor
```

安装器会幂等更新受管理配置，保留已有个人规则和其它 MCP Server；同时检查并选择兼容的 Node.js 运行时。需要手工配置中心知识库时，参见 [MCP 接入说明](skills/harvest-experience/references/setup-mcp.md)。

也可以手工安装 Skills：

```bash
git clone https://github.com/RainFlashPoint/capital-agent-skills.git

# Claude Code：作为 plugin 加载，或把 skills/* 链接到 ~/.claude/skills/
# Codex：把 skills/* 链接到 ~/.agents/skills/
# Cursor：把 cap 链接到 ~/.cursor/skills/，并在 ~/.cursor/mcp.json 注册 Capital Agent
```

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

需要显式启动时，Codex 使用 `$cap`，Claude Code 使用 `/cap`。也可以使用 `/cap 需求`、`/cap 计划`、`/cap 开发`、`/cap 测试`、`/cap 评审`、`/cap 发布` 等直白表达，不需要记忆内部 Skill 名称。

## 演进方向

- [x] 建立覆盖需求、实现、验证、评审和发布的 Agent 研发主线
- [x] 建立与真实 Commit 绑定的独立测试和评审机制
- [x] 建立跨会话、跨项目、跨团队积累的工程经验飞轮
- [ ] 完善人类与 Agent 协作效能的可观测体系
- [ ] 持续衡量知识积累对研发质量和效率的提升
- [ ] 扩展更多执行环境、验证能力和交付目标

## License

MIT。见 [LICENSE](LICENSE)。
