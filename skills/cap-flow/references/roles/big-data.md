---
role: big-data
triggers: ["*.sql", "**/pipelines/**", "**/dbt/**", "**/spark/**", "**/etl/**", "**/migrations/**", "models/**/*.sql", "**/airflow/**", "**/dags/**"]
---

<!-- STUB: v1 桩卡，已用 4 个源喂饱（data-engineer / database-optimizer / ai-data-remediation-engineer / data-migration），但仍是桩——pipelines 编排、数据倾斜、列存格式选型、lineage 工具链、大规模回填实操等深度待后续蒸馏回路做厚。蒸馏时已丢弃源里的 agent 人格（vibe/emoji/memory/3am 故事）、云厂商堆砌清单、运行时 preamble。 -->

# 角色卡：big-data（数据工程视角）

> 何时被加载：改动命中 `*.sql / pipelines/** / dbt/** / spark/** / etl/** / migrations/**` 等数据面。
> 核心信念（贯穿全卡）：**数据管道必须幂等、可观测、可追溯；AI 生成"修数据的逻辑"，绝不直接改数据；每一行都要被对账，零静默丢失。**

## 关注点

数据工作的风险不在"跑通一次"，而在"长期不腐烂、不静默损坏"。这个视角主要盯五件事：

1. **分层契约（Medallion）**——Bronze/Silver/Gold 各层职责是否清晰、是否越层消费。
   - Bronze = 原始、不可变、只追加（append-only），永不就地转换。
   - Silver = 清洗、去重、归一（conform），可跨域 join。
   - Gold = 业务就绪、聚合、带 SLA，按查询模式优化。
   - 红线：Gold 消费者**不得**直接读 Bronze/Silver。
2. **数据契约与 schema 漂移**——生产者/消费者之间是否有显式 schema 契约；schema 变化是**告警**还是**静默损坏**下游。
3. **幂等与增量**——重跑是否产生同一结果（不重复、不丢失）；用 CDC/增量代替全量扫描以控成本。
4. **数据质量与可追溯**——空值是否被刻意处理（不是隐式传播到 Gold）；Gold 是否带行级质量分；每行能否追回源头（lineage）。
5. **迁移/schema 变更安全**——可逆性、锁时长、回填策略、索引并发创建、多阶段部署兼容（旧码+新 schema 不崩）。

> 边界：这是**视角/知识卡**，不执行多步活动。具体"跑数据质量套件 / 跑覆盖率门控"属于 `cap-test` 的 logic 模式；"按 rubric 评数据质量分"属于 model 模式。

## 检查清单

### 分层 & 数据契约
- [ ] Bronze 是否只追加、零转换，并捕获元数据（`_ingested_at` / `_source_system` / `_source_file`）？
- [ ] Silver 是否按主键 + 事件时间窗口去重（而非盲目 distinct）？SCD Type 2 是否处理缓变维？
- [ ] Gold 是否按查询模式做分区裁剪 / Z-order / 预聚合？是否禁止越层读取？
- [ ] 是否存在**显式 schema 契约**（如 dbt `contract: enforced: true` + not_null/unique/relationships 测试）？
- [ ] schema 漂移是 `mergeSchema=true` **告警但不阻断** 还是会静默破坏下游？

### 幂等 / 增量 / 成本
- [ ] 管道是否幂等：重跑产生同一结果，绝不产生重复行？
- [ ] 是否用 merge/upsert（按 PK 匹配）而非"清空重插"导致丢历史？
- [ ] 是否用 CDC/增量替代全表扫描？全量 vs 增量的成本差是否量化过？
- [ ] 流式：是否声明语义（exactly-once / at-least-once）与迟到数据处理？checkpoint 是否配置？

### 数据质量 / 空值 / lineage
- [ ] 空值是否被**刻意**处理（impute / flag / reject 按字段规则），而非隐式传播到 Gold？
- [ ] 关键 Gold 字段是否带行级数据质量分 / 校验（如 Great Expectations / dbt tests）？
- [ ] 是否有审计列（`created_at` / `updated_at` / `deleted_at` / `source_system`）与软删除？
- [ ] lineage 是否可追：任一 Gold 行能否追回 Bronze 源？

### 查询 / 索引 / 性能（DB 面）
- [ ] **每个外键是否有索引**（join 必需）？
- [ ] 是否跑过 `EXPLAIN ANALYZE`：看到的是 Index Scan（好）还是 Seq Scan（坏）？actual vs planned 行数偏差大吗？
- [ ] 是否避免了 `SELECT *`（只取需要的列）？
- [ ] 应用层是否存在 **N+1**（循环里逐行查）？能否用 JOIN / 批量加载 / 聚合替代？
- [ ] 复合查询是否有合适的复合索引 / 部分索引（partial index）？

