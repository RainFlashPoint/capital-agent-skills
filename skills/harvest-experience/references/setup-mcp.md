# 接入 capital-agent MCP server

`harvest-experience` 依赖一个名为 `capital-agent` 的 MCP server，它提供 `enrich_context`（注入经验）、`record_experience`（沉淀经验）、`search_knowledge` 等工具，背后是一个中心知识库。团队模式下需要先注册并让当前客户端会话实际加载它；配置已经写入但当前会话没有工具时，Cap 会在编码前要求重启客户端，不会伪装成纯本地模式继续。

> 把下面的 `<YOUR_SERVER>` 换成你自己的 capital-agent-server 地址，`<YOUR_KEY>` 换成管理员发给你的 `x-user-key`（用于复用率按人归因）。本仓库不内置任何服务器地址或密钥。

## 方式 A：环境变量启动器（推荐）

研发人员推荐直接运行设备授权安装，不需要查看或复制个人 Key：

```bash
node /path/to/capital-agent-skills/scripts/setup.mjs --server "https://your-capital-agent-server"
```

安装器会打开平台登录授权页，将凭证保存到研发机的 `~/.config/capital-agent/env`（0600），并自动安装 Codex、Claude Code、Cursor Skills 与 MCP。下面的环境变量方式保留给 CI 与无浏览器环境。

只在研发本机设置，不要写入业务仓库：

```bash
export CAPITAL_AGENT_SERVER_URL="https://your-capital-agent-server"
export CAPITAL_AGENT_USER_KEY="your-personal-key"
```

Codex `~/.codex/config.toml` 使用原生 Streamable HTTP：

```toml
[mcp_servers.capital-agent]
url = "https://your-capital-agent-server/api/mcp/message"
http_headers_helper = "\"/path/to/node\" \"/path/to/capital-agent-skills/scripts/mcp-http-headers.mjs\""
required = false
```

`required = false` 只保证平台暂时不可达时 Codex 仍能进入会话和普通对话，不表示团队模式默认降级为本地。每个新研发任务仍由 Cap 检查 MCP 工具并主动尝试平台握手；缺少工具时进入 `restart_required` 选择门。`mcp-http-headers.mjs` 在运行时从本机 `~/.config/capital-agent/env` 读取最新的 `CAPITAL_AGENT_USER_KEY`，只向 Codex 输出 `x-user-key` header JSON。Key 不写入 `config.toml`、命令行参数或项目文件；Codex 在新建连接时调用 helper，同源 POST 返回 401/403 后也会重新获取 header。

Claude Code：

```bash
claude mcp add capital-agent -- node /path/to/capital-agent-skills/scripts/mcp-remote.mjs
```

Claude/Cursor 的 stdio 启动器在运行时读取 `CAPITAL_AGENT_SERVER_URL` 和 `CAPITAL_AGENT_USER_KEY`。开源仓库、业务代码和可共享的安装配置均不包含真实身份。

也可以运行一次 `scripts/setup.mjs` 自动保存为 `~/.config/capital-agent/env`（权限 `0600`）并注册 Codex、Claude Code 与 Cursor。该文件只在研发本机，不属于任何 Git 仓库。

Cursor 使用 `~/.cursor/mcp.json` 的 `mcpServers.capital-agent` 条目，并通过 `~/.cursor/rules/capital-agent.mdc` 自动识别真实 Git 研发请求。安装器只幂等维护自己的 MCP 条目和规则文件，不覆盖其它 Cursor MCP Server 或个人规则。Codex、ChatGPT、Claude Code 与 Cursor 都不能保证在已打开会话中热加载新 Skill/MCP；安装或升级后需完全退出并重新打开客户端，再新建任务继续，现有 Git 分支和工作区改动不会丢失。

## 方式 B：直接配置远程 HTTP

**Claude Code：**
```bash
claude mcp add --transport http capital-agent https://<YOUR_SERVER>/api/mcp/message \
  --header "x-user-key: <YOUR_KEY>"
claude mcp list   # 应显示 capital-agent: Connected
```

**Codex：** 优先运行安装器生成上述 `url + http_headers_helper`，不要把 Key 直接写入 `config.toml`。仅支持 stdio 的其他客户端可使用 `mcp-remote`，但真实值仍只允许保存在研发本机的私有配置中：
```toml
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

先运行 `node scripts/setup.mjs --server "https://your-capital-agent-server" --doctor`：Doctor 会区分 Codex 的 `streamable-http`、旧版 `stdio-remote` 和错误的本地 `stdio-local`，并真实调用远程 MCP `initialize` / `tools/list`。若报告旧或错误 transport，运行团队模式 `--upgrade`即会幂等迁移。

注册后完全退出并重新打开客户端，新建会话触发一次 `enrich_context`（agent_type=dev、input=你的需求、repo_url=当前仓库）。返回相关经验即接通。沉淀量/复用率可在平台 `/experience` 页查看。

远程连接必须携带个人 `x-user-key`。`create_or_attach_task`、`record_task_delivery`、`request_docker_verification` 等写操作拒绝匿名调用；共享匿名 MCP 只能读取知识。

## 关键不变量

注入（`enrich_context`）与沉淀（`record_experience`）必须用**同一个 `repo_url`**（由它派生 projectKey）。不一致会导致复用率归因静默断裂——这是整个闭环的核心不变量。
