---
title: 部署方法论（环境晋级 / 发布策略 / 迁移安全 / 回滚 / 可观测）
scope: methodology                # 通用、跨目标类型、跨语言——不含项目特定值
applies-to: cap-release            # 被 cap-release 加载；目标类型适配器在 targets/ 引用本文骨架
updated: 2026-06-15
---

# 部署方法论 · deployment-patterns

> cap-release 的**通用方法论层**。回答"部署该怎么做"，不回答"这个项目怎么部署"。
> 三层分工：① **本文=通用方法论**（环境晋级 / 发布策略 / 迁移 / 回滚 / smoke / 可观测 / 密钥）；② **适配器**（`adapters/<目标类型>.md`，薄，按目标类型给命令骨架 + 回滚骨架）；③ **项目特定配置**（运行时从目标工程 `PROFILE` / `CLAUDE.md` 抽：项目名、集群、服务器、env 名、镜像仓库……）。
> 铁律：本文出现的所有命令都**真实可跑**且已验形（`kubectl rollout undo`、`docker ... HEALTHCHECK`、`curl -fsS` 等），但**不含任何项目特定值**——凡项目特定一律写 `<占位>` 由运行时填。密钥**只在部署环境 / secret-manager**，本文示例一律 env 引用或占位，**绝不出现真值、绝不入仓**。

本文是**数据 playbook**，不是 skill。引擎=Claude + 基础工具 + 目标平台 CLI（kubectl / docker / 平台特定 CLI，由适配器声明）。

---

## 1. 环境晋级模型

ship 是一条**单向晋级流水线**，四段，每段同构：`deploy → smoke/health → 门`。门过=晋级到下一段；门不过=**立即回滚到本段的 last-good**，不带病前进。

```
 dev ──门──▶ staging ──门──▶ canary ──门──▶ full
  ▲           ▲              ▲              ▲
 打包+smoke   集成/e2e       小流量指标      canary过
             +配置/迁移      +观察期        +确认
  └ 门不过 → 回滚到本段 last-good，停，报因 ┘
```

| 段 | 目的 | 晋级门（全部满足才晋级） | 爆炸半径 |
|---|---|---|---|
| **dev** | 把构建产物在研发环境跑起来，证明"能起、能过最小验证" | ① 构建/打包成功（镜像可复现，版本固定，无 `:latest`）② 关键路径 smoke 通过 ③ health endpoint 返回 healthy | 仅研发，几乎为零 |
| **staging** | 类生产环境验集成、配置、迁移——上线前最后一道"真环境"演练 | ① 集成 / e2e 通过（联动 `checks/journey`）② per-env 配置加载正确、启动期校验通过 ③ DB 迁移在类生产规模数据上演练过且**可回滚** | 内部，影响测试 |
| **canary** | 把新版本暴露给**一小撮真实流量**，用真实指标做风险闸 | ① canary 实例 smoke/health 绿 ② 观察期内**三信号**（错误率/延迟/饱和度）不劣于基线 ③ 无新告警触发 | 受控（如 1%~5% 真实用户） |
| **full** | 全量放开，完成晋级 | ① canary 段已 PASS ② 人工/策略**确认**放量（text_mode 编号确认，不依赖交互组件）③ 全量后再跑一次 smoke + 观察 | 全部用户——最大，故门最严 |

> **单向 + 单写者**：晋级状态写进 `STATE.md`（单写者）；每段产物（smoke 报告 / 指标快照 / 迁移日志）各写各的文件，不互相覆盖。
> **可移植**：确认点用纯文本编号（text_mode），并行探测/部署用 Task-or-sequential 降级，确保 Codex 下也能跑。

---

## 2. 发布策略（选型 + 爆炸半径）

晋级模型决定"分几段"，发布策略决定"每段怎么把流量从旧版切到新版"。canary 段天然用金丝雀；其余段按下表选。

