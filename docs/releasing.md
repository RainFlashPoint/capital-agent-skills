# Release process

版本单一事实源是 `.claude-plugin/plugin.json.version`。当前公开 workflow 只发布纯稳定 `x.y.z` 版本，拒绝 `-rc`、`-beta` 等 prerelease 和 `+build` metadata；不要先手工改 Tag/Release，再回头猜 manifest 应该是什么版本。

## 1. 准备候选版本

1. 更新 `.claude-plugin/plugin.json`。
2. 同步 `.claude-plugin/marketplace.json` 的 metadata 与 plugin 版本。
3. 在 `CHANGELOG.md` 增加同名非空章节。
4. 更新 README 的 `<!-- release-version: x.y.z -->` 与当前版本摘要。
5. 运行：

```bash
node scripts/release-contract.mjs check --phase worktree
bash scripts/release-check
```

工作树阶段不会要求尚未创建的 Tag/Release 存在。

## 2. 审阅与远端动作

确认工作区干净、CI 真实通过并完成维护者审批后，才创建 `v<version>` Tag。Tag 必须指向候选 Commit。不要从有未提交改动的源码目录运行自动升级或发布。

```bash
node scripts/release-contract.mjs check --phase tag --tag "vX.Y.Z"
```

push Tag 会触发 `.github/workflows/release.yml`：再次校验 Tag/Commit、运行完整 `release-check`、从 CHANGELOG 提取说明并创建 GitHub Release。失败时不创建 Release。

## 3. 发布后一致性

workflow 最后通过 GitHub API 回读非草稿 Release，并再次验证实际 Release tag、Git Tag、Commit 与 manifest 版本一致。维护者还应查看公开 Actions 与 Release 页面，而不是只相信本地日志。

```bash
node scripts/release-contract.mjs published --repository RainFlashPoint/capital-agent-skills
```

## 当前历史差异

2026-10-16 的只读审计：公开 main `0.12.6`，最新 Tag `v0.12.4`，最新 Release `v0.12.1`。本文件和 workflow 用于阻止后续继续扩大差异；修复历史差异仍需要维护者明确 push/tag 权限，本地任务不会自动执行。
