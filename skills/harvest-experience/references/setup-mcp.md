# 接入 capital-agent MCP server

`harvest-experience` 依赖一个名为 `capital-agent` 的 MCP server，它提供 `enrich_context`（注入经验）、`record_experience`（沉淀经验）、`search_knowledge` 等工具，背后是一个中心知识库。你需要先注册它，skill 才会生效；否则 skill 会自动跳过，不影响正常编码。

> 把下面的 `<YOUR_SERVER>` 换成你自己的 capital-agent-server 地址，`<YOUR_KEY>` 换成管理员发给你的 `x-user-key`（用于复用率按人归因）。本仓库不内置任何服务器地址或密钥。

## 方式 A：环境变量启动器（推荐）

只在研发本机设置，不要写入业务仓库：

```bash
export CAPITAL_AGENT_SERVER_URL="https://your-capital-agent-server"
export CAPITAL_AGENT_USER_KEY="your-personal-key"
```

Codex `~/.codex/config.toml`：

```toml
[mcp_servers.capital-agent]
command = "node"
args = ["/path/to/capital-agent-skills/scripts/mcp-remote.mjs"]
```

Claude Code：

```bash
claude mcp add capital-agent -- node /path/to/capital-agent-skills/scripts/mcp-remote.mjs
```

启动器在运行时读取 `CAPITAL_AGENT_SERVER_URL` 和 `CAPITAL_AGENT_USER_KEY`。开源仓库、MCP 配置和业务代码均不包含真实平台地址或身份。

也可以运行一次 `scripts/setup.mjs` 自动保存为 `~/.config/capital-agent/env`（权限 `0600`）并注册 Codex/Claude。该文件只在研发本机，不属于任何 Git 仓库。

## 方式 B：直接配置远程 HTTP

**Claude Code：**
```bash
claude mcp add --transport http capital-agent https://<YOUR_SERVER>/api/mcp/message \
  --header "x-user-key: <YOUR_KEY>"
claude mcp list   # 应显示 capital-agent: Connected
```

**Codex / 仅支持 stdio 的客户端**也可以直接配置 mcp-remote，但真实值只允许出现在研发本机的 `~/.codex/config.toml`：
```toml
[mcp_servers.capital-agent]
command = "npx"
args = ["-y", "mcp-remote", "https://<YOUR_SERVER>/api/mcp/message", "--header", "x-user-key:<YOUR_KEY>"]
```

## 方式 C：本地 stdio（自建/自用，直连本地 server + DB）

`~/.codex/config.toml` 或 Claude Code MCP 配置里，用本地启动器作为 command（示例）：
```toml
[mcp_servers.capital-agent]
command = "bash"
args = ["/path/to/capital-agent-server/bin/mcp-stdio.sh"]
```

## 验证连通

注册后新开一个会话，触发一次 `enrich_context`（agent_type=dev、input=你的需求、repo_url=当前仓库）。返回相关经验即接通。沉淀量/复用率可在平台 `/experience` 页查看。

远程连接必须携带个人 `x-user-key`。`create_or_attach_task`、`record_task_delivery`、`request_docker_verification` 等写操作拒绝匿名调用；共享匿名 MCP 只能读取知识。

## 关键不变量

注入（`enrich_context`）与沉淀（`record_experience`）必须用**同一个 `repo_url`**（由它派生 projectKey）。不一致会导致复用率归因静默断裂——这是整个闭环的核心不变量。
