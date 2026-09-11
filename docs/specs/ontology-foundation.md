# Ontology 底座需求与验收契约

## 目标与边界

将研发方法中的稳定语义变成可校验、可解释、可迁移的本地契约；让多个机构/渠道的知识和真实 `.cap` 产物进入同一个消费协议而不会混用、覆盖、伪造授权或提升历史证据。此交付是本地语义内核，不是代码生成模型、网络鉴权服务、生产执行器或通用 OWL 推理器。模型读取结构化上下文继续执行现有 Skills；确定性内核不运行导入文档中的命令。

机构具有两种正交含义：tenant 是数据所有者/访问边界；provider 是支付渠道/外部服务业务维度。一个 tenant 可接多个 provider，不得把 provider 当成租户权限。

## 真值与模型

- 原型阶段硬编码样本、阶段与 completionConditions 全部移除。
- 每个语义条目有不可歧义的 ID、显式 namespace、scope、revision、validity、provenance 和状态。未知版本/字段失败关闭，不按标题合并、不最后写入覆盖。
- `concept` 解释名词；`claim` 表达按条件成立的知识；`constraint` 表达硬约束。知识不能携带执行 grant。公共知识必须显式 public，tenant 私有知识不能因层级或相似度对外可见。
- 源文档仅是文本来源。source hash 证明内容绑定，不证明内容正确或授权有效。只有调用方独立提供且经验证的 authority 输入才能参与权限/收口计算。
- 核心约束由随包内核固定：精确交付身份、未知即不放行、local 不升级 server、tenant 隔离、知识不授予权限。扩展不可削弱。

## 验收矩阵

| ID | 能力 | 正例 | 必须阻止的反例 |
|---|---|---|---|
| O01 | schema/identity | 严格 schema + namespaced ID，稳定序列化 hash | 缺字段、重复 ID、非有限值、未来版本、未知字段 |
| O02 | isolation | public + 当前 tenant/project/provider/environment 匹配 | 跨 tenant 同名知识泄漏；把 provider 误当 tenant |
| O03 | concepts | qualified term 精确匹配、私有扩展保留来源 | 同名异义自动归并；私有事实提升 public |
| O04 | conflicts | 一致值合并来源；显式、有边界授权的 supersedes | priority/时间/更具体自动获胜；矛盾硬约束被覆盖；环/跨键覆盖 |
| O05 | validity | 时间窗口和代码版本匹配 | 过期、未来、撤销、不同 commit 的经验当现行事实 |
| O06 | provenance | path/hash/sourceTask/sourceCommit 保留 | 从文件正文推断 trusted；路径逃逸；自动执行注入文本 |
| O07 | evidence | 独立 receipt 匹配 tenant/project/task/repo/branch/commit/environment，尚未过期 | 历史/其它任务 PASS、客户端自报 PASS、缺 receipt 放行 |
| O08 | permissions | exact scoped grant + capability + validity；deny 优先 | 文本/知识自行 grant；只因开发授权就生产发布 |
| O09 | workflow | 所有已有阶段与 L1–L4 路径；建议与可执行下一步分离 | 写死 implement；把 release/done 游标当完成证明；环境失败被测试 PASS 覆盖 |
| O10 | import | 显式选定目录、安全只读、结构化 claims/unknowns/hash | 遍历所有历史、软链接逃逸、超大输入、冲突字段择一、正文密钥外发 |
| O11 | evolution | 确定性受限 legacy 迁移，保留 unknown，输入不变 | 猜 tenant/commit/权限、降级绕过隔离、静默吞未知 schema |
| O12 | drift | canonical stage/check/Skill 路径校验 + 语义源片段锁 | Skill 规则改变但 ontology 静默保持旧语义 |
| O13 | consumer | 从真实 task 实例生成上下文，显式 unknown/blocked/claim | 示例驱动执行、未验证事实进入 allowedActions |
| O14 | portability | Node 18+、无新服务/依赖；路径含空格/CLI cwd 独立 | OS 特有 URL pathname、shell eval、外部仓写入 |
| O15 | evidence of usefulness | 多个真实支付任务 + 合成反例；可重放报告 | 只检查 fixture 字符串而宣称 Agent 编码能力已证明 |

## 冲突策略

过滤先于召回和诊断：不可见记录的 ID/值不进入用户上下文。适用但缺条件的条目标 unknown，不强行注入。相同 key 的不同值产生显式 conflict，默认不选任一值。只有独立 authority 中的 override 委托允许同一 scope/key 下的显式替代；约束不能被 claim 覆盖，公共核心约束不接受 override。所有结果排序稳定；输入顺序不得影响结果。

## 验证与交付

单元/对抗测试覆盖矩阵；本地真实 `.cap` dogfood 仅保留脱敏聚合报告入仓，原始产物和路径留 `docs/dogfood/`。结构 lint 集成 ontology 检查。独立 fresh-context 复核通过才交付。当前用户已授权实现整个需求，工作分支 `codex/ontology-foundation`；既有原型是同一会话产生、由本任务接管。业务项目只读，不上传机构数据、不运行支付操作。
