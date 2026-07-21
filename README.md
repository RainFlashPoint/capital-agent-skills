# capital-agent-skills

骑在 CLI 上的研发流程 + 经验闭环技能族。给你的 coding agent（Claude Code / Codex / 其它）装一套**结构化研发流程**，外加一个**跨会话、跨人积累的经验中枢**：会话开始注入相关经验，会话结束沉淀本次改动，所有人的经验汇入同一个中心知识库。

> **状态**：v0.1.2，持续演进中。核心是把结构化研发流程与连中心知识库的经验闭环 `harvest-experience` 合在一起。

## 这是什么

两条能力叠在一起：

1. **cap 流程主线**——研发只记一个 `$cap`（Claude Code 为 `/cap`），直接描述“实现 / 修复 / 测试 / 评审 / 发布”即可。系统内部自动完成项目了解、需求确认、开发计划、编码实现、测试验证、代码评审和发布上线；内部状态 ID 继续兼容旧版本。不依赖特定运行时，Claude/Codex 都能跑。

2. **经验闭环 `harvest-experience`**（本项目核心）——骑在 CLI 上的 `注入 → 编码 → 沉淀`。依赖一个 MCP server `capital-agent`（连中心知识库），会话首尾各调一次 `enrich_context` / `record_experience`。接入方式见 [skills/harvest-experience/references/setup-mcp.md](skills/harvest-experience/references/setup-mcp.md)。
3. **统一 Task 无感闭环**——MCP 支持时，Skills 自动创建/绑定平台 Task，回写 Commit、文件路径、测试与 Review，并在代码已推送且自治门禁通过后请求 Docker 复验。代码正文始终通过 Git 交付，不上传知识平台。

平台地址和个人身份只通过研发本机环境变量提供：`CAPITAL_AGENT_SERVER_URL`、`CAPITAL_AGENT_USER_KEY`。开源仓库不内置任何公司地址或密钥；推荐使用 `scripts/mcp-remote.mjs` 启动 MCP。

一键初始化（自动打开浏览器授权，不需要复制个人 Key；自动安装 Codex/Claude Skills 并注册 MCP）：

```bash
node /path/to/capital-agent-skills/scripts/setup.mjs --server "https://your-server"
```

升级与诊断：`setup.mjs --server "https://your-server" --upgrade`、`setup.mjs --server "https://your-server" --doctor`。环境变量仍作为服务器/CI 的非交互兼容方式。

Skills 与 MCP 只需在研发机器安装一次。之后正常使用 Codex/Claude 描述编码需求即可，不强制输入 `$cap`；首次进入 Git 项目时，Skill 会静默安装兼容现有 Hook 的关联器，正常 `git commit` 自动附加 Task/Session。研发不需要手工安装 Hook、填写 Task ID 或配置 GitLab CI。

**为什么两条要在一起**：流程定义了任务边界，边界产出干净的经验原子（spec 决策 / review findings / 蒸馏 pattern）；经验闭环把这些原子汇入中心知识库、下次跨人复用。流程是产出口，知识库是积累池。

## 快速开始

**装 skills**（Claude Code 插件方式，或直接把 `skills/` 软链到你的 skills 目录）：
```bash
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
# Claude Code: 作为 plugin 加载(见 .claude-plugin/)，或把 skills/* 链接到 ~/.claude/skills/
# Codex: 把 skills/* 链接到 ~/.agents/skills/
```

**开始研发**：正常描述“实现需求 / 修改代码 / 修 bug”即可自动进入 Task 与经验闭环；想显式启动时只需使用 Codex 的 `$cap` 或 Claude Code 的 `/cap`。也可以说 `/cap 需求`、`/cap 计划`、`/cap 开发`、`/cap 测试`、`/cap 评审`、`/cap 发布`，不需要记 `cap-shape`、`cap-build` 等内部名字。

**开经验闭环**：先按 [setup-mcp.md](skills/harvest-experience/references/setup-mcp.md) 注册 `capital-agent` MCP server，之后 `harvest-experience` 会在编码会话首尾自动注入/沉淀。

## 路线图（演进方向）

- [x] v0.1.0：结构化流程主线 + 嫁接 harvest-experience 经验闭环 + 接入文档
- [ ] 把流程的蒸馏出口（distillation / review findings）从"写回本地 skill 文件"扩展为"同时 push 到中心知识库"，实现跨人复用
- [ ] operator 归因贯通：谁沉淀的经验可追踪，复用率按人看板
- [ ] 用文件预测 F1 等指标做 proof-of-value（接入知识库后模型对该 repo 的理解准确率变化）

## License

MIT。见 [LICENSE](LICENSE)。
