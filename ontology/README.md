# Ontology 底座

这是现有 Skills 的可执行语义层：让 Agent 明确“谁的知识、在什么条件下适用、依据是什么、是否矛盾、当前能不能推进”。它提供结构化数据和决策，不生成代码、不执行文档中的命令、不替代现有 Server Gate。

## 四类输入必须分开

| 输入 | 来源 | 信任语义 |
|---|---|---|
| instance | 真实 `.cap` 安全导入，或受验证的本地结构化实例 | 声明/引用，不能证明完成 |
| record catalog | Agent 对需求、经验等原文逐条拆解出的 concept/claim/constraint | 默认 draft；永远不是权限 |
| query | 可信调用方绑定的当前 tenant、project、provider/product/contractVersion、environment、task 和 Git 身份 | 不能从正文猜测或覆盖 |
| authority | 独立可信适配器提供的 admissions/publications、委托、grant 和 receipt | 当前本地库不实现登录、签名校验或远程身份服务 |

**authority 是调用方的信任边界。** 测试中的构造 authority 只是夹具；不要将编码 Agent 或 `.cap` 文本生成的 JSON 当成独立权限/证据。CLI 不会从项目目录自动发现或信任 authority。接入 Server 前，必须在适配器验证操作者身份、授权资源与 receipt 来源；此内核只负责结构与语义校验。没有 authority 时默认无授权、无独立证据、无知识准入。

## 身份与知识隔离

- tenant 是数据所有者；provider 是业务机构/渠道。两个概念正交。
- scope 固定六维：tenant/project/provider/product/contractVersion/environment。只在公开记录中 tenant 可为 null；明确 public namespace 且内容 hash 在 publications 中才会被消费。
- 私有 ID 使用 `tenant:<tenant>/<id>`；公开 ID 使用 `public/<id>`。不同机构同名 term 不自动同义。
- 私有知识必须 state=validated 且内容 hash 在当前 tenant 的 admissions 中。修改一个字就需要重新准入。state=draft/revoked、不在时间窗口、协议/代码版本不匹配均不注入。
- null 表示条目在该维度无条件限制；query 缺少条目要求的条件意味着 unknown，不能视作匹配。provider 下的 product/contractVersion 不允许悬空。
- 来自不可见 tenant/provider 的值和冲突详情不返回；信息量较大的检索应在数据库端先过滤，库内过滤为第二道防线。

## 冲突和覆盖

同 key 同 kind 同 value 合并来源；不同 value 或 kind 保留冲突。没有优先级数字、更新时间优先或“更具体就胜出”。替代必须满足同一 scope/key/kind、新 revision 更高、显式 supersedes、当前 authority 有匹配且有效的委托。不存在目标、循环替代、越界替代都阻断该键。constraint 和公共定义不能走这条覆盖路径。

核心边界由 `runtime/ontology/engine.mjs` 强制实施，目录中的 policies 是这些实现的索引，不是允许模型任意修改的授权策略。知识冲突或适用条件未知时生成可解释 blocker 并清空 allowedActions。单条 constraint 也不能仅因没有冲突而放行：每个已准入的约束来源必须有当前完整身份下的独立 constraint receipt，sourceHash 精确匹配该约束的内容 hash；没有符合性证据时返回 unmetConstraints。内核不执行自然语言约束，独立适配器负责检查业务条件并出具证据。

## 阶段与证据

`states.json` 映射现有阶段及 L1–L4 的允许路径，没有新增 Skill 或阶段。nextStage 是候选下一步，只有 canAdvance=true 时 allowedActions 才有动作。done 游标不等于 completed。

receipt 必须匹配 tenant/project/provider/product/contractVersion/environment/task/repo/branch/commit，时间有效、PASS、authority 与 local/server 模式一致。verification/review/constraint 的 issuer 必须与执行 Agent 不同。多个有效 receipt 只要仍存在相关失败就保留阻断，应由可信上游解决冲突，而非让模型任选 PASS。本地 receipt 永不升级为 Server Gate。

