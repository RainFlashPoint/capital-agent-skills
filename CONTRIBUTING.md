# Contributing

感谢你改进 Capital Agent Skills。这个仓库优先接受小而可验证的改动：角色视角放进 `skills/cap-flow/references/roles/`，验证方法放进 `skills/cap-test/checks/`，语言与部署命令放进对应参考卡。除非确实出现新的研发生命周期阶段，不新增顶层 Skill。

## 开发流程

1. 从最新 `main` 创建短命分支。
2. 阅读 `AGENTS.md`，保留现有未提交改动和 `.cap/` 单写者约束。
3. 行为变更先补能证明风险的回归；文档改动保持跨 Codex、Claude Code、Cursor 和 Windows/macOS/Linux 可移植。
4. 不提交私有 Server 源码、凭据、内部地址、客户数据、真实 `.env` 或未脱敏截图。

## 本地验证

最小检查：

```bash
node scripts/release-contract.mjs check --phase worktree
bash scripts/validate-skills
git diff --check
```

行为或发布改动必须运行：

```bash
bash scripts/release-check
```

若改动涉及 Agent/eval 场景：

```bash
node scripts/eval-cap.mjs --markdown
node examples/e2e-local/run.mjs
```

## Pull Request 说明

请写清目标、风险、改动文件、测试结果、未验证项和是否影响版本/发布。不要把“workflow 已配置”写成“CI 已通过”；第一次远端运行结果应在 PR 中由 GitHub Actions 真实产生。

行为变化需要更新 `CHANGELOG.md`。版本号以 `.claude-plugin/plugin.json` 为单一事实源，其余关系由发布契约检查。