### 迁移 / schema 变更安全（改 migrations 时必查）
- [ ] **可逆性**：有对应的 down/rollback 吗？rollback 是真撤销还是 no-op？回滚会不会打断当前应用码？
- [ ] **数据丢失风险**：删列前有弃用期吗？改类型会截断吗（varchar(255)→varchar(50)）？重命名是否更新了所有引用（ORM/裸 SQL/视图）？
- [ ] **NOT NULL 加到含 NULL 的列**——是否先回填再加约束？新 NOT NULL 列是否带 DEFAULT？
- [ ] **锁时长**：大表 `ALTER TABLE` / 建索引是否用 `CONCURRENTLY`？>100K 行的表尤其注意。多条 ALTER 能否合并成一次锁？
- [ ] **回填策略**：是否分批回填（而非一次 update 全表锁死）？有回填脚本吗？
- [ ] **多阶段安全**：是否需要"先部署码再迁移"的顺序？滚动部署期"旧码+新 schema"会不会崩？是否有 feature flag 兜底？

### AI 修数据（命中数据清洗/补全的 AI 逻辑时）
- [ ] **AI 生成逻辑，不直接改数据**：SLM 输出的是可审计的 transformation（lambda/SQL 表达式），由系统执行，可回滚？
- [ ] **执行前校验**：生成的 lambda 是否过安全门（必须以 `lambda` 开头、禁含 `import/exec/eval/os/subprocess`）？
- [ ] **PII 不出域**：含 PII 的清洗是否本地（Ollama/本地 embedding），网络出口为零？
- [ ] **混合指纹防误并**：语义相似是否叠加 PK 的 SHA-256 哈希，PK 不同强制分簇？
- [ ] **对账恒等式**：`源行数 == 成功行数 + 隔离行数`，任何缺口即 Sev-1？低置信（<0.75）是否走人工隔离而非自动修？
- [ ] **审计**：每条 AI 改动是否有完整回执（行 ID / 旧值 / 新值 / 所用 lambda / 置信度 / 模型版本 / 时间戳）？

## 好的样子

- 一张 Bronze→Silver→Gold 清晰分层、契约显式、漂移告警的管道；重跑十次结果一致。
- 迁移可逆、不锁表、分批回填、与应用码部署顺序明确——半夜不会被叫醒。
- 每个外键带索引，关键查询走 Index Scan，没有 N+1；慢查询有 `pg_stat_statements` 监控。
- 数据质量有门：关键 Gold 检查通过率高，异常 5 分钟内告警，**零静默失败**。
- 任一 Gold 行可追回源头；Gold 表有 owner / SLA / 文档。
- 涉及 AI 修复时：N 个异常压缩成十几个模式簇，AI 出逻辑、系统执行、全程可审计、零行丢失。

## 常见翻车

| 翻车 | 后果 | 对策 |
|---|---|---|
| 就地转换 Bronze / 越层让 Gold 读 Bronze | 破坏可重放性、契约失效 | 严守 append-only Bronze + 分层消费 |
| schema 漂移被静默吞掉 | 下游模型悄悄损坏 | 显式契约 + mergeSchema 告警 |
| 非幂等重跑 → 重复行 | 指标翻倍、对账崩 | 按 PK + 事件时间 merge/upsert |
| 空值隐式传播到 Gold | 业务决策基于脏数据 | 字段级空值规则（impute/flag/reject）|
| 无界全表扫描 | 成本爆炸 | CDC/增量 + 分区裁剪 |
| 外键无索引 / `SELECT *` / N+1 | 查询慢、3am 告警 | 索引外键 + 只取列 + JOIN/批量 |
| 大表非 CONCURRENTLY 建索引 / ALTER | 生产锁表 | `CONCURRENTLY` + 合并锁 + 避峰 |
| NOT NULL 直接加到含 NULL 列 / 无 down 迁移 | 迁移失败、不可回滚 | 先回填再约束 + 写 down 迁移 |
| 一次 update 全表回填 | 长锁、阻塞 | 分批回填 |
| 让 AI 直接改生产数据 / PII 出域 | 静默损坏、合规事故 | AI 出逻辑不出数据 + 本地 SLM + lambda 安全门 + 对账恒等式 |

## 介入哪些阶段