| 策略 | 机制 | 何时用 | 爆炸半径 | 回滚速度 |
|---|---|---|---|---|
| **滚动（rolling，默认）** | 实例分批替换，新旧版本短暂共存 | 标准部署、**向后兼容**的改动 | 中（共存期两版本同时在线，要求兼容） | 中（需反向滚动） |
| **蓝绿（blue-green）** | 两套同构环境，流量**原子切换** | 关键服务、零容忍、切换要干净 | 低（切换瞬时；问题切回旧环境） | 极快（流量切回 blue） |
| **金丝雀（canary）** | 先给小比例流量，看指标再逐步放大 | 高流量 / 高风险改动；即 ship 的 canary 段 | 受控（先只伤一小撮真实用户） | 快（撤掉 canary 流量即可） |
| **特性开关灰度（feature flag）** | 代码已上线，用开关按人群/比例放量 | 想"部署"与"发布"解耦；想免重新部署即可关 | 可调（开关粒度即半径） | 极快（关开关，无需重部署） |

要点：
- **滚动**要求改动向后兼容（共存期两版本同时收流量），否则用蓝绿。
- **蓝绿**回滚最干净但需 2x 资源（部署期两套环境并存）。
- **金丝雀**需流量切分 + 监控基建；正是 ship 的 canary 段用的策略。
- **特性开关**把"部署"与"发布"解耦：新代码可先静默上线，再用开关控制对谁可见，回滚=关开关而非回退部署，最快且不动二进制。

---

## 3. 数据库迁移安全

迁移是 ship 里最容易"无法回滚"的环节。铁律：**迁移必须向后兼容、可回滚，且与多版本共存的发布策略安全共处**。迁移设计联动 `roles/architect`。

### Expand-Contract（先扩后缩，强制范式）

任何破坏性 schema 变更拆成**两次或多次独立部署**，中间隔着应用代码切换：

```
Expand（扩）：只做加法——新列/新表，可空或带默认；旧读写路径不受影响
   ▼ 部署应用：双写（同时写新旧）/ 优先读新、回退读旧
   ▼ 回填（backfill）历史数据到新结构
   ▼ 观察：新旧一致、应用稳定
Contract（缩）：确认无任何代码依赖旧结构后，才删旧列/旧表
```

- **Expand 阶段对旧版本完全向后兼容**——这正是滚动/金丝雀期新旧实例共存的安全前提。
- **Contract 单独成一次部署**，且只在"旧结构确认无人引用"后做，绝不与 expand 同批上线。

### Canary 期迁移注意

- canary 段新旧实例同时收流量：迁移必须保证**旧实例在 schema 变更后仍能正常读写**（即只允许做到 expand，contract 留到 full 之后）。
- 破坏性变更（删列、改类型、加非空无默认约束）**禁止在 canary 段进行**——它会让仍在跑的旧实例崩。
- 迁移与回滚成对设计：每个 forward migration 必须有对应的、**经演练**的 down migration，或证明该步骤是纯加法因而天然可回退。

### 迁移可回滚检查

- [ ] 本次迁移是**纯加法**（expand），未删除/重命名/收紧任何在用结构。
- [ ] 存在对应 down 迁移，或纯加法因而 down=删除新增物。
- [ ] 已在**类生产规模数据**上演练 forward + down 各一次（staging 段完成）。
- [ ] 应用代码对"迁移已跑 / 未跑"两种状态都安全（双写、读回退）。
- [ ] contract（破坏性收尾）已拆为独立后续部署，不在本次放量批次内。

---

## 4. 回滚

**每个环境都留上一个已知良好版本（last-good）。** 门失败=立即回滚到 last-good，不调试线上、不带病前进。回滚要**快**、要**可演练**。

