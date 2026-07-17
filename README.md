# capital-agent-skills

骑在 CLI 上的研发流程 + 经验闭环技能族。给你的 coding agent（Claude Code / Codex / 其它）装一套**结构化研发流程**，外加一个**跨会话、跨人积累的经验中枢**：会话开始注入相关经验，会话结束沉淀本次改动，所有人的经验汇入同一个中心知识库。

> **状态**：v0.1.0，持续演进中。核心是把结构化研发流程与连中心知识库的经验闭环 `harvest-experience` 合在一起。

## 这是什么

两条能力叠在一起：

1. **cap 流程主线**——纯文件 + git 的结构化研发流程：`1 driver（cap-flow，含 intake 需求树）+ 7 流程 skill`（map/shape/plan/build/verify/review/release）+ 角色卡 + verify 三 checks（logic/journey/model）+ 语言包 + Codex adapter。不依赖任何运行时，Claude/Codex 都能跑。详见 [DESIGN.md](DESIGN.md) 与各 skill 的 `SKILL.md`。

2. **经验闭环 `harvest-experience`**（本项目核心）——骑在 CLI 上的 `注入 → 编码 → 沉淀`。依赖一个 MCP server `capital-agent`（连中心知识库），会话首尾各调一次 `enrich_context` / `record_experience`。接入方式见 [skills/harvest-experience/references/setup-mcp.md](skills/harvest-experience/references/setup-mcp.md)。
3. **统一 Task 无感闭环**——MCP 支持时，Skills 自动创建/绑定平台 Task，回写 Commit、文件路径、测试与 Review，并在代码已推送且自治门禁通过后请求 Docker 复验。代码正文始终通过 Git 交付，不上传知识平台。

平台地址和个人身份只通过研发本机环境变量提供：`CAPITAL_AGENT_SERVER_URL`、`CAPITAL_AGENT_USER_KEY`。开源仓库不内置任何公司地址或密钥；推荐使用 `scripts/mcp-remote.mjs` 启动 MCP。

一键初始化（自动保存本机运行时配置、注册已安装的 Codex/Claude MCP；加 `--project` 同时安装当前仓库 Git 治理）：

```bash
CAPITAL_AGENT_SERVER_URL="https://your-server" \
CAPITAL_AGENT_USER_KEY="your-key" \
node /path/to/capital-agent-skills/scripts/setup.mjs
```

Skills 与 MCP 是研发机器全局安装。只有需要在某个仓库强制 Commit 格式时，才进入该仓库追加运行 `node /path/to/capital-agent-skills/scripts/setup.mjs --project`；不加不影响 Task、知识沉淀和 Docker 复验主链。

安装项目 Git 治理（Commit 规范、Task/Session trailer、`.cap` 忽略边界、GitLab CI 模板）：

```bash
node /path/to/capital-agent-skills/scripts/install-git-governance.mjs
```

**为什么两条要在一起**：流程定义了任务边界，边界产出干净的经验原子（spec 决策 / review findings / 蒸馏 pattern）；经验闭环把这些原子汇入中心知识库、下次跨人复用。流程是产出口，知识库是积累池。

## 快速开始

**装 skills**（Claude Code 插件方式，或直接把 `skills/` 软链到你的 skills 目录）：
```bash
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
# Claude Code: 作为 plugin 加载(见 .claude-plugin/)，或把 skills/* 链接到 ~/.claude/skills/
# Codex: 把 skills/* 链接到 ~/.codex/skills/
```

**跑 cap 流程**：在会话里调用 `/cap`（driver 会读状态、路由到合适的阶段 skill）。首次进一个 brownfield 项目先跑 map 建 PROFILE。

**开经验闭环**：先按 [setup-mcp.md](skills/harvest-experience/references/setup-mcp.md) 注册 `capital-agent` MCP server，之后 `harvest-experience` 会在编码会话首尾自动注入/沉淀。

## 路线图（演进方向）

- [x] v0.1.0：结构化流程主线 + 嫁接 harvest-experience 经验闭环 + 接入文档
- [ ] 把流程的蒸馏出口（distillation / review findings）从"写回本地 skill 文件"扩展为"同时 push 到中心知识库"，实现跨人复用
- [ ] operator 归因贯通：谁沉淀的经验可追踪，复用率按人看板
- [ ] 用文件预测 F1 等指标做 proof-of-value（接入知识库后模型对该 repo 的理解准确率变化）

## License

MIT。见 [LICENSE](LICENSE)。
