# Changelog

## 0.12.4

- 经验索引新增受限 `codePaths`、`entryPoints`、`symbols`、`invariants` 投影；历史侦察支持 `--anchor`，并报告经验源 Commit 与当前 HEAD 的关系。
- `task-context` 新增 History usage 采用证明，POSIX 与 Node/Windows 门禁都会要求候选、采用结果、原因以及对计划和验证的影响。
- 增加 gu-bei 风格路径/符号召回与历史采用门禁回归，保持远程团队知识库为权威，不新增本地知识搜索系统。
- 历史索引读取拒绝软链越界，兼容 SHA-256 Git 对象标识，并补齐 camelCase 符号的锚点投影。
- 修复独立评审发现的退场安全缺口：strict 模式拒绝未迁移的旧 manifest，历史索引在清理活动态前按全字段白名单、敏感信息失败关闭与 256 KiB 上限完成验证，代码路径只接受仓库相对路径。
- EVOLUTION 只把结构、Task、处置与经验 Schema 均有效的索引视为耐久证明；Task 切换以 Git index lock + 内容 CAS 防止并发暂存被覆盖，且只释放当前进程实际持有的锁。
- 历史侦察在真实 SHA-256 仓库中保留 Commit 路径锚点，并拒绝 archive/stale 根软链或普通文件，对 Task 与快照两层目录分别限制单次枚举规模。
- strict Retire 进一步要求经验原稿的 `task-id` 与完整 `source-commit` 精确绑定当前 Task/Delivery；`pending-sync` 只接受同 Task、同 Commit、幂等键一致且载荷可重放的 Outbox 事件。
- 未处理的 `pending-sync` / `needs-harvest` 债务不再依赖新任务关键词才能被发现；历史索引侦察每次最多读取 1000 项并显式报告截断，避免长期 Git 知识积累拖垮每次代码侦察。
- 历史侦察读取端现在对 index 文件名、Task、artifact root、处置枚举与 experience path 做完整绑定校验；伪造/损坏索引和 stale manifest 不再获得知识债务优先级，`knowledge-audit` 对非字符串处置失败关闭而不崩溃。
- archive、stale Task 与 snapshot 目录改为真正流式有界枚举并报告截断；POSIX 与 Node/Windows Context Guard 统一裁剪 History usage 字段，空白值和 `none` 尾随空格不能绕过采用门禁。
- Retire 在快照前递归拒绝顶层与嵌套软链接，失败保留活动态；历史侦察统一校验 canonical `.cap` 的整条路径链，防止经 `history` / `archive` / `local-state` 父级软链接读取仓库外内容。
- Retire 在 snapshot/cleanup 前验证 `.cap/history/index` 整条写入路径，拒绝软链接与错误目录类型；POSIX 索引原子替换绑定 no-follow 目录句柄，避免向仓库外写入后才发现失败。
- 完成态 Retire 重新绑定归档 manifest 校验并安全修复丢失/损坏的耐久索引；索引读写与审计统一拒绝父级软链，处置状态与知识文档 ID 强制双向一致，敏感投影补齐裸 JWT、GitHub/AWS/API token 和 UNC 路径检测，Node/POSIX Context Guard 统一精确标题语义。
- Task 切换拒绝 stale 父链软链接并连同 `execution/` 隔离；strict Retire 显式区分 local/server Gate 且绑定精确 Commit，恢复元数据、实现锚点与 Evolution 单行输入均失败关闭；历史召回为相关锚点保留容量，Node 校验与 Python 对齐，knowledge audit 增加总读取预算和截断证据。
- Retire 不再接受调用者自签的 Gate 参数：local 必须读取精确 `STATE cap-gate`，server 必须实时读回 canonical Review Action；`EVOLUTION.md` 纳入 no-follow 有界读取与 audit 总预算，身份字段敏感值和占位实现锚点在 Python/Node 两端失败关闭。
- Retire 中断恢复与 complete 幂等路径也会重新验证归档 local Gate 或实时 server Review Action；知识原稿、历史召回和经验载荷统一使用 no-follow 文件描述符读取并复验 inode/containment，audit 按实际打开文件计费，带尾部标点的占位锚点与 stale/payload 敏感 Task ID 全链拒绝。
- 收紧最终并发边界：经验载荷同步拒绝敏感 Session ID；Retire 以独占锁串行化并在清理前复核 Gate 与活动工件 CAS；Task 切换在锁内重验 STATE，预先 fsync 新 context/STATE 并以 STATE 作为原子发布提交点。

## 0.12.3

- 修复 `.cap` 知识生命周期：严格 Retire 必须记录可验证的同步处置，只有脱敏历史索引进入 Git，避免本地经验长期不可见或被误报为已同步。
- Evolution 改为有耐久索引证明保护的 50 条活动窗口，新增只读 `knowledge-audit` 与 pending/local/needs-harvest 历史侦察。
- Task 切换阻止未 Retire 的完成态；tracked 活动态迁移改为显式、ignore 覆盖校验和临时 Git index 原子替换。

## 0.12.2

- Codex 的 Capital Agent MCP 从强制启动迁移为可选启动，平台暂时不可达时不再阻止整个会话和普通对话；安装与升级幂等迁移历史 `required=true`。
- Doctor 将会阻断会话启动的强制 MCP 配置判为失败并提示升级；团队模式仍在每个研发任务入口主动检查 MCP、尝试平台握手，缺失时进入 `restart_required`，禁止静默默认本地。
- `local_fallback_explicit` 从 Task + 分支进一步绑定当前运行会话；新会话、Task/分支变化或 MCP 恢复加载时自动失效并重试团队模式，避免一次本地选择长期残留。