原则：
- **last-good 永远可用**：每段晋级前记录当前 last-good 指针（镜像 tag / 部署 revision / commit sha）到 `STATE.md`；新版本验证通过后才更新 last-good。
- **门失败即回滚**：smoke/health 失败或观察期三信号劣化，触发回滚，**不就地修线上**。
- **回滚 = 一条命令级操作**：依赖平台原生回滚原语（见适配器），不靠手工重建。
- **回滚要演练**：上线前在 staging 演练过回滚路径（属 production-readiness 检查项），确保真要回滚时不是第一次跑。
- **迁移联动**：回滚应用前确认 schema 仍兼容旧版本（这就是为何迁移只到 expand、破坏性收尾后置——见 §3）。

回滚命令骨架（真实可跑原语；项目特定值=占位，由运行时/适配器填）：

```bash
# Kubernetes：回退到上一个 rollout 修订
kubectl rollout undo deployment/<deployment-name> -n <namespace>
# 或回退到指定历史修订
kubectl rollout undo deployment/<deployment-name> -n <namespace> --to-revision=<rev>
kubectl rollout status  deployment/<deployment-name> -n <namespace>   # 等回滚完成

# 蓝绿：把流量切回上一套环境（机制由平台/适配器实现，骨架=改 selector / 切 LB 指向 last-good）

# 金丝雀：撤掉 canary 流量权重，回到 100% last-good（权重控制见适配器）

# 特性开关：关掉本次发布的开关，瞬时停止暴露（无需重新部署）
```

> 平台专属回滚命令（如 PaaS 的 `rollback` / 重部署上一 commit）放各 `adapters/<目标类型>.md`，本文只给跨平台通用原语与纪律。

回滚检查清单：

- [ ] 上一个镜像/产物**已 tag 且可拉取**（last-good 指针在 STATE.md 有记录）。
- [ ] DB 迁移向后兼容（无破坏性变更进了本批），回滚应用不会撞到 schema。
- [ ] 特性开关可在不重新部署的前提下关闭新功能。
- [ ] 错误率/延迟突增的告警已配置，能**自动**提示该回滚。
- [ ] 回滚路径已在 staging 演练通过。

---

## 5. smoke / health

发布后的**最小验证**：证明"新版本在这个环境真的能服务关键路径"。任一失败 → 触发回滚（§4）。

**两件不同的事，都要有：**

| | health（存活/就绪） | smoke（关键路径冒烟） |
|---|---|---|
| 问的问题 | 进程起来了、依赖连得上吗 | 用户最核心的那条路真的能走通吗 |
| 形态 | health endpoint，返回结构化状态 | 一小组只读/幂等的关键用例 |
| 频率 | 持续（探针周期性打） | 每次部署后跑一次 |

**health endpoint 约定**（应用侧提供，方法论要求其"返回有意义的状态"）：
- 浅层 `/health`：进程存活即 200。
- 深层 `/health/detailed`：聚合依赖（DB / 缓存 / 下游）逐项状态 + 版本 + uptime；任一关键依赖不健康返回 503。

部署后探测骨架（真实可跑；URL/路径=占位）：

```bash
# health：失败即非零退出（-f），可直接作为门的判据
curl -fsS "https://<host>/health" || { echo "HEALTH FAIL"; exit 1; }

# Kubernetes 探针（声明式；端口/路径=占位）——存活/就绪/启动三类
#   livenessProbe   httpGet /health   periodSeconds:30 failureThreshold:3
#   readinessProbe  httpGet /health   periodSeconds:10 failureThreshold:2   # 不就绪即摘流量
#   startupProbe    httpGet /health   periodSeconds:5  failureThreshold:30  # 给慢启动留窗口
```

**smoke**：对关键路径跑最小用例集（只读/幂等优先，绝不在线上造脏数据）。复用 `checks/journey` 的"只读铁律"——写/删用例不在 smoke 里跑。smoke 失败 → 回滚 + STATE 记 `blocked`。

---

## 6. 可观测（canary 晋级的判据来源）

canary 段"晋不晋级"靠数据，不靠感觉。盯**三信号**，并配告警：

