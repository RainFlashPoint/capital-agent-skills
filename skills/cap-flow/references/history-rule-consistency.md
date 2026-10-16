# 历史规则与本次需求的一致性检查

目的：发现不同人员、不同 Task 修改同一功能时的业务规则矛盾。复用现有 `enrich_context`、`search_knowledge`、历史侦察、原始 spec/Task 和 Git；**不新增知识库、规则副本或顶层 Skill**。当前 task-context 只保存引用和短对照结论，不复制历史全文。没有历史来源时记录召回范围，不能宣称全历史无冲突。

## 触发与原始证据

新任务需求确认前，在既有侦察中对召回候选执行一次检查；意图、候选、当前需求、相关实现或适用条件变化时刷新；实现前和评审时复核。技术经验也要标明是否涉及业务规则，不能因 `not_used/rejected` 就跳过。

先读候选原文并记录可定位的知识 ID/版本、Task、Commit 或文件章节。历史摘要、作者姓名和“最近更新”都不能自证规则仍有效。逐项核对项目/租户、产品/渠道、环境、状态条件、版本和生效时间；不得把不同机构或测试环境的经验直接用于当前生产规则。来源无法读取或范围未知时记 `unverified`，先在已授权来源补证据，不伪造规则或立即让用户重述整个需求。

对照的语义由 Agent 阅读原文判断：在相同条件下是否要求相反行为，是否违反历史不变量，是否改变数据/API 契约。关键词相似、代码不同或作者不同本身不构成冲突；脚本只验证检查记录和门控，不能证明自然语言判断或授权真实性。

## 处置与提示

| assessment | 含义 | 行为 |
|---|---|---|
| compatible | 相同范围，规则相容 | 记录依据并继续 |
| different_scope | 租户、产品、条件或生效期不同 | 写明差异与范围证据，继续当前范围 |
| not_applicable | 候选不含适用规则，如无关技术经验 | 写明排除理由，继续 |
| change_authorized | 原始用户消息/可信决策已明确批准新旧规则替换 | 提示差异与影响，引用已有决策继续，不重复询问 |
| unresolved | 相同场景规则冲突，尚无明确变更决策 | 提示并暂停受影响的计划/改动/交付，提出最小澄清 |
| unverified | 原文或适用条件缺证据 | 继续只读取证；受影响改动暂不推进 |

提示必须含新旧规则、各自来源、重叠范围、影响和所需决策，例如：

> 历史 Task A 要求“存在未结清订单时禁止注销”；本次要求“允许注销”。两者均涉及正式账户的未结清订单，可能影响结算与账户状态。当前未找到替换规则的明确决策，需要确认本次是否变更此规则、适用范围是什么。

已有明确决策时改为“已按本次原始授权变更，补充旧规则保持/新规则生效的边界回归”，不再问一次。不能因为历史先出现就否决新需求，也不能因为新需求较新就推定其已经批准推翻旧规则。普通对话、无关模块和只读取证可继续；共享流水线的整体 Gate 仍需处置完成才能通过。

## 当前任务证据格式

复用 `.cap/task-context.md` 的 `History usage`，`candidates` 用逗号分隔原始引用（`knowledge:<id>`、`task:<id>`、`git:<commit>`、`file:<relative-path>#<section>`，可附明确版本）。有候选时，下面增加**唯一**的 `Historical rule check`，单个 JSON 代码块：

````markdown
## Historical rule check
```json
{
  "schemaVersion": 1,
  "repo": "当前净化后的 Git origin；无 origin 时使用 canonical Git root",
  "taskId": "当前 STATE 的精确 Task ID",
  "intent": "与 task-context 的 intent 完全相同",
  "candidateSet": "knowledge:kn-cancel",
  "comparisons": [
    {
      "id": "cancel-unsettled",
      "historyRef": "knowledge:kn-cancel",
      "currentRef": "user-message:current-cancel-request",
      "scope": "项目/租户、产品、环境、版本、生效期、账户与订单条件",
      "historicalRule": "有未结清订单时禁止注销",
      "currentRule": "有未结清订单时允许注销",
      "assessment": "unresolved",
      "rationale": "相同条件下要求相反行为；尚无明确替换决策",
      "impact": "影响结算与账户生命周期"
    }
  ]
}
```
````

每个候选至少一条比较，允许同一来源拆多条规则；不能用一个无关候选或兼容结论遮住未决规则。`candidateSet` 必须等于当前 `candidates`，意图必须相同。`change_authorized` 还需 `decisionRef: user-message:<original-id>` 或 `server-decision:<canonical-id>`；主 Agent 必须核对原始消息或可信决策，字符串通过不是授权认证。当前来源不能用摘要/检查点自证；历史引用也不能直接充当新授权。

检查同时绑定当前仓库和 Task。GitHub/GitLab/自建 Git 使用相同协议；迁移 origin 或切换项目后重新核验来源，不直接沿用另一仓的比较结论。同一项目迁移不自动删除旧知识，也不自动跨项目放宽知识权限。

空召回可沿用 `candidates: none`、`outcome: not_used`，无需凭空构造比较；如写检查段则 comparisons=[]。旧的自由文本候选集在下一次命中时由 Agent 审阅后迁移，不批量重写历史快照。

## 接线与闭环

`scripts/cap-history-rules.mjs` 由共享语义检测、完整 Context Guard 和执行 preflight 消费。缺记录、过期、遗漏候选、未决或未核实项均不能通过；status 显示核对历史规则及对应动作。新检查点不能清除未决冲突，当前 task-context 全文仍受语义输入绑定。正常 JSON 上限 64 KiB、最多 100 条；超限按当前影响面缩小召回，不静默截断。

评审检查实现是否符合已确认规则，并覆盖保留场景、变更场景及范围边界。只有产生了新的耐久规则/失效判断才走原 `experience.md → record_experience`，引用旧知识与决策，不复制旧正文。沿用 `modified_adopted/rejected/knowledge_misled` 记录处置；合法范围变更不等于旧知识全局错误，不自动 deprecated，不修改历史快照或通知原作者。跨机器团队复用依赖已有知识权限与同步，Skills 不扫描同事私人会话。
