---
name: cap
description: Capital Agent 研发工作的统一入口。用于实现功能、修复问题、测试验证、代码评审和发布交付；系统根据任务复杂度自动选择必要步骤，用户不需要理解或手动调用内部阶段。
---

# Capital Agent 研发入口

完整读取并遵循同级目录 `../cap-flow/SKILL.md`；真实编码会话同时读取 `../harvest-experience/SKILL.md`，自动完成经验注入与沉淀。本技能是研发唯一公开入口，也是唯一安装到客户端列表的 Skill，不复制内部流程规则。

## 用户语言

不要要求用户输入 `cap-define`、`cap-implement`、`cap-test` 等内部技能名。识别下列自然语言并在内部完成路由：

| 用户说法 | 对外名称 | 内部阶段 |
|---|---|---|
| 了解项目、建立项目档案 | 项目了解 | `understand` / `cap-understand` |
| 梳理需求、确认方案、写规格 | 需求确认 | `define` / `cap-define` |
| 拆任务、制定计划 | 开发计划 | `plan` / `cap-plan` |
| 开始开发、实现、修复 | 编码实现 | `implement` / `cap-implement` |
| 测试、验证 | 测试验证 | `test` / `cap-test` |
| 代码评审、Review | 代码评审 | `review` / `cap-review` |
| 发布、上线 | 发布上线 | `release` / `cap-release` |

`/cap 需求`、`/cap 计划`、`/cap 开发`、`/cap 测试`、`/cap 评审`、`/cap 发布` 是可选快捷表达；日常直接 `$cap` 加需求即可。

用户显式调用 `$cap` 后：

1. 读取目标仓库 `.cap/PROFILE.md` 与 `.cap/STATE.md`（不存在则按 cap-flow 首次进入规则处理）。
2. 调用中心知识层注入与本需求相关的历史经验。
3. 按 `cap-flow` 的 Orient → Route → Handoff 推进当前研发任务。
4. 会话结束时沉淀意图与改动文件路径，并维护统一 Task/Skills Session。

开始任何阶段前，加载并执行 `../cap-flow/references/progress-protocol.md` 与 `../cap-flow/references/task-reconnaissance.md`。项目画像只能作为定位索引；每个新任务必须先从当前仓库代码建立 `.cap/task-context.md`。

向用户汇报时使用“需求确认、开发计划、编码实现、测试验证、代码评审、发布上线”等对外名称。只有诊断状态文件或开发 Skills 本身时，才在括号中补充内部 ID。
