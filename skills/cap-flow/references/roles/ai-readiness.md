---
role: ai-readiness
triggers: ["CLAUDE.md", "AGENTS.md", ".claude/**", "justfile", "Makefile", ".github/**", "tsconfig.json", "**/*.ai-context.*"]
---

# ai-readiness — 面向 AI 的友好度 / 可维护性视角角色卡

> 一张"看问题的镜片",不是流程。被 `cap-map`(只读体检打分)、遗留改造类 feature(指导整改)、`cap-review`(可维护性透镜)在相关时加载。
> 视角:**这个代码库对 AI agent 好不好用、好不好维护**(上下文架构 / scoped 命令 / 噪声 / 类型 / 测试 / LSP 就绪)。
> 与 `architect` 分工:architect 看**全链路数据结构/契约**;ai-readiness 看**代码库对 agent 的友好度**。蒸馏自 arch-aifriendly-doctor(取其 10 维判据 + 23 模式知识,丢"整改动作"本身——整改是 feature,走流程)。

## 关注点(10 维 AI-友好度,从"扫描可判"到"需通读"递进)

1. **CLAUDE.md 质量 + 级联**(P1)——根级有 CLAUDE.md?是否级联到 domain/module(agent 走到哪目录自动加载哪层上下文)?还是一个巨石根文件。**判断该在哪几层建**:用 PROFILE 的 surface-map 当输入——每个有「局部 + 代码看不出 + 违反代价高」规则的面,就是一层 `src/<surface>/CLAUDE.md` 候选;规则大多全局、面又小,则单根足够。
2. **该进 CLAUDE.md 的才进**(P3)——三条件全满足才写进:project-specific + 代码里看不出 + 违反代价高。避免把代码能自证的东西塞进去。
3. **scoped 命令**(P23)——每个模块/包有自己的 `test/build/lint` 命令?还是只有一个全局命令、改一处要跑全部。
4. **domain-aware check**(P13)——能否 `git diff` 判改动域 → 只跑该域的检查?(这正是我们 surface-map 路由的同源思想)
5. **噪声控制**——`dist/node_modules/__pycache__/生成物` 是否被排除出 agent 上下文?噪声越多 agent 越容易被带偏。
6. **类型系统**——有类型注解/类型检查?agent 能否静态理解数据形状(而非全靠运行时猜)。
7. **测试就绪**——有可跑的测试套件?agent 改完能自验,是 AI 可维护性的地基。
8. **LSP 就绪**——符号可跳转/可索引(有 LSP 配置/语言服务器)?决定 agent 能否精确定位而非全文搜。各语言的 language server 见 `references/languages/<lang>.md`(pyright/tsserver/gopls/rust-analyzer/sourcekit-lsp/kotlin-language-server/jdtls)。
9. **文档与约定显式**——README/约定是否让 agent 不用猜就知道"怎么跑/怎么改/禁什么"。
10. **禁止事项 / 工具防护**——有没有显式 prohibitions(别碰什么)+ agent 工具参数防御(危险操作有护栏)。

## 检查清单

> `[scan]` = 纯 bash 可静态判定(onboard Phase A 即可采);`[read]` = 需读内容判断。

- [ ] `[scan]` 根有 `CLAUDE.md`/`AGENTS.md`?有几层级联(`find . -name CLAUDE.md`)?
- [ ] `[scan]` 是否有 monorepo/包结构(pnpm-workspace/packages/*),各包有无自己的 test/build script?
- [ ] `[scan]` 有类型配置(tsconfig / mypy / pyright)?有测试目录与 runner?
- [ ] `[scan]` `.gitignore` / 工具配置是否排除了生成物噪声?
- [ ] `[read]` CLAUDE.md 内容是否聚焦"代码不可见 + 违反代价高"的项,还是堆了代码能自证的东西?
- [ ] `[read]` 改动某模块时,是否有办法只跑该模块的检查(scoped 命令 / domain check)?
- [ ] `[read]` 有没有显式"禁止事项"和危险操作护栏?

## 好的样子

- 根 + domain 级联 CLAUDE.md,agent 进任一目录都拿到恰好够用的上下文,不多不少。级联层级由 surface-map 推导(面有独特局部规则才单独建一层,否则单根足够)。
- `AGENTS.md` 软链到 `CLAUDE.md`(`ln -s CLAUDE.md AGENTS.md`,git 按 mode 120000 存)——Codex 读 AGENTS.md、Claude 读 CLAUDE.md,**同一份内容、单一事实源、免漂移**;胜过写一个"见 CLAUDE.md"的指针文件(指针要多跳一次)。
- 每个模块自带 scoped 命令;改一处只验一处。
- 类型 + 测试 + LSP 就绪,agent 改完能静态理解 + 自验 + 精确跳转。
- 噪声被排除;约定/禁止显式;新 agent 上手零猜测。

## 常见翻车

| 翻车 | 后果 | 怎么防 |
|---|---|---|
| 巨石根 CLAUDE.md,无级联 | agent 在子模块拿不到对的上下文 | 级联到 domain/module(P1) |
| CLAUDE.md 堆代码能自证的东西 | 过期、噪声、误导 | 只写"不可见+代价高"(P3) |
| 只有全局命令,无 scoped | 改一行跑全套,慢且 agent 不知跑啥 | 每模块 scoped 命令(P23) |
| 生成物没排除 | agent 上下文被 dist/node_modules 污染 | 噪声控制 |
| 无类型/无测试 | agent 改完无法自验,易引入回归 | 补类型 baseline + 测试 baseline |

## 介入哪些阶段

- **cap-map(只读体检打分)**:onboard 用本卡的 10 维做**只读评分**,把 AI-友好度健康分 + 缺口写进 PROFILE 的 `## Known risks`。**只评估,不整改**(守 onboard 只读纪律)。
- **遗留改造 feature**:当一个 feature 的目标是"把这个陈旧/不友好的仓改造成 AI-friendly"时,本卡的 23 模式是整改的"好的样子"清单。**整改是 feature → 走标准 spec→plan→build→validate→review loop**;但通常按 **L1 复杂度 + 文档/配置改动走 Skip-TDD**(加 CLAUDE.md/scoped 命令这类没法单测),**走轻但不短 review/verify 门**。
- **cap-review**:作为可维护性透镜审"本次改动有没有降低 AI-友好度"(如新增巨石文件、删了 scoped 命令)。
