# Project Profile: capital-agent-skills

harness-mode: local-only

tech-stack: [markdown skills, node.js scripts, python utilities, shell validation]
test-commands: { unit: "node --test scripts/test-*.mjs && python3 -m unittest scripts/test_intake.py scripts/test_contrast_check.py", coverage: "none — 纯文件协议未配置覆盖率门", e2e: "bash scripts/validate-skills", typecheck: "node --check <changed-js-file>", build: "none — 纯文件 Skill 与脚本无需构建" }

## Verification environment
- runtime: node >=18 + python3 + bash
- execution-zone: local
- package-registry: none
- credential-refs: [可选 Capital Agent MCP 本地配置]
- network-endpoints: [可选 Cap Server]
- composable-services: [none]
- enterprise-services: [可选 Test/Review Harness]
- confirmed-gaps: [Markdown playbook 主要依靠结构 lint 与 dogfood，无法完全由单测覆盖]
- authoritative-stage: local-skills

## Tech stack
| 层 | 技术 | 选它的原因 |
|----|------|-----------|
| 研发协议 | Markdown SKILL/references | 纯文件、跨 Codex/Claude/Cursor 可移植 |
| 客户端脚本 | Node ESM | 安装、握手、状态、Outbox、Git Hook 与本地 Provider |
| 需求树工具 | Python | 提供确定性 intake 数据操作与测试 |
| 结构校验 | Bash/Node/Python | 防悬空引用、字典漂移和跨文件契约不一致 |

## Surface map
- workflow-skills: globs[ skills/** ] roles[skill-maintainer, qa] checks[logic]
- client-protocol: globs[ scripts/cap-*.mjs, scripts/client-delivery.mjs, scripts/mcp-remote.mjs ] roles[server-dev, skill-maintainer] checks[logic]
- installation: globs[ scripts/setup*.mjs, scripts/setup.sh, runtime/** ] roles[server-dev, skill-maintainer] checks[logic]
- governance-hooks: globs[ scripts/*git*.mjs, scripts/*commit*.mjs, skills/cap-flow/references/templates/hooks/** ] roles[server-dev, skill-maintainer] checks[logic]
- validation: globs[ scripts/test*, scripts/validate-skills, examples/** ] roles[qa, skill-maintainer] checks[logic]
- package-docs: globs[ README.md, CHANGELOG.md, .claude-plugin/**, AGENTS.md, CLAUDE.md ] roles[skill-maintainer, ai-readiness] checks[logic]

## Conventions
- 不新增顶层 Skill，能力进入既有阶段、角色卡、check、语言包或 release target。
- 流程约束写做什么/为什么/避坑，不把通用 Skill 写成脆弱命令手册。
- 保持纯文件、可移植、STATE 单写者和无平台可降级。
- Test/Review Gate 必须由独立 Server Action 判定，客户端不能自签 PASS。
- 行为变更必须同步 CHANGELOG、必要版本号和 `bash scripts/validate-skills`。

## Entry points
- 用户入口：`skills/cap/SKILL.md`
- 编排：`skills/cap-flow/SKILL.md`
- 平台协议：`skills/harvest-experience/references/platform-task-loop.md`
- 客户端状态：`scripts/cap-status.mjs`
- 安装诊断：`scripts/setup.mjs` / `scripts/setup.sh`
- 结构回归：`bash scripts/validate-skills`

## Known risks
- Skill 家族约 14.7k 行，跨文件协议较多，任何重复规则都可能漂移。
- 行为 dogfood 仍依赖真实宿主和仓库，自动测试不能覆盖完整对话行为。
- Server 不可达时必须同时维护本地主线和 Outbox，容易出现“降级但未说明”。
- 历史客户端、旧 Stage 名和旧 Server 字段仍需向后兼容。
- AI-readiness: 9/10；AGENTS/CLAUDE 单一事实源、测试和结构 lint 完整，主要缺口是行为级 fixture 仍有限。

## Deploy
- target-type: static-site
- config 位置: `.claude-plugin/*.json`、`scripts/setup.mjs`、GitHub 仓库发布
- 环境: 本地安装 → GitHub main → 用户 upgrade
- 密钥来源: 本地客户端配置，不进入仓库

## Evolution log
> 演进流水见同目录 `EVOLUTION.md`。