## 0.12.1

- 新增 `cap-execute run --compact` 模型输出投影：成功态只返回 Gate、结果哈希、字节数和 Artifact 引用，默认输出与既有 `--json` 保持兼容。
- 命令失败、超时、输出超限或源码漂移自动返回 `full-fallback`，携带脱敏且有界的头尾诊断；无分隔符的超长单行使用明确的安全投影，避免截断边界泄漏凭据。
- 公开入口增加测试、构建和 Git 输出预算纪律；完整执行证据与 Gate 语义不变，mock A/B 固化决策等价和至少 50% 的正常日志缩减门槛。

## 0.12.0

- 新增 `cap-status --compact` 决策投影，保留安装、平台、仓库、Task/Action、Outbox、边界、纠偏、Push 与下一动作；默认完整 JSON 和文本输出保持兼容。
- 阻断、Server 纠偏、未知 blocker、Outbox 阻塞或无归属事件自动返回 `full-fallback`，避免轻量模式隐藏新协议或异常证据。
- 公开 `cap` 入口改为按复杂度和阶段懒加载：L1/L2 使用最小协议，高风险或未知分类升级完整 `cap-flow`。
- 增加本地 mock full/compact A/B 回归，校验决策签名等价、风险态完整回退及平均 JSON 字节数至少下降 50%。

## 0.11.4

- 同步 GitHub 首页的最新版本章节与插件版本，避免版本文件已升级但 README 仍对外显示 v0.11.0。
- 隔离验证确认旧版安装清单会产生 `version_drift` / `upgrade_local_skills`，重写安装清单后收敛为 `current`。

## 0.11.3

- 团队模式为 Codex 安装原生 Streamable HTTP MCP，用 `http_headers_helper` 动态读取本机 `x-user-key`，不再把 Codex 连到无远程身份的本地 STDIO Server。
- 安装/升级幂等迁移旧版 Codex stdio 条目，保留其它个人配置；Claude/Cursor 继续使用兼容的 stdio 远程代理。
- Doctor 显式区分 HTTP、旧版远程 stdio 和错误本地 stdio，并携带用户身份真实执行 MCP `initialize` / `tools/list`。

## 0.11.2

- 新增受控 Push 候选交付入口：绑定 fetch/push URL、Task、branch、Commit 与授权指纹，依次执行 Push、同目标远端 ref 精确回读、候选登记、CI refresh 和 canonical Task 回读。
- 候选交付改用远端实时 ref 作为真值，失败路径不进入 Outbox；候选已接受但后续刷新失败时返回可重试的 partial 结果。
- 验证证据必须绑定候选 Commit：字段别名重复即拒绝，失败或畸形退出码不可声明 PASS，必须存在成功命令且命令和环境仅上传哈希，质量资产只能作为补充；canonical 回读必须确认同一 Task 与候选。
- Push 前强制校验非空 Task 身份，成功后安全刷新本地远端跟踪分支；远端漂移与 Git 错误只返回脱敏摘要，拒绝 HTTP userinfo 及 URL query/fragment，同时兼容标准 SSH 用户名；本机 Test Provider 如实声明 `public` 网络区。
- `local-only` 仓库策略优先于平台凭据检查，避免误报缺少 `x-user-key`，也避免生产 CLI 提前读取平台配置。
- canonical 回读兼容顶层与 `gates` 投影，并支持 SHA-1/SHA-256 Git 对象 ID，避免远端已写入后被客户端误报为 partial。

## 0.11.1

- 模型自动编排补齐机器可读 `nextActions` / `remediation`，失败、源码变化、锁中断和缺少命令都有可执行修复动作。
- 新 Task 默认要求本地 implement/test/release 执行证据；旧 Task 保持兼容。
- 执行器接入 `.cap/PROFILE.md` 命令、package/pack/prepare 发布入口及 Python、Go、Cargo、Maven、Gradle、Make 项目发现。
- 失败动作保留限长脱敏诊断，修复安装清单漂移提示与本地经验沉淀文案矛盾。

## 0.11.0

- 本地执行升级为无需账号/密钥的 local-observed v2：阶段契约、项目命令发现、doctor、独占执行与中断恢复；正常 `$cap` 由模型自动调用这些内部动作。
- cap-status 自动检查安装清单漂移并返回可执行升级动作，模型可先升级再继续当前研发阶段。
- cap-status 重验请求/bundle 的任务身份、版本、源码快照和结果；最新失败或中断不回退旧 PASS，不再信任独立 gate.json。
- 文档和独立评审保留各自证据要求；命令成功不替代业务验收，新增授权体系与生产隔离延后。
- Ontology 纳入安装清单与 Doctor；execution/release 纳入退场哈希归档；修复无活动 STATE 连续建任务的快照碰撞。
- 新增历史经验只读审计和公开升级指南，保留团队模式与旧任务兼容路径。

## 0.10.0

