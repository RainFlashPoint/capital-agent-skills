# capital-agent-skills

把 Coding Agent 的需求、实现、测试、评审、发布和经验复用变成一条可恢复、可验证、可移植的研发主线。

<!-- release-version: 0.13.4 -->

[![CI](https://github.com/RainFlashPoint/capital-agent-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/RainFlashPoint/capital-agent-skills/actions/workflows/ci.yml)
[![Release Check](https://github.com/RainFlashPoint/capital-agent-skills/actions/workflows/release-check.yml/badge.svg)](https://github.com/RainFlashPoint/capital-agent-skills/actions/workflows/release-check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 公开状态与证据

当前候选版本：`v0.13.4`。版本单一事实源是 [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)；marketplace、README、CHANGELOG、Tag 与 GitHub Release 的关系由 `scripts/release-contract.mjs` 确定性检查。

公开证据按入口区分：

| 证据 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 定向 Node/Python + `bash scripts/validate-skills` + `git diff --check` | 普通维护的受影响行为、结构和补丁卫生；按需补 E2E/eval | 全量发版门禁已通过 |
| `node scripts/node-test-runner.mjs` | 显式全量 Node 自查；逐文件显示进度、限制并发并设置单文件超时 | 发布前 40 次并发写入压力覆盖 |
| `bash scripts/release-check` | 正式 Skills 发版的完整本地门禁；默认不含压力测试 | GitHub 上已经运行或已经发布 |
| `node scripts/node-test-runner.mjs --stress` | 显式执行 Outbox 的 40 次并发写入压力覆盖 | 常规回归已通过 |
| GitHub Actions | 提交到 GitHub 后，各公开 runner 的真实结果 | 私有 Server/Harness 的状态 |
| Tag + GitHub Release | 某个公开 Commit 已按发布 workflow 建立版本关系 | 尚未创建的候选版本已发布 |

截至 2026-10-20，本轮发布前公开 `main`、Git Tag 与 GitHub Latest Release 的真实状态仍需在推送后回读；`v0.13.4` 只有在本地门禁、独立复核、目标 Commit 推送、Tag、GitHub Actions 与 Release API 回读全部完成后才算正式发布，不能用本地绿色结果替代。

普通维护按影响面选择定向测试，例：修改版本契约时执行对应 Node 测试；修改 Python 工具时选择对应 unittest。测试文件需按实际改动替换，未涉及的语言无需运行：

```bash
node --test scripts/test-release-contract.mjs
python3 -m unittest scripts.test_contrast_check
bash scripts/validate-skills
git diff --check
```

只有用户明确要求本仓**正式 Skills 发版**交付时，才必须执行完整 `bash scripts/release-check`，详见 [发布流程](docs/releasing.md)。普通维护、行为变更、提交、推送或 `release` 阶段名不自动触发该门禁；相关 E2E/eval 按改动类型补齐。`.cap/PROFILE.md` 要求先显式选择定向命令，复用现有 `cap-execute`，不默认发现整库测试。

显式全量 Node 自查按文件串行执行，每个文件限时 600 秒，输出开始、完成、耗时和汇总；常规集合不含 `stress-cap-outbox.mjs`。只有修改 Outbox 并发、锁或测试编排器时，才额外显式运行：

```bash
node scripts/node-test-runner.mjs --stress
```

该入口单独执行 40 次写入，最多 4 个活跃子进程，每个子进程限时 15 秒，整个压力文件限时 90 秒。

上下文准备复用已有检查点：Task、Session、Commit、阶段、源码与语义绑定、恢复事件和预算均未变化时，`prepareContext` 返回 `reused: true`，不重复生成 manifest、原子日志或恢复回执。绑定变化后重新校验并更新相应证据。

## 快速安装

### 本地模式（推荐先试）

本地模式不需要 Cap Server、账号或 MCP：

```bash
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
cd capital-agent-skills
bash scripts/setup.sh --local
```

Windows 10/11：

```powershell
git clone https://github.com/RainFlashPoint/capital-agent-skills.git
Set-Location capital-agent-skills
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local
```

安装后完全退出并重新打开 Codex、Claude Code 或 Cursor，再在任意 Git 仓库中直接描述开发任务。已有客户端不会可靠地热加载新 Skill。

升级与诊断：

```bash
bash scripts/setup.sh --local --upgrade
bash scripts/setup.sh --local --doctor
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local --upgrade
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --local --doctor
```

安装清单位于 `~/.capital-agent/install-manifest.json`。状态检查会区分：

- `current`：本地安装、源码、工作树和已知远端状态一致；
- `remote_update_available`：发现远端默认分支已有新 Commit，并在隔离临时图谱中证明可快进；
- `local_ahead` / `diverged`：本地默认分支领先或已与远端分叉，不会自动 pull；
- `branch_mismatch`：当前位于 feature 等非远端默认分支，不会把默认分支更新错误地拉进当前分支；
- `remote_default_unknown` / `remote_relation_unknown`：无法证明默认分支或祖先关系，升级失败关闭；
- `install_drifted`：安装清单与本地源码版本、Commit 或文件摘要不一致；
- `working_tree_modified`：源码目录有改动，自动升级会拒绝执行，避免 `pull` 混入或覆盖现场；
- `offline_unknown`：缓存过期且远端离线/超时，不阻塞普通研发，也不冒充 `current`。

远端检查使用短超时和 TTL 缓存，不会在每个普通任务中无限等待网络；缓存只保存成功观察到的 remote HEAD，超时或离线结果不会占用完整 TTL，网络恢复后的下一次检查会重试。若 `ls-remote` 返回的新 Commit 尚未存在于安装副本，祖先关系只在自动清理的临时 bare 仓中取证，不改安装副本的 refs、对象库或工作树。只有当前分支与远端默认分支一致、且本地 HEAD 可证明是远端 HEAD 的祖先时，`safeToUpgrade` 才为 true；升级显式拉取该默认分支并要求 `--ff-only`。

### 团队增强模式

已有私有 Cap Server 的团队可运行：

```bash
bash scripts/setup.sh --server "https://your-server"
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 --server "https://your-server"
```

团队模式需要服务方提供地址和访问权限。Server/Platform 源码、托管服务和账号不包含在本开源仓库中；详见[本地与私有平台边界](#本地模式与私有-serverplatform-边界)。

## Cap 能拦住什么

Cap 不替 Agent 做所有判断；它把容易被聊天摘要、旧证据或仓库串台掩盖的风险变成显式门禁：

- 错仓库、错分支、错 worktree 或旧 Task 继续写入；
- 需求、计划、测试面或外部操作边界缺失；
- 旧 Commit 的 PASS 被串到新 Commit；
- 本地 PASS 被描述成 Server Gate PASS；
- 高风险改动缺少 fresh-context 独立复核；
- 上下文恢复后继续沿用已失效授权；
- 历史经验与本次规则冲突却未说明范围和决策；
- 发布版本、Tag、Release、README 与 CHANGELOG 互相漂移；
- 工作区有改动时自动 `pull`，或离线时错误显示“已是最新”。

简单任务走短路径；发布、安全、数据、外部接口和大范围改动保留完整调查、计划、验证、评审和交付证据。

## 本地模式与私有 Server/Platform 边界

| 能力 | 本地开源 Skills | 私有 Server/Platform |
|---|---:|---:|
| 结构化研发主线与 `.cap/` 状态 | ✓ | ✓ |
| 本地测试、评审、发布门禁 | ✓ | ✓ |
| 本地经验原稿与历史索引 | ✓ | ✓ |
| 统一团队 Task / 看板 | — | ✓ |
| 中心知识库与跨成员归因 | — | ✓ |
| 独立 Test / Review Harness Gate | — | ✓ |
| 托管运行状态与组织权限 | — | ✓ |

本地证据永远只称 `local-observed`。只有私有 Server 针对同一 Task、同一 Commit 返回独立 Action/Gate，才能称为团队 Gate。

本仓不会发布私有 Server 源码、内部地址、凭据或客户数据。可公开的产品截图/录屏需要维护者另行提供并脱敏；当前只维护[素材占位与拍摄边界](docs/private-platform-evidence.md)，不虚构未提供的界面。

## 测试与评测

### CI 拆分

- `Fast PR gate`：版本契约、结构 lint 和关键可信边界回归；
- `Node regression`：全部 `scripts/test-*.mjs`；
- `Python regression`：全部 `scripts/test_*.py`；
- `Portability`：Linux、macOS、Windows 的真实 Node/CLI 可执行范围；
- `Release Check`：每周与手动触发的完整 Linux 发布门禁；
- `Publish Release`：仅 `v*` Tag 触发，先校验版本/Commit，再创建 GitHub Release。

Windows runner 不执行 Bash-only 门禁，也不把模拟结果宣传成原生平台验证。

### 本地端到端 fixture

```bash
node examples/e2e-local/run.mjs
```

它在临时 Git 仓库中真实覆盖 `current → remote_update_available → working_tree_modified`，不访问私有 Server，也不修改用户项目。

### Agent/eval 基础框架

```bash
node scripts/eval-cap.mjs --markdown
```

当前确定性核心场景覆盖：旧 Commit 证据串用、错误 worktree、漏回归门禁、高风险独立评审、恢复后旧授权失效、历史规则复用。报告明确写出 `liveModel: not-run`；更多真实模型、宿主压缩和私有 Harness 评测见 [eval 文档](docs/evals.md)，没有运行的数据不会被填成成绩。

## 架构与案例

```text
用户目标
  ↓
cap（唯一公开入口）
  ↓
项目了解 → 需求确认 → 开发计划 → 编码实现 → 测试验证 → 代码评审 → 发布上线
  ↓                         ↑
.cap/ 持久状态、证据、检查点、历史经验
  ↓
本地 Git/CI，或可选的私有 Server/Platform
```

核心结构：

- `skills/cap-flow`：Orient → Route → Handoff 编排、需求树和共享方法论；
- 7 个流程 Skill：understand / define / plan / implement / test / review / release；
- `roles/` 与 `cap-test/checks/`：按改动面加载视角与验证方法，不增加流程阶段；
- `.cap/`：任务状态、规格、计划、执行、验证、评审、经验与语义检查点；
- `ontology/`：本地语义投影，不替代 Server 鉴权或 Gate；
- `scripts/`：跨平台确定性门禁、安装、状态、发布和 eval 工具。

更完整的流程与恢复案例：

- [研发流程总览](docs/研发流程总览.md)
- [故障恢复手册](docs/故障恢复手册.md)
- [Ontology 语义底座](ontology/README.md)
- [本地效率升级说明](docs/local-efficiency-upgrade.md)

## 当前版本摘要

`v0.13.4` 修复压缩恢复后并行工具争锁和较早完成工具无法确认送达的问题，保留会话与 Task 隔离及受控恢复；同时纳入有界测试编排、可选压力测试与普通维护定向验证。累积包含 `v0.13.0` 至 `v0.13.3` 的功能与修复，包括压缩中断恢复、原生压缩、语义去重与可选本机 Test Provider。

历史版本与完整变更只维护在 [CHANGELOG.md](CHANGELOG.md)。发布步骤见 [docs/releasing.md](docs/releasing.md)。

## 维护与安全

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全报告：[SECURITY.md](SECURITY.md)
- License：[MIT](LICENSE)
