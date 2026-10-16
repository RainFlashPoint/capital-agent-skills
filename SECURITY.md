# Security Policy

## Supported versions

安全修复优先面向最新公开 GitHub Release 和当前 `main`。历史版本可能只提供升级建议，不保证单独回补。

## Reporting a vulnerability

请优先使用 GitHub 的 **Security → Report a vulnerability** 私密报告通道。不要在公开 Issue、PR、日志或截图中粘贴 Token、用户数据、内部地址或可直接利用的细节。

若仓库暂未启用私密报告，请先创建一条不含敏感细节的 Issue，请维护者提供私密联系通道；在建立私密通道前不要公开漏洞利用步骤。

报告建议包含：受影响版本/Commit、最小复现、影响范围、前置条件、是否涉及私有 Server，以及已做的缓解。维护者确认前不要把本地测试结果描述成生产环境已受影响或已修复。

## Scope

本仓范围包括 Skills、安装/升级脚本、状态与发布工具、Git hooks、eval fixture 和公开 CI。私有 Server/Platform 不在本仓源码范围内，但如果问题由本仓客户端与私有服务交互触发，请在报告中注明边界，维护者会转交对应私有渠道。