- 新增本地 Ontology 底座：严格 Schema、租户/项目/渠道/产品/协议版本隔离、来源 hash、有效期、内容准入及显式授权的冲突替代。
- 新增真实 `.cap` 只读导入、受限旧状态迁移、知识草稿来源绑定与 Agent 上下文 CLI；移除硬编码任务/阶段原型。
- 独立 receipt 按完整任务/代码/环境身份校验；知识不能赋予执行权限，本地 PASS 不能提升为 Server Gate。
- 集成 Skills 来源漂移锁、语义反例测试与两套真实支付任务的脱敏验证；未接通 Server 身份/Runner 适配器时默认无授权执行。

## 0.9.7

- README 新增自动升级命令：从 `~/.capital-agent/install-manifest.json` 读取 `sourceRoot`，无需手工填写源码目录。
- 分别提供团队模式与本地模式的 macOS/Linux、Windows PowerShell 升级和 Doctor 命令，避免模式误用。

## 0.9.6

- 收紧 fresh-context 独立复核报告格式：主流程统一写入并校验固定字段、Commit、三段工作区指纹和源码未变证据。
- 非标准状态词、缺失指纹或自然语言完成总结不能再升级为 `satisfied` / Review PASS。

## 0.9.5

- 为 L3/L4 与支付、安全、权限、跨仓、MCP、状态机等高风险改动增加 fresh-context 独立复核门：评审前自动启动恰好 1 个只读 Agent，隔离主会话判断。
- 独立报告绑定 source/base Commit、`cap-context-fingerprint` 和源码未变证据；`unavailable`、`failed`、`stale`、`invalid` 不得冒充 Review PASS。
- L1/L2 未命中风险信号的任务保持原有短路径，不启动额外 Agent；对抗 pass 复用同一独立 Agent，不重复 fan-out。

## 0.9.4

- 跨独立项目切换强制携带已审阅 outgoing 摘要，并将 incoming 落地与会话根替换组成可回滚事务，杜绝目录缺失造成的半切换。
- Task 初始化记录目标仓原有脏路径；Context Guard 对 `modify` 范围执行归属重叠门禁，阻止旧任务改动混入新提交。
- Task 状态切换在移动前检测已跟踪 `.cap` 活动态，失败时保持文件与 Git 状态不变，不再制造批量删除。

## 0.9.3

- 将项目本地 `.cap` 纳入需求确认、开发计划、编码实现、测试验证、代码评审和发布上线的必选前置，核对任务、分支、工作树、范围与门禁状态。
- 明确双模式经验闭环：团队/Server 模式使用 `enrich_context` / `record_experience`；显式本地模式不调用 MCP，改用并校验 `.cap/experience.md`。
- 交付前统一复核改动文件、`git diff --check`、`.cap` 证据、验证结果和提交范围。

## 0.9.1

- 放开同一聊天内的跨独立项目顺序开发：仍保持一个唯一可写主仓，但可通过显式 `cap-session-root.mjs switch` 切换。
- 切换时重新建立目标项目的 Task、Session、分支、HEAD、工作区指纹和验证证据；来源项目只通过带来源 Commit、待验证标记的交接摘要传递业务上下文。
- 同一远程项目的不同 clone/worktree 继续阻断；旧 `.cap`、Gate、Delivery、Outbox 和完成结论不能自动跨项目继承。
- 新增跨项目切换与同项目拒绝的对抗回归，保留切换失败时原主仓锁不变的安全边界。

## 0.9.0

- 新增 Windows 10/11 原生 PowerShell 安装、升级与 Doctor 入口，复用现有 Node 安装真值，不要求 WSL。
- Windows 支持 Codex、Claude Code、Cursor 的 Skill/MCP 配置、Git 交付、团队 Task 和知识闭环；新增 Node 版 branch/worktree、session-root、task-context 与新任务守卫。
- Windows 本机 Test Provider 明确为 `remote-only`，独立 Gate 交给 Server/Linux Runner；Doctor 显示 SKIP 而不伪造 PASS。
- Darwin/Linux 继续强制安装并检查本机 Test Provider，完整既有发布回归保持为升级硬门。

## 0.8.1

- 新增会话级 canonical Git root 锁：首次 `cap-status` 以用户打开的仓库建立唯一目标，旧 `.cap` 的 worktree、task-context 绝对路径和历史元数据只作校验，不能反向导航到 sibling worktree。
- `cap-status` 在读取错误仓 STATE/Outbox 前返回 `session_root_blocked`；`cap-context-guard`、`cap-guard`、Task 状态切换和 `prepare-commit-msg` 在阶段与提交边界再次复核。
- 增加 A/B 双 worktree 对抗回归：覆盖 B 的 STATE 与 B 完全自洽、路径别名、无稳定会话 ID 的兼容降级、锁目录软链和错误目录 Git Commit。

## 0.8.0

- 新增 `.cap/experience.md` 作为人和 AI 共读的唯一经验原稿；`task-context.md` 继续保存调用链和代码事实，生成器不再从 spec/STATE 自动猜经验。
- 经验原稿必须覆盖复用触发与检索线索、问题根因、失败做法、条件化决策、可执行行动、实现锚点、不变量、验证配方、适用前提、反例和失效信号。
- 质量门拒绝只有调用链、宽泛空话、缺失可观察验证结果、Commit/验证证据不一致、绝对路径、软链逃逸和敏感信息；失败时不回退旧式总结。
- 业务源码在 `changed_files` 中优先于 `.cap` 流程文件，避免知识摘要被流程元数据占满；幂等身份同时绑定 canonical 经验内容。
- 显式本地模式也生成并校验经验原稿，但不连接平台、不写 Outbox；Task 切换会隔离旧原稿，Retire 会把原稿纳入历史快照，并把召回线索和决策摘要写进只读索引供下一任务自动发现。
- 增加 25 个经验契约回归，以及 Task 切换和 Retire 生命周期测试；真实汇元支付案例可确定性生成包含定位、决策、验证与失效边界的结构化载荷。