| 信号 | 含义 | canary 看什么 |
|---|---|---|
| **错误率（errors）** | 5xx / 异常 / 失败请求占比 | canary 实例错误率**不劣于**基线（同期 last-good） |
| **延迟（latency）** | p50 / p95 / p99 响应时间 | 尾延迟（p95/p99）无显著抬升 |
| **饱和度（saturation）** | CPU / 内存 / 队列 / 连接池占用 | 无逼近上限、无 OOM / 排队堆积 |

要点：
- **对比基线**：canary 指标永远和同期 last-good（旧版本仍在收的那部分流量）对比，而非看绝对值。
- **观察期**：放量后留足观察窗口再判门，别"刚切完就过门"——瞬时无错≠稳定。
- **告警驱动回滚**：错误率超阈值的告警应能直接触发/提示回滚（§4 检查项）。
- 指标快照写进本段产物（如 `.cap/release/canary-metrics-<ts>.md`），作为门决策证据。

---

## 7. 密钥 / 配置（per-env，绝不入仓）

**铁律：密钥只存在于部署环境 / secret-manager；源码、配置文件、镜像、仓库里绝不出现真值。** 本文所有示例一律 env 引用或 `<占位>`。

- **per-env**：每个环境（dev/staging/canary/full）有独立配置与独立密钥；同名变量不同环境取不同值，由运行时从目标工程 PROFILE 决定来源。
- **配置走环境变量**（12-factor）：连接串、开关、级别等用 env 注入，不写死在代码。
- **密钥走 secret-manager / 部署环境注入**：CI 用 secret store（如平台 secrets），运行时由 secret-manager 注入容器，**不经过仓库、不打进镜像**。
- **启动期校验、快速失败**：进程启动时校验必需配置/密钥齐全且合法，缺失即 fail-fast，不带半套配置上线。

配置/密钥引用骨架（**全部占位 / env 引用，无真值**）：

```bash
# 环境变量——非敏感配置（值由 per-env PROFILE 提供，此处为形）
APP_ENV=<env>                       # dev | staging | canary | full
LOG_LEVEL=<level>
SERVICE_PORT=<port>

# 密钥——只引用，绝不写真值；由 secret-manager / 部署环境注入
DATABASE_URL=${DATABASE_URL}        # 注入，不入仓
API_TOKEN=${API_TOKEN}             # 注入，不入仓

# CI 侧：从 secret store 读取，不在流水线 YAML 写明文
#   token: ${{ secrets.<SECRET_NAME> }}   # 占位；真值存平台 secret store
```

启动期校验（方法论要求，示意——非项目代码）：
```
读取所需 env/secret → 校验存在且合法（类型/范围/URL 格式）→ 缺失或非法立即退出并报清晰错误
```

### 7.1 绝不存储 **且** 绝不传输

"不入仓"只是一半。密钥还要**绝不传输 / 绝不外泄**：不回显进对话、不进日志、不 `echo`/`print`、
不拼进 URL/query、不发任何外部服务、不截进会被保存或转发的图。命令里引用密钥一律走 env（`$TOKEN`），
不在命令行明文展开。判据：一个密钥的真值，除"注入运行时"外**不应在任何可留痕处出现一次**。

### 7.2 摄入侧：坐标与密钥分离（从台账 / 控制台 / 文档读配置时）

- 资源信息常把**坐标**（host/port/库名/集群名/namespace/registry/endpoint）与**密钥**混在一处。
  导入时**只取坐标**写进配置，密钥块就地跳过、**不带出来源**（不整段复制、不全量倾倒进上下文）。
- **缺授权 ≠ 拒绝用户**：读取所需坐标时遇到登录墙 / 权限墙，不要直接放弃——换一条**有授权的通道**
  拿坐标（用户已登录的会话 / 导出只读副本 / 最小权限只读凭据），且仍只取坐标、机密就地过滤不外带。

### 7.3 创建 / 校验 secret 的安全手法（示例：k8s，占位）

