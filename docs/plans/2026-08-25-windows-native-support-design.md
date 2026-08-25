# Windows 原生支持设计

## 目标

让 Windows 10/11 用户在 PowerShell、Git for Windows、Node.js 环境中完成 Capital Agent 的安装、升级、Doctor、Skill/MCP 配置与日常研发流程，同时保持现有 macOS/Linux 行为不变。

## 兼容边界

- 保留 `scripts/setup.sh` 及其 macOS/Linux 逻辑，不改变现有参数和退出条件。
- 新增薄层 `scripts/setup.ps1`，只负责 Windows 前置检查和参数透传，安装真值仍由 `scripts/setup.mjs` 维护。
- Windows 团队模式不注册本机独立 Test Provider。Doctor 将其显示为明确的 `SKIP`，独立 Gate 交给 Server/Linux Runner；这不降低平台、MCP、客户端配置和安装清单的校验。
- macOS/Linux 继续安装并强制检查本机 Test Provider；Windows 分支不能改变这条既有门禁。
- 新增 Node 版阶段守卫供 PowerShell/Codex 原生调用；现有 Shell 守卫和 Git Hook 继续保留，避免改变已验证的 POSIX 交付链路。
- 需求树的 Python 工具在 Windows 使用 `py -3`；普通安装器不擅自安装系统依赖。

## 组件与数据流

1. `setup.ps1` 校验 Git、Node 及团队/本地模式所需 Node 版本，然后调用同目录 `setup.mjs`。
2. `setup.mjs` 通过单一平台能力策略判断本机 Provider 是否受支持：Darwin/Linux 为 `required`，Windows 为 `remote-only`。
3. 安装和 Doctor 共用该策略。Windows 不请求 Provider 凭据、不写 Provider 配置、不因 Provider 缺失失败；其余门禁不变。
4. Windows 运行阶段守卫时调用 Node 入口；POSIX 与 Git Hook 仍调用原 Shell 文件。

## 失败行为

- 缺 Git、Node 或版本不足时，PowerShell 入口在写配置前失败并给出明确修复信息。
- Windows 平台/MCP/客户端配置失败仍返回非零；只有本机 Provider 是有意跳过。
- 未识别的平台保持 fail-closed，不自动套用 Windows 例外。
- 安装器不修改 PowerShell ExecutionPolicy；用户可按单次进程范围使用 `-ExecutionPolicy Bypass`。

## 验证策略

- Node 单测固定 Windows Provider 策略、PowerShell 参数透传和平台文案。
- Node 版阶段守卫复用现有边界/上下文 fixture，覆盖分支、HEAD、工作区指纹与会话根。
- 运行现有 `scripts/release-check` 全量门禁，证明 macOS/Linux 旧路径、Provider、安装器、Hook、安全与故障恢复均未回归。
