# Contributing

感谢你改进 Capital Agent Skills。这个仓库优先接受小而可验证的改动：角色视角放进 `skills/cap-flow/references/roles/`，验证方法放进 `skills/cap-test/checks/`，语言与部署命令放进对应参考卡。除非确实出现新的研发生命周期阶段，不新增顶层 Skill。

## 开发流程

1. 从最新 `main` 创建短命分支。
2. 阅读 `AGENTS.md`，保留现有未提交改动和 `.cap/` 单写者约束。
3. 行为变更先补能证明风险的回归；文档改动保持跨 Codex、Claude Code、Cursor 和 Windows/macOS/Linux 可移植。
4. 不提交私有 Server 源码、凭据、内部地址、客户数据、真实 `.env` 或未脱敏截图。

## 普通维护

普通代码、Skills、文档或测试路由修改，按实际影响范围选择定向 Node/Python 测试，再运行结构与补丁检查。下面是入口示例，测试文件应替换为本次改动对应的文件，未涉及的语言无需运行：

```bash
node --test scripts/test-release-contract.mjs
python3 -m unittest scripts.test_contrast_check
bash scripts/validate-skills
git diff --check
```

现有 `cap-execute` 可通过显式命令记录这些定向测试；`.cap/PROFILE.md` 不预设统一全量单测命令。未选择测试时应先补齐定向命令，不能把未执行测试视为通过。

修改 Agent/eval 场景时补相关 eval，安装或用户路径变化时补必要 E2E；只修改其他文档不因此运行这些检查。提交、推送、行为变更或进入 `release` 阶段，本身都不代表正式发版。

## 正式 Skills 发版

只有用户明确要求本仓正式 Skills 发版交付时，才必须按 [发布流程](docs/releasing.md) 运行完整门禁：

```bash
bash scripts/release-check
```

它覆盖全量常规 Node/Python、结构、eval、E2E 与发布契约，不作为普通维护默认入口。Outbox 压力仍保持显式 opt-in；仅修改 Outbox 并发、锁或测试编排器时额外运行：

```bash
node scripts/node-test-runner.mjs --stress
```

## Pull Request 说明

请写清目标、风险、改动文件、测试结果、未验证项和是否影响版本/发布。不要把“workflow 已配置”写成“CI 已通过”；第一次远端运行结果应在 PR 中由 GitHub Actions 真实产生。

行为变化需要更新 `CHANGELOG.md`。版本号以 `.claude-plugin/plugin.json` 为单一事实源，其余关系由发布契约检查。