```bash
# 由用户本人执行；值经文件输入——不进 shell history、不经任何第三方
kubectl create secret generic <name> \
  --from-file=<key>=<本地临时文件> -n <ns>           # 值在文件里，命令行不出现明文
shred -u <本地临时文件> 2>/dev/null || rm -P <本地临时文件>    # 用完即焚

# 校验只看 key 名 / 条数，绝不回显值
kubectl get secret <name> -n <ns>                    # 看 DATA 条数
kubectl describe secret <name> -n <ns>               # 值显示为字节数
#   ✗ 不要 -o yaml / -o jsonpath：会回显 base64 明文（= 一次传输 + 留痕）
```
> 集群 kubeconfig（含 `client-key-data` 私钥）同理：写进本机 `~/.kube/config*` 文件，
> 之后只用 **context 名** 操作，**绝不 `cat` / 绝不贴出私钥**。

### 7.4 泄露响应

密钥一旦不慎进入仓库 / 对话 / 日志 / 截图，**视为已泄露**——立即**轮换该凭证**，不能只删记录
（删除挡不住已被读取/缓存）。轮换后用新值重新走注入流程。

### 7.5 可切换的多环境坐标清单（一份清单，切换 = 改一个字段）

把"连哪套环境"做成一份**坐标清单**（每个 env 一条：集群 context / namespace / 数据库 host·port·库名 /
registry / 域名），目标工程只引用 env 名：

- **坐标与密钥分离**：清单里只存坐标 + 各密钥对应的 **Secret 名**（如 `mysql-credentials`），
  密钥真值绝不入清单（§7.1）；运行时按 Secret 名引用注入。
- **切环境 = 改一个字段**（dev↔staging↔canary↔full 只换 env 选择），其余命令骨架与清单结构不变——
  缩小误操作面、天然可审计（diff 一眼看出切了哪套）。
- 清单是坐标的**事实来源**，可由运维从台账整理维护；导入时只取坐标、跳过密钥（§7.2）。

---

## 8. ship 门控速查

发布前先过 **preflight 就绪门**，再进环境晋级（dev→staging→canary→full）：

| 段 | PASS（晋级） | FAIL（回滚 + STATE=blocked，报因） |
|---|---|---|
| preflight | 工具就绪（打包 / 编排 CLI 齐）+ 登录态就绪（registry / 集群已认证）+ 目标 env 坐标解析无缺 + **registry 与集群同地域** | 缺工具 / 缺登录 / 缺坐标 → 停，先补齐；**registry 与集群不同地域 → 先告知用户并选**（同域仓库 / 公网 endpoint / 跨域复制），否则后面 `ImagePullBackOff` 卡住无端 |
| dev | 打包成功 + smoke 绿 + health 绿 + **产出可直达地址（LB IP / 域名）并交付用户** | 任一不过 → 回滚 dev last-good |
| staging | 集成/e2e 绿 + 配置加载/启动校验过 + 迁移演练（含 down）过 | 任一不过 → 回滚 + 修迁移/配置再来 |
| canary | smoke/health 绿 + 观察期三信号不劣于基线 + 无新告警 | 信号劣化/告警触发 → 撤 canary 流量回 last-good |
| full | canary 已 PASS + 确认放量（text_mode）+ 全量后 smoke/观察通过 | 全量后劣化 → 回滚到 last-good（含必要时迁移兼容确认） |

> 每段门结果、last-good 指针、产物路径、deferred/blocked 项写入 `STATE.md`（单写者）。降级（Codex/无并行）：确认点用纯文本编号；并行部署/探测用 Task-or-sequential。
>
> **交付即可达**：部署成功的定义不是"Pod Running"，而是"用户能直接访问"。每段部署收尾必须产出一个**可直达地址**——有域名给域名，否则给 **LB IP**（默认内网/intranet，除非明确要公网），并附一条 verify（`curl -fsS http://<addr>/<health-path>`）。只停在 `ClusterIP` = 没交付（详见 `targets/container.md` §2.5）。