| 阶段 | big-data 视角做什么 |
|---|---|
| **onboard** | 识别数据面（pipelines/dbt/migrations/SQL）写入 PROFILE surface-map；标注分层结构、关键数据契约与已知风险。 |
| **shape** | 数据工作的"怎么算 done"前置：数据契约、SLA（新鲜度/完整性）、数据质量指标与阈值；若含 AI 修数据，定 rubric 与对账规则。 |
| **plan** | 拆任务时把"幂等性 / 回填 / 迁移可逆 / 索引"列为可验收标准；迁移类任务标注部署顺序依赖。 |
| **build** | TDD：先写数据质量测试 / schema 契约测试（RED）再实现管道（GREEN）；迁移先写 down。 |
| **verify** | logic 模式跑数据质量套件 + schema 契约 + 对账恒等式；数据质量类改动追加 model（按 rubric 评质量分）。 |
| **review** | 按"检查清单"逐项审；迁移走 data-migration 安全子项；输出到 `.cap/review/big-data.md`。 |

---

## verify-check playbook：数据契约 + 迁移安全门（big-data 专属验证片段）

> 这是 big-data 角色在 `cap-test` 中贡献的可执行验证片段，被 logic 模式编排调用。
> 可移植：纯 Read/Bash/Grep，无 Task/AskUserQuestion 硬依赖；无并行能力时串行执行。

### 何时触发
- `git diff` 命中 `*.sql / **/migrations/** / **/dbt/** / pipelines/**` 任一。
- 迁移子门（migration safety）：仅当命中 `**/migrations/**` 或检测到 `ALTER TABLE / CREATE INDEX / DROP COLUMN` 时启用。

### 步骤流程
1. **采集改动**：`git diff --name-only` 取数据面改动文件清单，按 surface-map 归类（pipeline / model / migration）。
2. **schema 契约校验**：若用 dbt，跑 `dbt parse` + `dbt test --select <changed models>`；否则 Grep 契约定义（not_null/unique/relationships）与改动列比对，缺失即记 finding。
3. **幂等检查**：审管道写入模式——是 `merge/upsert (按 PK)` 还是 `overwrite/append` 可能产生重复？无 PK 去重逻辑记 HIGH。
4. **迁移安全扫描**（迁移子门，逐条比对 data-migration 清单）：
   - 可逆性：有无 down/rollback；rollback 是否 no-op。
   - 数据丢失：DROP COLUMN / 类型收窄 / 重命名未更新引用 / NOT NULL 加到含 NULL 列。
   - 锁时长：大表 ALTER/建索引是否 `CONCURRENTLY`。
   - 回填：新 NOT NULL 无 DEFAULT / 无分批回填脚本。
   - 多阶段：是否假设部署边界（旧码+新 schema 崩）。
5. **AI 修数据子门**（命中 AI 清洗逻辑时）：校验"逻辑非数据"、lambda 安全门、PII 本地、对账恒等式存在。
6. **对账**（若有数据批处理）：确认存在 `源行数 == 成功 + 隔离` 检查；缺失记 CRITICAL。
7. 汇总 findings → 写 `.cap/verify/logic-report.md` 的 big-data 片段。

### 产物
- `.cap/verify/logic-report.md` 内 big-data 段：每条 finding 一行（见证据 schema）。
- 迁移类附一行明确判定：`migration-safety: PASS | FAIL`（FAIL 阻断 review 门）。

### 门控
- **CRITICAL**（阻断，必须修后才进 review）：不可逆迁移、确定的数据丢失风险、对账缺口、AI 直改生产数据/PII 出域、越层 Gold 读 Bronze。
- **HIGH**（应修）：非幂等写入、外键缺索引、大表非 CONCURRENTLY、NOT NULL 含 NULL 未回填、schema 漂移静默。
- **INFO**：可优化的索引/分区、`SELECT *`、文档/SLA 缺失。
- 退出门：CRITICAL == 0 且 migration-safety != FAIL，方可进入 `cap-review`。

### 证据 schema（每条 finding 一行 JSON，沿用 data-migration 规范，扩展 big-data 类目）
```json
{"severity":"CRITICAL|HIGH|INFO","confidence":1-10,"path":"file","line":N,"category":"data-contract|idempotency|migration-safety|data-loss|lock-duration|backfill|ai-remediation|query-perf|lineage","summary":"...","fix":"...","evidence":"EXPLAIN 输出 / diff 片段 / dbt test 结果","fingerprint":"path:line:category","role":"big-data"}
```
- `evidence` 优先放可验证证据（`EXPLAIN ANALYZE` 计划、`dbt test` 结果、对账数字、diff 片段），而非推断。
- 无 finding 时输出 `NO FINDINGS` 并仅此一行。
