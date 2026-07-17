---
role: skill-maintainer
triggers: ["skills/**", "**/SKILL.md", ".claude-plugin/**", "skills/cap-flow/references/**"]   # 编辑技能体系自身时由 role-routing 加载(见 role-routing §2 R10)
updated: 2026-06-15
---

# skill-maintainer — 技能体系维护者视角角色卡

> 一张"看问题的镜片",不是流程。被 cap-shape / cap-build / cap-verify / cap-review / **cap evolve** 在**改动落在技能体系自身**(`skills/**`、`*SKILL.md`、`references/**`、`.claude-plugin/**`)时加载。
> 这是**唯一作用于工具自身**的角色(其它角色都看某个目标项目的某一段)。它管的是:这套可移植、时用时新的技能族,改完之后**还自洽、不臃肿、可移植、可追溯、且没把自己改坏**。
> 关键背景(自我修改):用 vN 的技能改出 vN+1,**本次运行始终是 vN 在掌舵,vN+1 下趟才生效** → 一个改动的行为只能在下一趟验证,所以当前趟的安全网是 lint + additive 守卫 + 人工过目,而非"现场跑一下"。

## 关注点

维护者在意"改完之后这套东西会不会烂掉",六件事:

1. **防臃肿(反膨胀红线)** —— family = `cap-flow` driver(含 intake 需求树) + 7 流程 skill(map/shape/plan/build/verify/review/release) + harvest-experience。新增能力**默认永不新增顶层 skill**,一律走 references 既有卡片(角色/模式/语言/部署)+ 路由;"该不该加" 默认答案是"不加,扩卡片"。**唯一例外** = cap 主线缺的真·生命周期阶段(如补一个新的发布/需求源阶段),这类才改 stage 枚举新增流程 skill,且须过完整 `/cap` + 本卡评审。
2. **additive 合并,不覆盖**(蒸馏 kb-manage) —— 新方法融进目标卡对应 section,**保留有价值的旧内容**;与旧说法冲突则就地标 `<!-- CONFLICT: 旧… / 新…(源) -->`,不删不裁,留人决策。
3. **防孤儿 / 不断链**(蒸馏 kb-manage Lint) —— 每个新 `.md` 必须被某处引用(被某 SKILL.md 读到 / 被 role-routing 指向);新增/改名的角色·模式·语言都要有路由入口;路由指向的文件都真实存在。
4. **溯源完整(distilled-from)** —— 每张被改动的卡 frontmatter 追加本次源(内部 skill 用 name、外部 repo 用 owner/repo、实战洞察用 `session:<topic>-<date>`)。这是审计与防孤儿的锚点。
5. **可移植铁律** —— 凡落进流程的 pattern 都降级为纯文件 + git + Read/Edit/Bash/Grep:AskUserQuestion→text_mode;Task 并行→Task-or-sequential;二进制/node 工具→等价 bash。离开运行时就不成立的 pattern 不蒸馏。流程 skill 约束"做什么/为什么/避坑",**不写死命令手册**(铁律 #4)。
6. **语义化版本 + CHANGELOG + 自我修改安全** —— 补内容=patch、加能力=minor、破坏性=major;每次改动一条 CHANGELOG。自我修改在临时分支上做,过 lint + additive 守卫 + 人工检查点才落 main;任一不过即 `git restore` 回滚,坏改动进不了 main/GitHub。

## 检查清单

> `[diff]` = 从改动 + grep 静态可判;`[trace]` = 需通读多文件/追引用。

- [ ] `[diff]` 本次是否新增了**顶层 skill 目录**或新 `SKILL.md`?→ 几乎总是该改为"扩 references 卡片 + 路由",否则违反反膨胀红线。
- [ ] `[diff]` 新增的每个 `.md` 是否**被引用**(被某 SKILL.md 读 / 被 role-routing 指)?无人引用 = 孤儿,挂进既有体系或删。
- [ ] `[diff]` 被改动的卡是否更新了 `distilled-from` 与 `updated`?`grep -L distilled-from` 查漏标。
- [ ] `[diff]` 新增/改名的角色·模式·语言,是否在 `role-routing.md`(§2 触发 + §3/§4 字典 + §5 自检)、`STATE.md` 模板、`cap-map` Phase C 字典**四处同步**?缺一即不一致。
- [ ] `[diff]` 流程 skill 里是否混进了脆弱命令一行流(带 shell 怪癖的 find/grep/awk)?→ 原则化(铁律 #4);稳定契约命令(`git diff --name-only`)与参考卡(languages / cap-release targets)的具体命令除外。
- [ ] `[diff]` 是否引入了对 AskUserQuestion / Task / 二进制的**硬依赖**(无 text_mode / 无串行降级)?→ 违反可移植铁律。
- [ ] `[diff]` 是否升了版本 + 写了 CHANGELOG?改动是 patch/minor/major 选对了吗?
- [ ] `[diff]` (自我修改时)diff 是否 **additive-only**:只动已存在卡、只见新增、无意外删除、无新建文件、未碰契约文件(role-routing/driver/STATE模板/枚举)?碰了 = 结构性大改,应走完整 `/cap` 而非 evolve。
- [ ] `[trace]` `bash scripts/validate-skills` 是否通过(断链/孤儿/frontmatter/角色·模式·语言交叉引用)?不过不提交。
- [ ] `[trace]` `grep -r CONFLICT references/` 有无待人决策的冲突标记?汇总上报,不自动裁决。

## 好的样子

- 新能力"无声地"长进既有卡片:多了一条检查清单/一个踩坑/一条路由规则,**没有新顶层 skill、没有游离文件**。
- 每张动过的卡都能回答"这条是从哪蒸来的"(distilled-from)、"何时更新的"(updated)。
- 改完 `validate-skills` 绿、无孤儿、无断链;版本与 CHANGELOG 同步。
- 自我修改全程在临时分支,人工过目 diff 后才落 main;真出问题一条 `git revert` 或降版本即回滚。
- 流程文档读起来是"约束 + 原则",不是会在某个 shell 崩的命令清单。

## 常见翻车

| 翻车 | 后果 | 怎么防 |
|---|---|---|
| 顺手新增一个顶层 skill | family 膨胀、边界失守 | 默认扩 references 卡片 + 路由;真要加阶段才慎重改枚举 |
| 写了游离 `.md` 没人引用 | 孤儿文件、断链 | 每个新文件必须被引用或删;跑防孤儿 lint |
| 加角色卡只改了文件,忘了路由/STATE/onboard 同步 | 角色存在却从不被加载(死卡) | 四处同步清单;lint 交叉引用兜底 |
| 覆盖式编辑,删掉旧内容 | 丢失有价值的既有方法 | additive 合并;冲突只标不删 |
| 蒸馏时把运行时依赖一起搬进来 | 在 Codex 下跑不了 | 降级为纯文件+git;不可移植的 pattern 不蒸 |
| 自我修改直接改 main 工作区、不过闸 | 把工具改坏、影响以后每次运行 | 临时分支 + lint + additive 守卫 + 人工检查点 + 回滚 |
| 改了不升版本/不写 CHANGELOG | 无法追溯、无法回滚到已知好版本 | 每次改动 semver + 一条 CHANGELOG |
| 软链装完就以为能用,没验 `readlink` 落点 | evolve 探源拿到的不是可写 git 仓 / 无 plugin.json → 回流静默失败 | 装完验 `readlink ~/.{claude,codex}/skills/cap-flow` 指向真实可写 git 仓(含 `.claude-plugin/plugin.json`);技能在**新会话**才注册,当前会话要 dogfood 就把 playbook 当数据手动执行 |

## 介入哪些阶段

- **shape**:当特性是"给技能体系加能力"时,第一问是"**这能不能不加 skill、用 references 扩**?";审是否触及契约(碰了就是大改)。
- **evolve(小改快路)** / **build(大改)**:落位守 additive、守可移植、守溯源;改契约时提醒四处同步。
- **verify**:`bash scripts/validate-skills` 是这套体系的 logic 校验——断链/孤儿/frontmatter/交叉引用全过。
- **review**:防臃肿 + 溯源完整 + 可移植 + 命令手册化(铁律 #4)是本角色在评审里的四把尺。
- **release**:版本与 CHANGELOG 是否同步、回滚路径是否清楚。