## 0.7.3

- 新增确定性经验载荷生成器，从标准 `.cap` 规格、决策、验证与评审产物生成完整结构化经验，不再把高质量任务交给模型二次萃取。
- 证据不足时 fail closed，不调用旧式 LLM fallback 冒充可复用知识；结构化经验仍由同 Task、同 Commit 的 Server Gate 决定是否发布。
- 增加 Markdown 提取、缺证据、软链逃逸和敏感信息脱敏回归，并将生成器接入 Skills 结构门禁。
- 最终结果摘要排除 TDD RED 与零失败计数，避免被 Server 保守策略误判为交付失败；否定式验证和非 clean Review 不得生成 PASS。

## 0.7.2

- 平台可用时，客户端阶段、状态和下一动作真正以 Server canonical projection 为准，并把纠偏结果安全写回本地游标。
- 没有最终候选 Commit 与对应 Test Action 时不再误报“平台正在测试验证”；普通 Delivery 已由 Server 幂等接收时自动清理对应 Outbox。

## 0.7.1

- 新任务开始时主动运行只读历史侦察，一次定位相关历史分支、Commit、`.cap` 工程记忆与历史索引；不再先反问用户“以前是否做过”。
- 团队知识归因改为冻结快照、Server 实际注入台账与客户端采用声明三方交集；旧会话缺台账时保留兼容统计，但不再冒充精确采纳。
- 团队模式把 Task 冻结知识快照的最小文档 ID 集合返回给客户端，并在注入内容中显示实际知识 ID，让客户端能够明确反馈采用对象。
- 经验发布只接受同一 Task、同一 Commit 的 Server Gate 证据；客户端自报 PASS 仍可保存为 candidate，但不能直接成为 validated。
- 安装升级会迁移旧 `~/.codex/skills` 中确认属于 Capital Agent 的重复 Skill，目录保留在可恢复备份；Doctor 会阻止双版本继续伪装为正常。
- 增加真实 MCP 契约回归，覆盖 Task 创建返回 ID、知识注入标注 ID、Delivery 精确归因与快照外 ID 拒绝。

## 0.7.0

- 新增统一 `scripts/release-check` 发布门禁，在显式本地模式下覆盖结构、行为、并发、安全边界与补丁检查。
- 本地 Test Provider 改为最小环境、临时 HOME 与 fail-closed OS 沙箱；团队模式不再允许 STATE 文本自证 Server Gate。
- Outbox 增加仓库内原子锁、唯一临时文件、损坏阻断与软链 containment，并通过 40 进程并发回归。
- 持久本地模式的 post-commit 完全跳过平台与 Delivery Outbox；MCP user key 不再出现在子进程参数，仓库 URL 外发前统一移除嵌入凭据。
- 安装时记录源码 Commit、插件版本和受管理文件哈希，Doctor 可识别旧安装副本与文件漂移。
- 任务上下文加入 index、worktree、untracked fingerprint；Guard 统一从 canonical Git root 工作，子目录运行不再漏检。
- Retire 使用可重入的分阶段事务，snapshot、cleanup、index、leaf 与 backflow 中断后可幂等恢复；旧归档恢复会校验 Task、Gate、manifest 哈希、路径 containment 与清理白名单。
- 统一 Review → Release → Retire 顺序，Review PASS 不再把任务直接写成 done 而跳过交付收口。

## 0.6.6

- 团队模式新增 `restart_required` 客户端选择门：当前会话未加载 MCP 时，默认建议重启恢复团队链路，也允许用户明确选择本次本地继续，不再让升级问题把研发完全卡死。
- 新增一次性 `local_fallback_explicit`：不修改机器团队配置，仅当前任务跳过平台 Task、经验、Delivery、Server Gate 与 Outbox。
- 本次本地选择持久绑定当前 branch + Task，后续阶段和 Git Hook 共享同一判断；切换 Task 自动失效，避免 `post-commit` 误写 Delivery Outbox。
- `cap-status` 接收 `loaded / missing / unknown` MCP 运行时信号；显式本地模式继续可用，直接探测失败与客户端未重载不再混为同一种故障。
- 安装、升级和 Doctor 明确说明已打开会话不能热加载 Skill/MCP，要求完全重启客户端并新建任务，同时确认现有分支和工作区改动不会丢失。

## 0.6.5

- `record_experience` 增加稳定 `idempotency_key`：结构化经验由 Server 直接入库，旧客户端模型补全失败时降为 candidate，不再整条丢失。
- Outbox 的 `experience.record` envelope 与 payload 共享同一幂等键，恢复重放不会重复累计文档、harvest 事件或数据点。
- Delivery 增加 `knowledge_used_ids` 精确采用集合，只允许引用 Task 冻结知识快照；旧调用标记为 `coarse_legacy`，不得把整个快照当成全部采用。
- 经验结果证据关联来源 Task、后续 Task、实际使用文档、终态成功和首轮通过，支持验证“第一次踩坑，第二次避开”。

