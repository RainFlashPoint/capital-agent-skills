# 进化回路(Evolve Loop)—— 把一次验证过的改进推进中心知识库

> 这份 playbook 是 **数据,不是 skill**(与 `distillation-loop.md` 并列)。任何引擎(一个能
> Read/Edit/Bash/Grep 的模型,或 Codex)都能照着执行,不依赖任何运行时工具。
> 由 cap-flow 的 **`/cap evolve`** 子命令入口加载。它**复用** `distillation-loop.md` 做"把 pattern 蒸成什么、
> 落哪张卡"(不重写方法论),只补 distillation-loop 不管的:**捕获一次验证过的改进 + 安全闸 + 沉淀进中心 KB**。
>
> **核心改锚(护城河)**:evolve 的出口**不是**发回任何外部 GitHub 自更新环,而是通过 harvest-experience 的
> `record_experience` 把改进推进 **capital-agent 中心知识库**,带 **operator 归因**。这样一个人验证过的改进,
> 会被注入到**全团队**后续的相关 loop——这才是"时用时新"真正的载体。

---

## 0. 它解决什么

时用时新的最后一公里:你在**某个项目**里用着 cap-* 流程,冒出"这套做法在这类场景该这么改进"的念头,
且这次 loop 里**已经验证它管用**了。evolve 把这个已验证的改进**安全地沉淀进中心 KB**,让它成为团队共享经验。

与 distillation 的分工:distillation 侧重"把复发 finding / 外部实现蒸成经验";evolve 侧重"我这次 loop 里
亲手验证了一个改进,把它推上去",且带**安全闸 + 人工过目**(因为它可能同时收紧本地卡片,属自我修改)。

---

## 1. 用 evolve(小改)还是走完整 `/cap`(大改)—— 机器可判

evolve **只做 append-to-existing 小改**(沉淀一条经验 + 可选就近收紧已存在的卡)。落位前先判:

```
若这次落位 = 仅沉淀经验进 KB + append/收紧 references/ 下【已存在】的卡  → evolve 放行
若 = 新建文件 / 动 role-routing / cap-flow / STATE 模板 / stage 枚举(契约 / 结构性)
     → 停,escalate(编号文本):
       "这是结构性改动(新建卡 / 动契约),不该走 evolve 轻量路。
        请对 skills 仓跑完整 /cap(shape→…→release),含多角色 review。"
```

> 这道 guard 在 §3 安全闸用 `git diff` 再兜一次:即便判断失误真写了结构性改动,安全闸也会拦下并回滚。

---

## 2. 主管道(6 步)

```
①捕获 → ②蒸馏定位 → ③(可选)就近落卡 → ④安全闸(§3)→ ⑤沉淀中心 KB(§4)→ ⑥回报
```

### ① 捕获
洞察来自**当前 session**(刚才 build/verify/review 里验证过的改进)+ 用户一句话描述要沉淀什么。
**不做持久 inbox**(跨机器不可靠)。一次 evolve 聚焦**一个**改进。**硬门**:这个改进必须在本次 loop 里
真验证过(不是空想),对齐 distillation §1.1 的"先验证再记录"。

### ② 蒸馏定位(复用 distillation-loop)
按 `distillation-loop.md` §2 的 ②提炼 / ③定位,把改进蒸成可执行 pattern,判断它属于哪个角色 / stage / check。
**这一步不重写方法论,直接照 distillation 做。**

### ③(可选)就近落卡
若改进也值得写进本地卡片,按 distillation §2-④ 的合并纪律 additive 追加(保留旧内容、标矛盾、刷 `updated`)。
纯沉淀经验(不动本地卡)可跳过本步,直接到 §4。

### ④ 安全闸
见 §3(临时分支 → lint → additive 守卫 → 人工检查点)。**仅当 ③ 动了本地卡片时才需要全套安全闸**;
纯 KB 沉淀无本地文件改动,只需过 §1 范围判 + §4 归因自检。

### ⑤ 沉淀中心 KB
见 §4(`record_experience` 带 operator + repo_url;repoTail 不变量)。