grant 限定 subject/action/scope/时间，deny 优先。发布使用 deploy 权限且需要 environment/delivery 证据，开发推进权限不能用于发布。unknown、历史失败声明和缺证据均失败关闭。这里是保守裁决：若 Markdown 含多个历史结果，需人工核实并由可信适配器建立当前实例，不能把报告内的某次 PASS 抽出来放行。

## 从文字到知识的拆解

1. 从显式选定的项目 `.cap` 导入 task/artifacts/claims/unknowns。不会扫描 `.cap/history`；历史版本须由调用方选定并只读快照。
2. Agent 阅读当前被允许的源文档，将每个业务决策拆成带条件的原子条目：concept 定义对象含义，claim 表达可检验命题，constraint 表达不能破坏的不变量。同 key 在不同 scope 可有不同值。
3. 按 `schemas/record.json` 生成 draft。source 必须指向导入的 artifact 相对路径和 hash，保留 source task/commit，不能猜缺失的版本或扩大 scope。
4. `bind-drafts` 检查来源绑定、作用域和敏感文本。只输出需要独立审阅的 draft，不自动晋级。
5. 独立审阅者确认语义、反例和证据后，更新记录为 validated，并由可信宿主登记其新 hash 到 admissions。跨机构共享是新的脱敏审阅/发布，不是把 tenant 字段清空。
6. context 先过滤再裁决，输出适用知识、未决冲突、unknowns、来源和允许动作。

JSON Schema 是交换契约；运行时验证器只支持此仓当前 Schema 使用的关键词，并会拒绝未知关键词，不宣称实现全部 JSON Schema/OWL。值采用有界原子 scalar；复杂规则通过多个明确条件/命题拆分，不执行任意表达式。

## 本地命令

Node 18+，不需要新服务或依赖；从任意 cwd 都可使用脚本绝对路径。输出仅 stdout，由调用者选择保存到当前项目的 `.cap/ontology/`；业务原始产物和身份配置不要提交进公共 Skills 仓库。

```sh
node scripts/ontology-context.mjs import /path/to/project binding.json
node scripts/ontology-context.mjs bind-drafts instance.json drafts.json
node scripts/ontology-context.mjs context instance.json query.json catalog.json
node scripts/ontology-context.mjs context instance.json query.json catalog.json authority.json
node scripts/ontology-context.mjs migrate legacy-state.json binding.json
node scripts/validate-ontology.mjs
node --test scripts/test-ontology*.mjs
```

`examples/ontology/` 有不含业务信息的绑定/实例/查询/catalog。默认示例被阻断，这是缺独立证据和授权时的预期结果。

## 演进与兼容

Schema v1 显式拒绝未知字段、未来版本、重复 JSON key 和不完整身份。仅支持 legacy v0/无版本状态的白名单迁移，map/shape/build/verify 可转换为当前名称，但保留 legacy unknown 标记；不猜 commit、tenant、环境或权限。v1 迁移返回副本，不修改输入；未来升级必须增加有版本的迁移函数及正反例，不能把旧版本号擦掉重试。

`source-lock.json` 锁定对应 Skills 语义来源全文 hash；既有规则变化会导致结构 lint 失败。维护者必须复核定义和语义测试，再显式运行 `validate-ontology.mjs --refresh-source-lock`。它仅重建来源锁，不自动“修复”语义漂移。核心 Schema/策略若有破坏变更必须升版本，旧快照保留旧版本供回放，不就地覆盖。

类型化图由 `runtime/ontology/graph.mjs` 校验：节点类型、边类型、来源、唯一身份和同 scope 边界都必须成立。context 从实际 Task/Artifact/Commit 物化关系；没有当前 Commit 时不会伪造 Commit 节点。业务 Requirement/Feature/CodeSurface 可由模型基于原文进一步拆解为节点，不能把源码图谱推测当成已验证边。

匿名真实验证报告见 `docs/specs/ontology-validation.md`。完整需求与 O01–O15 验收矩阵见 `docs/specs/ontology-foundation.md`。多支付渠道的真实只读验证详细记录保留本机 `docs/dogfood/`，公开报告只包含匿名的结构统计与裁决结果。通过这些测试说明隔离与裁决成立，不等于证明 Agent 已能自主编程或已接通生产 CI/CD。