## 0.6.4

- 本地与团队模式保持同一最新基线：显式 `--local` 诊断不再被 Server 探测覆盖，未产生首个 Commit 的新仓库可用 `working-tree` 进入研发流程。
- macOS、Linux 与 Windows 的 Node.js 直连探测增加系统 DNS 解析降级；仍执行真实鉴权能力握手与 TLS 主机校验，不以端口连通伪造 PASS。
- Doctor 改为逐个调用 Codex、Claude、Cursor 配置中实际注册的 MCP command/args，旧路径损坏时明确失败，不再由当前 checkout 代测。
- `local-only` Skills、工具链和流程仓创建 Task 时使用 `evidence_only`，只登记普通 Delivery 与本地维护证据，禁止业务 Harness Candidate。

## 0.6.3

- 新增仓库级 `harness-mode`：真实业务仓使用 `server`，Skills、工具链和流程维护仓可声明 `local-only`，不再按 GitHub/GitLab 推断验证方式。
- `local-only` 仓库仍保留 Task、普通 Commit Delivery、本地验证、维护评审和经验闭环，但客户端确定性拒绝 Delivery Candidate 与 Server Test/Review Action。
- capital-agent-skills 自身标记为 `local-only`，避免再次被公司业务 Harness 当作测试项目。

## 0.6.2

- Task 创建因敏感测试元数据被策略拒绝时，客户端改为确定性移除具体配置值并仅重试一次；仍失败则硬阻断，不再静默降级后继续编码。
- `cap-status` 新增 `boundary_blocked`：STATE 与当前 branch/worktree 串台时停止旧 Delivery 补报和所有研发阶段，并返回结构化修复动作。
- 新增原子化 Task 状态切换：旧 `.cap` 活动态先保存到本地 stale 快照，初始化失败自动回滚，业务源码与 Git 状态保持不变。

## 0.6.1

- 修复从 Git worktree 运行 Doctor 时误报 Codex MCP 未注册：已安装的 Capital Agent MCP 可位于另一份有效 checkout，不再要求配置路径必须等于当前 worktree。
- 修复提交 Hook 与 `.cap` 二分策略冲突：允许 `STATE/spec/plan/verify/review` 保持本地忽略，同时继续阻止应跟踪的 `PROFILE/EVOLUTION/archive` 产物遗漏提交。

## 0.6.0

- 客户端改为消费 Server 的当前 Commit、Gate、Action、结构化阻塞和下一动作；平台与 STATE 冲突时明确纠偏，不再让本地游标覆盖业务真值。
- post-commit 永远登记普通 Delivery；最终候选必须绑定精确 repo、Task、branch、HEAD 与一次授权 fingerprint，并确认已推送和本地验证通过。
- 候选 Delivery 只允许在当前授权下实时发送，不进入历史 Outbox 自动重放；remote URL 凭据会在计算授权指纹前移除。
- 固化 Session/Task、local PASS/Server Gate、历史 Outbox/当前授权边界，并增加结构 lint 防止协议回退。
- 状态诊断展示部署 Commit、Schema revision 与 Task store mode，无法证明线上版本时不再宣称已部署。

## 0.5.1

- 收紧 Delivery 候选协议：普通开发 Commit 只登记交付事实，不再自动创建独立 Test Action；仅最终候选 Commit 以 `delivery_candidate=true` 进入 Test → Review 门禁链路。
- 明确候选 Commit 必须已推送到任务声明的远程分支，并保持同一 Task 内幂等补报，减少中间 Commit 造成的 Action 取消风暴。

## 0.5.0

- 新增显式本地安装、升级与诊断入口：`setup.sh --local`、`--local --upgrade`、`--local --doctor`，自动安装公开 Skill 与三种客户端激活规则。
- `CAPITAL_AGENT_MODE=local` 成为一等运行模式：主动跳过平台握手、Task / Session、MCP、Harness、Delivery、Experience 与 Outbox，不再把无 Server 用户误报为平台故障。
- 本地模式支持 Node.js 18+；接入 Server 的 MCP Runtime 继续严格要求 Node.js 20.18.1+。本地测试与评审保留为本地证据，不冒充 Server Gate。

## 0.4.9

- 新增任务入口“分支意图 Gate”：不再只检查是否直写主干，还会识别历史功能、维护、release、客户变体和其他 Task 分支；分支不匹配时要求新建、续用或切换基线，并记录 branch purpose 与 base commit。
- 新增提交出口“Commit scope Gate”：按必须提交、需要确认、明确排除分类完整脏区，保护既有改动和本机配置；回归测试、契约文档与共享配置按实际交付价值判断，禁止按目录一刀切或使用 `git add .` 一锅端。
- STATE 模板、开发计划、编码实现和结构校验同步新增两道 Gate 的持久字段与一致性检查。

## 0.4.8

- 直接 HTTP 探测不可用时不再误报平台 `network_error`，改为等待 Capital Agent MCP 做最终确认。
- MCP 连接成功会覆盖直连探测结果；只有直连与 MCP 都失败时才进入本地降级。
- 区分“执行进程无法直连”和“平台明确拒绝握手”，避免研发误判平台断网。

## 0.4.7

