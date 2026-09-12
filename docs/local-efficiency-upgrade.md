# 0.11.0：让本地研发结果可复用、可核对

这次升级把 Ontology 从状态解释接到本地执行记录。公司研发团队和公开本地用户继续使用 `/cap` 或 `$cap`；不需要申请账号、生成执行密钥或填写一套权限规则。授权服务与生产隔离留待平台阶段。

## 现在能直接减少什么重复工作

- 当前阶段自动选择构建、测试或打包入口，优先复用项目已有脚本。
- 记录当前 Task 与源码快照上的结果；代码未变时状态检查可复用证据，代码已变则明确指出需要重跑。
- 最新失败、中断、错任务、过期版本和被改坏的证据不会被旧 PASS 掩盖。
- doctor 解释命令是否可用、是否遗留锁和证据是否有效，不产生执行副作用；正常 `$cap` 流程会自动完成这一步。
- Ontology 随安装清单校验；execution/release 随任务退场归档，连续新任务不再撞未知任务的旧快照目录。
- 历史经验提供只读审计，先筛查版本、完整性、重复和敏感标记，再按实际需求清洗。

没有测得统一的耗时节省比例；收益来自少填配置、少重复调查、减少旧结果误用。一次命令成功仍需结合测试覆盖与独立评审，不能自动证明业务正确。

## 本地用法

以下命令在 Skills 源码目录运行，`--repo` 指向已有 `.cap/STATE.md` 的目标仓库。用户通常不必手工执行，由 cap 流程负责调用。用户只描述需求；模型自动选择并调用这些内部动作，只有诊断或用户明确要求时才需要手工执行。

```sh
node scripts/cap-execute.mjs doctor --repo /path/to/project
node scripts/cap-execute.mjs run --repo /path/to/project --stage test
node scripts/cap-execute.mjs status --repo /path/to/project --stage test
```

默认发现 package.json 的 test/build 脚本。其他项目可传入实际 argv，例如：

```sh
node scripts/cap-execute.mjs run --repo /path/to/project --stage test -- python3 -m unittest discover
```

也可在目标仓库 `.cap/execution-config.json` 保存项目入口：

```json
{"schemaVersion":1,"commands":{"test":["node","scripts/test-all.mjs"],"implement":["npm","run","build"],"release":["npm","run","build"]}}
```

入口文件必须真实存在并传播子检查的失败退出码。记录器不做隐式 shell 或通配符展开；使用项目测试脚本聚合多项检查。实际运行超时默认 120 秒，可通过 `--timeout-ms` 调整，最大一小时；合计输出上限 1 MiB，超限记失败，不截成成功。

Windows 支持原生可执行文件与 Node 脚本路径；npm 会尝试解析 Node 安装旁的 npm-cli.js。自定义安装、pnpm/yarn 的 `.cmd` 包装器无法直接执行时，使用原生程序或显式 Node CLI 路径。本轮实测环境为 macOS；没有将 Windows 原生运行或生产发布算作已验证。

## 升级与兼容

使用 README 现有对应模式的升级命令，再运行安装 Doctor。团队安装继续团队模式，本地安装继续本地模式；没有静默替换团队配置。只有显式 local/local-only 流程消费这里的证据。

旧任务尚未使用新记录器时保持原入口，旧 HMAC 环境变量无需继续配置；v1 文件保留历史，不接受为 v2 证据。新 Task 可设置 `execution-required: true`，要求 implement/test/release 都有有效执行；首次使用记录器后，同 Task/Session 的该阶段自动接入检查。需求确认与 review 不用命令 PASS 代替。

运行途中断后，先确认记录器进程已经退出，再运行 `cap-execute.mjs recover --repo …`，使用新动作 ID 重跑。只清理已退出进程的锁，保留未完成证据；不自动重试任何部署。

## 历史经验怎么处理

```sh
node scripts/cap-history-audit.mjs --repo /path/to/project --limit 100 --json
```

只读索引及其引用的归档，不扫描整个代码仓、不调用平台、不删除或提升经验。`pass` 仅表示本轮检查未发现记录完整性/敏感标记问题，不能代替语义审核。先处理损坏和敏感记录；旧 Schema 和重复项按需要复核；合格经验继续保留机构、项目、协议版本和来源边界。没有索引的遗留资料需要另行登记，不能声称已覆盖全部历史。

## 边界与后续

当前交付是 Skills + Ontology + 本地可核对执行证据。哈希不构成本机写者之间的安全隔离；命令使用已有宿主环境，生产服务仍按项目原有发布流程执行。Server 授权身份、隔离 Runner、CI/CD 平台回执与生产健康检查的自动回传尚未接入，不能对外描述成全自主生产数字员工。

## 模型自动化入口

正常使用不需要记住 `cap-execute`、`doctor` 或 `status`。模型在进入编码、测试和交付阶段时自动：发现项目入口 → 运行对应动作 → 检查结果 → 失败时返回可执行修复动作 → 重新验证。若检测到已安装 Skills 与源码的版本、Commit 或文件漂移，状态结果会携带 `upgradeRecommended`，模型先按当前 local/team 模式执行升级，再重新检查，不会静默改写团队配置。

状态和执行器共同返回 `nextActions` 与 `remediation`。常见动作包括 `configure_execution_command`、`diagnose_command_failure`、`recover_interrupted_execution`、`inspect_source_changes` 和 `rerun_with_new_action_id`；模型按动作推进，不要求用户翻译内部错误码。新 Task 默认要求 implement/test/release 的本地执行证据，旧 Task 继续兼容原入口。项目画像中的 `PROFILE.test-commands` 优先于自动猜测，随后才读取 execution-config、package scripts 和语言项目文件。

失败执行会在本机动作目录留下限长、脱敏的 `diagnostic.json`，供下一轮模型诊断；原始命令参数和环境不写入证据，也不上传 Server。Release 优先使用 package/pack/prepare，只有不存在时才回退 build。
