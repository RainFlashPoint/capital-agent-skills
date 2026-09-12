# 本地执行与证据复用

## 适用范围

显式 local / local-only 模式，在已有 Task/Session 与源码调查之后使用。普通用户只需要描述需求并调用 `/cap` 或 `$cap`；模型在流程内部选择命令、执行记录器和状态检查，不要求用户手填本体、记住 doctor/status/execute 命令、生成密钥或配置平台。尚未采用记录器的旧任务兼容原流程；新任务的命令验证应使用记录器。

## 阶段连接

`ontology/execution.json` 是记录器阶段契约的唯一来源。implement 对应 build，test 对应 test，release 对应 package；understand/define/plan/review 使用文档、确认与独立复核证据，不能用退出码替代。命令成功只证明该命令在该源码快照上通过，不证明验收覆盖充分。主流程仍按变更选择必要检查并汇总报告；多项检查使用一个会传播所有失败的项目测试入口，不能用最后一个小测试替代全套验收。

主流程优先使用项目已有验证入口。记录器优先级为显式 argv、`.cap/PROFILE.md` 的 `test-commands`、`.cap/execution-config.json` 中的阶段/动作配置、package.json 已声明的脚本和语言项目文件。没有可用入口就返回 `configure_execution_command` 修复动作（补项目测试脚本或 `.cap/execution-config.json`）；不要求用户猜命令，也不猜测成功。Release 优先使用 `package`、`pack`、`prepare`，再回退 `build`，不放部署操作。

第一次运行后，同 Task/Session 的该阶段自动要求有效证据。需要三个命令阶段都检查时，可在 STATE 写 `execution-required: true`；这不改变文档阶段或现有团队流程。运行 `scripts/cap-execute.mjs` 后，由 `scripts/cap-status.mjs` 重验最近一次执行；实际阶段交接仍由 cap-flow 单写者负责。

## 什么使证据失效

Task、Session、仓库、分支、HEAD、index/worktree/untracked 内容、执行配置或记录器/本体版本改变，都需要重新运行。允许验证已有脏改动，但执行期间继续修改源码会使本次结果失效。生成物应按项目规则忽略，否则它们也是待验证源码变化。最新一次失败、中断或缺失 bundle 不能退回旧 PASS。提交会改变 HEAD，因此最终交付验证应绑定提交后的代码。

只读的 status/doctor 不执行命令、不访问平台。状态会返回 `nextActions` 与 `remediation`；模型按 `diagnose_command_failure`、`inspect_source_changes`、`recover_interrupted_execution` 等动作继续，不让用户记错误码。执行目录使用唯一动作 ID 与互斥锁；ID 不复用，锁存在时不自动重试。确认原进程已退出后可用 recover 清理锁，再创建新动作；中断记录保留。recover 不支持自动推断或恢复外部部署状态。

## 信任与数据边界

命令在普通宿主环境运行，继承该进程已有权限和环境，不新增授权体系；argv 不经过隐式 shell，项目脚本自身的 shell 行为仍由项目负责。超时和输出上限用于控制执行成本。记录器不是系统沙箱，也不能阻止本机可写者同时伪造请求和哈希。

`.cap/execution/<id>/request.json` 与 `bundle.json` 保存身份、源码指纹、命令/输出哈希、时间和退出状态；失败时另存限长脱敏 `diagnostic.json`，不持久化未处理的命令参数、环境或原始日志。`gate.json` 只是便于阅读的派生摘要。doctor 会显示选中的命令，请勿在配置参数中放凭据。

退场将 execution 和 release 一起归档并校验 manifest 哈希。历史经验先用 `scripts/cap-history-audit.mjs` 只读筛查，再按任务需要审核；历史 PASS 不授予新 Task 执行证据，审计通过也不等于内容正确或可跨机构复用。

CLI 示例和升级说明见仓库 `docs/local-efficiency-upgrade.md`。