- 根 `.cap` 固定表示当前活动需求；新需求开始前阻止覆盖仍在执行或待退场的 Task。
- 完成需求按 Task 生成可校验历史快照和索引，只有同 Commit 的 Delivery 与 Server Gate 通过后才清理活动产物。
- 历史需求默认不全量注入 AI；续作通过父 Task 或精确索引按需召回，并重新核验当前代码。

## 0.4.6

- 修复 Node 18 下 `mcp-remote` 的 `undici` 启动失败：统一要求并自动寻找 Node 20.18.1+，三种客户端写入同一兼容 Node 绝对路径；不兼容时在覆盖 MCP 配置前 fail-closed。

## 0.4.5

- 新增 Cursor 一键适配：安装唯一 `cap` Skill、注册固定 MCP Runtime，并写入 always-on 研发规则；真实 Git 研发请求自动创建或绑定 Task，纯问答不上传。
- Cursor MCP 配置采用幂等 JSON 合并，只维护 `capital-agent` 条目，保留已有顶层字段和其它 MCP Server；配置损坏时 fail-closed，不覆盖原文件。
- Doctor 增加 `Cursor MCP` 与 `Cursor 自动进入 Cap` 真实配置检查。

## Unreleased

- Outbox 按当前 Task 投影活动待同步事件；显式切换 Task 时自动把可确定归属的历史事件原样归档到本地，不重放、不删除，历史元数据不再反复阻塞新任务。
- README 新增本地模式与团队增强模式：明确 Skills 无需 Cap Server 即可供个人、开源团队和其他公司使用，并分别说明安装方式、能力边界及接入 Server 后获得的统一 Task、中心知识库和独立 Harness Gate。
- 重构 README 产品表达：围绕 Agent 研发主线、可信门禁、持久状态和经验飞轮说明项目价值，精简内部字段与运行细节，同时保留完整安装、升级、诊断和使用入口。
- 更新 README 路线图：标记中心知识库统一出口、owner/runner 归因链路和文件预测 F1 数据契约已经落地，并把尚未完成的个人看板与服务端趋势报告拆成明确后续项。
- Codex MCP 注册改为幂等维护 `~/.codex/config.toml` 受管理区块，不再要求 Codex Desktop 用户额外安装或暴露 `codex` CLI；保留其它 MCP 与个人配置。
- MCP Bridge 改为 setup 时固定安装到本机运行时目录，Codex 启动时不再依赖 `npx`、GUI PATH 或临时联网下载；Doctor 真实执行 MCP initialize 与 tools/list，避免“已注册但不可用”假 PASS。
- 新增 `scripts/setup.sh` 作为统一安装入口，自动发现 PATH、Homebrew、Volta 与 NVM 的 Node.js；Shell 找不到 Node 时不再直接报 `command not found`，而是输出明确的 Node 18+ 修复方式。
- setup 以幂等受管理区块安装 Codex/Claude 全局自动激活规则：Git 仓库中的真实研发请求无需显式 `$cap` 即创建/绑定 Task，纯问答与讨论不上传；用户原有全局指令保持不变。
- 本地 Test Provider 在长测试期间每分钟续租一次，每次仅延长 5 分钟且总生命周期最多 10 小时；连续三次续租失败主动终止测试，避免失联进程无限运行。
- `setup --upgrade` 自动安装并注册按需启动的本地 Test Provider，凭证仅以 `0600` 保存于研发机，不再要求研发理解 Runner ID 或 Token。
- 本地 Provider 只领取当前用户显式指定的 Test Action，在独立 worktree 执行后物理清理；Server 强制 test-only，拒绝无 Action ID、跨用户和 Patch 认领。
- `setup --doctor` 新增本地 Provider 文件、凭证与 Server 鉴权探测。
- 新增开源发布安全门禁，阻止真实凭证、私网地址、固定身份和企业项目细节进入公开仓库。
- 将统一入口中的企业项目示例替换为通用占位仓库，避免项目与分支信息进入公开 Skill。

## 0.3.9 — 2026-07-27

- Harness Action 进入终态后强制同步刷新 STATE 与 Test/Review 阶段报告，旧的“等待 Commit、Action 未创建”描述必须被替换。
- 本地证据统一记录 Action、源 Commit、Provider 终态、Server Gate、机器分类和解除条件；`ENV_BLOCKED` 不得被写成代码失败或 PASS。
- Test Action ready 后自动唤醒本机已注册 Runner，只领取 Harness Action 并继承本机 Maven/npm/SDK 环境；本地 Provider 不可用时不再回退到 Server 猜测研发环境。

## 0.3.8 — 2026-07-27

- 增加精确 Commit 的 Push 门禁：当前 HEAD 未在上游分支可见时明确提示远程、分支和 Commit，授权后连续执行 Push、当前 Delivery 与 Test Action。
- 当前 Task 主线与历史 Outbox 完全解耦；历史元数据补报不再阻塞当前测试与评审。
- Harness 预检错误按 Commit 未推送、仓库认证、分支缺失、Provider 状态和验证命令缺失分类展示；Test 成功后自动接力只读 Review，不再要求用户重复输入“继续”。

## 0.3.7 — 2026-07-26

- 为所有外部系统集成增加四条跨项目安全硬门：环境选择 fail-closed、配置作用域不升级、真实调用显式启用、新配置默认不产生流量。
- 编码与 Review 在命中外部系统或环境配置时共享同一组不变量；支付渠道的表、枚举、字段和接口仍留在专项 Skill、项目画像与经验层。
- 增加结构回归，防止通用角色卡丢失不变量或混入具体项目字段。