### ⑥ 回报(编号文本)
告诉用户:沉淀了哪条经验(intent 摘要 + KB 文档 ID)、operator 是谁;若动了本地卡,附改了哪张卡 + commit sha。

---

## 3. 安全发布闸(仅当就近改了本地卡片)

```
①(在 skills 源)开临时分支:  git switch -c evolve/<topic>     # 绝不直接动 main 工作区
② 应用 ③ 落卡的 append 改动
③ 闸 A 结构 lint:            bash scripts/validate-skills    # 断链 / 孤儿 / frontmatter / 交叉引用全过
④ 闸 B additive 守卫:        git diff --stat / --name-only 自检——
      只动 references/ 下已存在卡、只见新增行、无意外删除、无新建文件、未碰 role-routing|cap-flow|STATE模板|枚举
      → 任一不满足:判为结构性 → 自动回滚(§ 回滚)+ escalate 走完整 /cap
⑤ 闸 C 人工检查点(编号文本):把 diff 摆给用户,等确认
      1) 确认    2) 我要再改    3) 放弃(回滚)
```

**回滚**(任一闸挂 / 用户放弃):
```
git restore . ; git switch main ; git branch -D evolve/<topic>
```
源回到干净 main,坏改动进不了 main。一次 evolve = 一聚焦改动 = 一 commit → 真出问题 `git revert` 即回滚。

三层安全:**范围闸**(§1)+ **临时分支 / 回滚** + **人工检查点(闸 C)**。

---

## 4. 沉淀进中心 KB(护城河出口)

`/cap evolve` 的**真正出口**是中心 KB,不是任何外部代码仓。用 harvest-experience 的 `record_experience`:

- `intent`:这条改进解决什么(一句有信息量的总结;太短 / 空话服务端会跳过)。
- `changed_files`:相关文件**路径**(只传路径,绝不传代码内容)。
- `repo_url`:当前仓库地址——**必须与本次 loop 注入(enrich_context)时同一个**(repoTail 不变量,见下)。
- `operator`:贡献者归因——**谁验证的这个改进**(新归因方案里等同 `owner`,是其向后兼容别名;evolve 通常是人亲手验证,故一般不涉及 `runner`。owner/runner 双字段全貌见 `harvest-experience`)。
- `session_id`:可选。

**repoTail 不变量**:注入与沉淀必须锚在同一 `repo_url` 派生的 projectKey 上,否则归因静默断裂——
别让"注入用 remote URL、沉淀用本地路径"这类不一致把闭环切断。整个 loop 固定用一种 repo_url 表达。

**晋级不是 evolve 自动完成**：经验先按证据进入 candidate 或 validated。只有至少两个不同 Task 独立验证且管理员批准，才能调用 `promote_experience` 进入团队池。若后续证明错误或被替代，管理员调用 `deprecate_experience`，附原因与可选 replacement document ID；deprecated 永不注入。

**外部 Skill 来源门**：必须记录 URL、版本、License 与本地 fixture/验证证据。缺来源或许可证不明时只保存 candidate。

**密钥**:全程不读不写任何密钥;沉淀走已配置的 `capital-agent` MCP,凭据由 MCP 层管理,不进本 playbook。

> **无 `capital-agent` MCP 的环境**:`enrich_context` / `record_experience` 不可用时,不假装已沉淀。
> 编号文本告知用户"中心 KB 通道未配置,本次改进未沉淀;可参考 harvest-experience/references/setup-mcp.md 配置",
> 并把改进摘要打印出来供用户手工记录。

---

## 5. 与其他源的配合(一句话)

- `distillation-loop.md` 提供 **②蒸馏定位 + ③就近落卡** 的方法论(放进哪张卡 / additive 合并 / 防孤儿)——evolve 复用,不重写。
- `harvest-experience` 提供 **⑤沉淀** 的中心 KB 通道(`record_experience` + operator 归因 + repoTail 不变量)。
- `skill-maintainer.md` 角色卡提供**全程透镜**(防臃肿 / additive / 可移植 / 自我修改安全的判据)。
- 本 playbook 只增量贡献:**捕获已验证改进 + 安全闸 + 中心 KB 沉淀**。