- 修复已完成父 Task 的后续任务接续：`cap-status` 自动解析活动 follow-up Task，强制新建 Skills Session、按本轮刷新验证命令，并避免把父 Task 的最后 Commit 误补报到 follow-up。
- `$cap` 握手新增平台 Action 接力：按仓库/分支自动认领 Review 或验证工作项，完成后回写统一证据并由 Server 自动重算 Gate，不再停在“等待 Review”。

## Unreleased

- 经验沉淀携带 Task/Commit，由 Server 根据同 Commit Gate 自动生成可信验证判定；`cap-status` 读取平台 Task，避免本地 STATE 陈旧时仍显示“测试验证”。
- 客户端 Doctor 升级为能力握手，验证身份、Task 写入、Commit 对账与 MCP 注册状态。
- 项目治理新增兼容原 Hook 的 `post-commit` 自动补报；网络失败写入本地待发送队列，并在下一次 `$cap` 状态检查时自动重试。
- Delivery 协议支持知识直接采用、修改采用、未采用与误导反馈，供平台计算真实采纳率。

## Unreleased

- 拆分代码交付与环境验证门禁：开发/测试分支允许在 `ENV_PENDING/ENV_BLOCKED` 时推送，受保护分支仍要求完整 verify/review gate。
- `cap-status` 增加本地 HEAD、upstream HEAD 与 `delivery-head` 对账，自动暴露 IDEA、人工或其它 Agent 产生的未登记 Commit。
- 已选择安装的 Capital Agent `pre-push` Hook 会在治理安装器运行时自动升级到最新门禁语义；非 Capital Agent Hook 不会被覆盖。

## 0.3.6 — 2026-07-23

- 新增确定性 `cap-status.mjs`：一次检查平台配置与身份、Git 仓库、Task/Session、当前阶段和下一动作。
- `$cap` 开场强制输出客户端握手快报；MCP、身份或平台失败时明确进入本地降级，禁止静默丢失平台闭环。
- Artifact 和 STATE 不再被视为流程终点；无人工门禁时，同一会话必须按下一动作继续执行。
- 增加握手、旧阶段归一、门禁停留和产物驱动下一步的回归测试。

## 0.3.5 — 2026-07-21

- Codex 与 Claude 的技能列表只安装唯一入口 `Cap`；经验闭环、内部编排器及七个研发阶段继续保留，由 `Cap` 按意图和复杂度自动调用。
- 升级安装会安全清理旧版本遗留且仍指向本技能包的内部阶段软链接，不删除用户目录或其他来源的同名 Skill。
- 同时清理已从源码退场的 `cap-map`、`cap-shape`、`cap-build`、`cap-verify` 历史软链接。
- 统一公开入口说明：用户只描述要完成的研发工作，`Cap` 自动选择必要步骤并在真实编码会话中执行经验闭环。

## 0.3.4 — 2026-07-21

- 经验生命周期明确为 `candidate → validated → promoted → deprecated`；promoted 要求至少两个不同 Task 证据和管理员批准，deprecated 支持原因与替代关系且不再注入。
- Review finding 蒸馏改为至少 3 个不同 Task/Run，同一轮多个 finding 不重复计数。
- 同一问题与解法使用稳定 fingerprint 去重并累计证据；外部 Skill 必须记录 URL、版本、License 和 fixture/验证引用。
- 指标语义纠正：旧 `reuse_rate` 仅作曝光率兼容，明确新增曝光率、采纳率和误导率。

## 0.3.3 — 2026-07-21

- `record_experience` 改为提交结构化问题、解法、适用条件、反例、证据引用和结果，不再把文件路径摘要等同于经验。
- 未验证或旧客户端产生的内容只能进入 candidate draft；只有带 PASS 证据的经验才能发布并注入当前项目。

## 0.3.2 — 2026-07-21

- 增加 `cap-context-guard`：进入计划、实现、测试、评审或发布前，确定性检查任务调查的 intent、branch、HEAD 与路径证据。
- 增加临时 Git 仓库行为 fixture，证明仅有 PROFILE 不可进入计划、代码变化会使调查过期、缺少测试证据会阻断流程。

## 0.3.1 — 2026-07-21

- 增加强制可见进度协议：每个阶段明确“当前、正在做、完成条件、下一步”，长操作与阶段交接持续播报真实进展。
- 增加任务级代码侦察协议：每个新任务必须从当前仓库代码建立 `.cap/task-context.md`，项目画像只作为搜索索引。
- 七个阶段 Skill 均强制加载两份共享协议，并增加结构回归防止后续绕过。

## 0.3.0 — 2026-07-21

- 阶段协议统一为 `understand → define → plan → implement → test → review → release`。
- Skill 本体同步改名为 `cap-understand`、`cap-define`、`cap-implement`、`cap-test`，不再保留难理解的旧 Skill 名。
- 新生成的 `.cap/STATE.md`、Skills Session、Task Artifact 与平台事件只写新阶段 ID。
- `map/shape/build/verify` 仅作为旧任务读取兼容值，读取后立即归一化，不再继续传播。

## 0.2.1 — 2026-07-21

- 将 `$cap` / `/cap` 明确为研发唯一公开入口，用户无需理解内部阶段名。
- 新增“项目了解、需求确认、开发计划、编码实现、测试验证、代码评审、发布上线”直白动作词，并支持 `/cap 需求`、`/cap 开发`、`/cap 测试` 等表达。
- `cap-shape`、`cap-build`、`cap-verify` 等名称降为内部兼容 ID，保留历史 STATE、平台事件和旧客户端兼容性。
- 增加公开入口词汇回归校验，防止后续文档再次把内部阶段名暴露给研发。

遵循语义化版本。格式参考 Keep a Changelog。

## [0.2.0] — 2026-07-21

### Added
- 新增 L1–L4 研发复杂度路由：小改动使用精简流程，中高风险与生产发布保留完整 map、shape、plan、build、verify、review、release 门禁。
- `PROFILE.md` 新增 `Verification environment` 项目验证环境画像，记录运行时、执行区域、依赖仓库、Secret 引用、可组合服务、企业服务、确认缺口和权威验证阶段；禁止记录密钥明文。
- `cap-verify` 新增 `PASS / CODE_FAILED / ENV_BLOCKED / INCONCLUSIVE` 四类验证归因，环境与依赖问题不再伪装成代码失败。
- Skills 交付证据新增当前 Commit、UTC 执行时间、实际命令与 exit code、质量资产 ID 和脱敏环境指纹，供平台判断证据新鲜度与可信度。
- 新增复杂度路由与 Git Hook 回归测试。

### Changed
- 提交包含业务代码时，`.cap/STATE.md`、spec、plan、verify、review 等当前研发产物必须一并暂存；本地 exclude 或 ignore 隐藏 `.cap` 会阻止提交。
- Commit Hook 继续自动追加 `Task:` / `Session:` trailer，并明确区分“本地已提交”和“已推送、平台可见”。
- 平台只应采用与最新 Commit 匹配的验证证据，旧 Commit 的 PASS 不得替新提交放行。
- `cap-map` 会从 Dockerfile、CI、toolchain、依赖配置和测试文档建立初始环境画像，未知依赖显式记录为 `unknown`，不由 Agent 猜测。

### Fixed
- 修复 `.cap` 研发产物可能因只加入本地 `.git/info/exclude` 而未进入交付提交的问题。
- 修复 Skills 已生成 Task/Session 元数据，但提交说明缺少可靠关联 trailer 的交付断链风险。
- 修复复杂任务与小改动共用同一套重型阶段、导致流程成本过高的问题。

## [0.1.2] — 2026-07-19

### Added
- 普通编码请求自动进入 Task/经验闭环，无需显式 `$cap`；首次进入 Git 项目时静默安装兼容现有 Hook 的 `prepare-commit-msg`，自动把 Task/Session 写入 Commit。

### Changed
- 项目 Hook 不再强制 Commit 格式、不覆盖原 Hook，也不默认生成 GitLab CI 文件。

## [0.1.1] — 2026-07-19

### Added
- cap-flow 在阶段 HANDOFF 后通过可选 `record_task_artifact` 上报 `.cap` Artifact 元数据；仅包含相对路径、哈希、Git ref、阶段、状态和摘要，工具不可用时静默降级。

## [0.1.0] — 2026-07-09

### Added
- **cap 研发流程技能族首个版本**:纯文件 + git 的结构化研发流程,不依赖任何运行时,Claude / Codex 都能跑。
  - **1 driver(`cap-flow`,含 intake 需求树)+ 7 流程 skill**:map / shape / plan / build / verify / review / release。driver 负责 Orient → Route → Handoff,并内联需求树的分叉决策;机械树操作(Seed/Generate/Ingest/Coverage/Lint/Move/Retire)落在 `references/intake.md` + `scripts/intake.py`。
  - **角色卡透镜**:server-dev / client-dev / big-data / qa(baseline)/ architect / design / ai-readiness / skill-maintainer,由 `references/role-routing.md` 按改动 glob 路由加载。
  - **verify 三 checks**:`cap-verify/checks/{logic,journey,model}.md`——logic 基线恒跑,journey/model 按 surface 挂载(journey 含 Web/OpenAPI/App)。
  - **release 按部署目标组织**:`cap-release/targets/{container,static,vps}.md` + 晋级门引擎(dev→staging→canary→full)。
  - **语言包**:python / typescript / go / rust / java-spring / kotlin / swift,记录各语言的 lint/test/build 具体命令。
  - **状态目录 `.cap/`**:PROFILE.md / STATE.md / spec.md / plan.md / requirements/ / verify/ / review/ / archive/ / EVOLUTION.md,单写者纪律。
  - **可移植适配**:`references/runtime-adapters/codex.md`——AskUserQuestion→text_mode、Task 并行→Task-or-sequential 降级。
  - **硬门禁**:`scripts/cap-guard`(pre-commit 并发/边界防串台)、`scripts/validate-skills`(结构 lint)。
- **经验闭环 `harvest-experience`(本项目核心)**:骑在 CLI 上的 `注入 → 编码 → 沉淀`。会话首尾各调一次 `enrich_context` / `record_experience`,连 `capital-agent` 中心知识库,带 operator 归因。接入见 `skills/harvest-experience/references/setup-mcp.md`。
- **护城河改锚**:`references/evolve-loop.md` 与 `references/distillation-loop.md` 的沉淀出口指向中心知识库(不指向任何外部代码仓自更新环);`cap-verify/checks/model.md` 提供 F1 proof-of-value 钩子(接入 KB 后模型预测准确率的可观测回归)。
