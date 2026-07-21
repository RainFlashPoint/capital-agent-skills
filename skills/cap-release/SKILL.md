---
name: cap-release
description: >
  研发主线的**发布阶段**(review 通过后的最后一棒)。把已评审的改动沿**环境晋级链**送上线:
  研发 dev → 测试 staging → 线上小流量 canary → 线上全量 full,每一段都是
  `deploy → smoke/health → 门(过=晋级 / 不过=回滚到上一个好版本)`。
  本 skill 收薄为**两件事**:① 选对**部署目标**(static / container / vps)并加载其命令骨架;
  ② 跑**晋级门引擎**(逐级把关、绝不跳级、失败即回滚)。目标类型的命令从 `targets/<type>.md` 取,
  项目特定值(项目名 / 集群 / 主机 / env)运行时从目标仓 `PROFILE.Deploy` + 现场配置抽,**不预置**。
  密钥只在部署环境 / 本地,绝不入仓。
  触发场景:用户说 "发布"、"部署"、"上线"、"ship"、"deploy"、"灰度 / 小流量"、"全量"、"回滚"、
  "cap-release";或 cap-flow 判定 stage=release(review PASS 之后)时路由进来。
  本阶段是**流程 skill**:不写代码、不改业务逻辑——只发布、把关、回滚。
---

# cap-release — 发布:目标选择器 + 晋级门引擎

你正在执行研发主线的**发布阶段**。改动已过 review(STATE 里 `cap-gate: PASS`),现在由你把它**逐级晋级**
安全送上线。两条铁律贯穿全程:

1. **每升一级先过门,过不了就回滚**——deploy 完立刻 smoke/health,不健康就切回上一个好版本。
2. **绝不跳级**——没过 staging 不碰 canary,没过 canary 不碰 full;晋级到 full 前必须人工显式确认。

> **本阶段的收薄哲学**:SKILL.md 只做 **目标选择 + 门引擎**;每种部署目标"具体命令长什么样"下沉到
> `targets/<type>.md`(static / container / vps)。换目标类型 = 换一张卡,门引擎不变。
> **引擎 = 一个能 Read/Edit/Bash/Grep 的模型 + 目标仓已有的部署工具**(vercel / docker / kubectl / ssh…)。

**三层知识分工**(别混):
- **① 门引擎(本文)** —— 晋级链的决策:何时 deploy、何时探活、过门 / 回滚。平台无关。
- **② 目标适配器(`targets/*.md`)** —— 目标类型的命令骨架 + 回滚骨架。按**目标类型**分,不按语言分。
- **③ 项目特定值** —— 运行时从目标仓抽(项目名 / 集群 / 主机 / 域名 / env 清单),**绝不预置在卡里**。

---

## 0. 可移植前置(入口先做)

> 共享 references(如 `deployment-patterns.md`、`languages/*`)物理在 `cap-flow/references/` 下;
> 目标适配器 `targets/*.md` 就在**本阶段目录**(`cap-release/targets/`)下。解析路径分别指向两处,别混。

### 0.1 交互降级 —— 纯文本编号选项
发布是高风险动作,**绝不自动连环上线**。每次要晋级到下一环境前,用纯文本编号列表让用户确认:

```
staging 已部署 + smoke 通过。晋级到 canary(线上小流量)?
  1) 晋级(推荐)
  2) 暂停在 staging
  3) 回滚 staging
回复编号即可。
```
宿主有结构化提问控件时可用,但回退路径必须是上面这种编号文本。**晋级到 full(全量)前必须显式确认。**

### 0.2 并行降级 —— 发布本质串行
环境逐级晋级有强依赖,且**不能两处同时改线上状态**。只读取证(拉日志 / 查指标)可并行;真正的
deploy / promote / rollback **一律串行 inline**,一次只推一处。

---

## 1. 入口条件(进来前必须成立)

| 条件 | 检查 | 不满足 |
|---|---|---|
| **review 已 PASS** | STATE 里有 `cap-gate: PASS reviewed-head=<当前 HEAD 完整 sha>` | 回 `cap-review`(没评审过不发布) |
| **verify 已收口** | STATE.stage 已过 review / verify 通过 | 先完成 verify |
| **改动已提交** | 工作树干净、HEAD 即要发布的版本 | 先提交 |
| **知道往哪发** | 能从 `PROFILE.Deploy` 或目标仓读到部署目标类型 | 走 §2 探测;探不到 → 编号文本问用户 |

> **`cap-gate` 与 HEAD 不符**(评审后又改了码)→ **停**,回 review 重审。发布的必须是被评审过的那个 sha。
> 这正是 pre-push hook 卡的那行:reviewed-head 对不上当前 HEAD,push 就不放行。

---

## 2. 读项目部署事实(项目特定值从目标仓抽,不预置)

进 release 第一件事:把"往哪发、怎么发"的项目特定值从目标仓抽出来。

1. **读 `<repo>/.cap/PROFILE.md` 的 `## Deploy` 节**(cap-understand 探测写入):目标类型(static / container / vps)
   + 关键配置位置。
2. **读目标仓现场配置**:`vercel.json` / `Dockerfile` + k8s manifests / 部署脚本 / 目标仓 `CLAUDE.md` 的部署段
   → 拿项目特定值(项目名 / 集群 / namespace / 主机 / 域名 / env 清单)。
3. **选适配器**:据目标类型加载 `targets/<type>.md`(命令骨架 + 回滚骨架)。目标类型 → 卡的映射:

   | 目标类型 | 适配器卡 | 典型场景 |
   |---|---|---|
   | **static** | `targets/static.md` | Vercel / Netlify 静态站 / SPA / SSG |
   | **container** | `targets/container.md` | Docker → registry → K8s / 云容器服务 |
   | **vps** | `targets/vps.md` | 能 ssh 进去的 Linux 主机(systemd + nginx) |

4. **构建命令复用语言包**:产物怎么 build 从 `cap-flow/references/languages/<lang>.md` 取(如 `pnpm build` /
   `go build`);release 只管"把产物推上去",不管怎么编。
5. **密钥**:从部署环境 / secret-manager / 本地 env 读,**绝不写进仓、不打印**。探测到缺密钥 → 编号文本告知
   用户去配置,不替代。

> 探不到部署方式(目标仓没有任何部署配置)→ 编号文本问用户"这个项目怎么部署 / 要不要先 setup",不臆造。

---

## 3. 环境晋级门引擎(主循环)

方法论细节见 `cap-flow/references/deployment-patterns.md`。核心 = **逐级晋级,每段一个门,过不了就回滚。**

```
研发 dev ─[门]→ 测试 staging ─[门]→ 线上小流量 canary ─[门]→ 线上全量 full
每段:  适配器 deploy → smoke/health → 门(过=编号文本确认后晋级 / 不过=回滚到 last-good)
```

| 环境 | deploy 做什么 | 门(过了才晋级) |
|---|---|---|
| **dev 研发** | 构建 + 部署到研发环境 | 打包成功 + 基本 smoke(关键路径起得来) |
| **staging 测试** | 部署到测试环境 | **集成 / e2e 通过**(复用 cap-test 的 journey check 跑 staging)+ 配置 / 迁移就绪(迁移按 deployment-patterns 的 expand-contract,联动 architect) |
| **canary 线上小流量** | 小流量发布(适配器的灰度骨架) | **观察期指标健康**(错误率 / 延迟 / 饱和度三信号无异常)+ 编号文本确认 |
| **full 线上全量** | 全量发布 | canary 通过 + **用户显式确认**(§0.1) |

每段固定四拍:
1. **deploy** —— 用适配器卡的命令骨架把这一级发出去。
2. **smoke/health** —— 探活;失败立即进 §4 回滚,不往下走。
3. **记录** —— 把"已达环境 + 证据(命令输出 / health 结果 / 指标)"写进 release 报告。
4. **确认晋级** —— 编号文本让用户拍板是否升下一级(full 前强制确认)。

> **取证纪律**:每一级的"过门"都必须挂**本轮真跑**的 smoke/health 输出,不接受"应该好了 / 大概起来了"。
> 看到 should / probably / seems / "Done!" 出现在探活之前 = STOP,去跑命令。

---

## 4. 回滚(任何环境门失败即触发)

回滚是**默认安全动作**,不是出事才现想的应急。各适配器卡都自带回滚骨架:

- **static**:重指 alias / `vercel rollback` 到上一个 deployment(产物不可变,无需重建)。
- **container**:`kubectl rollout undo` 或 set image 回上一个不可变 sha tag。
- **vps**:`current` 软链切回上一个时间戳 release + 重启。

回滚协议:
1. **回滚到 last-good** —— 用适配器卡对应骨架。前提:每次晋级前先记下 `<prev-good>`(上一个通过的版本 /
   deployment / release 目录)。
2. **smoke 复验** —— 回滚后再探一次活,确认线上确实恢复。
3. **记录** —— 回滚原因 + 哪一级失败 → 写进 release 报告 + STATE.Decisions log;严重的回 cap-implement / cap-review。
4. **不原地反复重试** —— 失败即回滚到已知好版本,再回上游定位根因,别在线上死磕。

---

## 5. 读写哪些 .cap/ 文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `<repo>/.cap/PROFILE.md` | **读** | `## Deploy` 节(目标类型 + 配置位置);本阶段不写 PROFILE |
| `<repo>/.cap/STATE.md` | **读 + 经 cap-flow 写**(单写者) | 读 `cap-gate` 入口门;本阶段输出 `## HANDOFF`,由 cap-flow 写 stage=release/done、release 进度、Decisions |
| `<repo>/.cap/release/<release>-report.md` | **写** | 本次发布报告:各环境晋级时间 / 证据 / 指标 / 回滚(若有) |
| `cap-release/targets/<type>.md` | **读**(本阶段目录) | 目标类型命令骨架 + 回滚骨架 |
| `cap-flow/references/deployment-patterns.md` · `languages/*` | **读** | 方法论 / build 命令 |

---

## 6. 出口门(本阶段算完成)

- [ ] **逐级晋级无跳级**:dev → staging → canary → full,每段门都过(或显式停在某级并记录)。
- [ ] **每级有 smoke/health 证据**(真跑的命令输出 / health 探活结果),无"应该好了"。
- [ ] **迁移安全**(若有):向后兼容、可回滚已确认(expand-contract)。
- [ ] **晋级到 full 经用户显式确认**。
- [ ] **release 报告已写** `.cap/release/<release>-report.md`;STATE 更新(stage=done)。
- [ ] **密钥未入仓**(全程从环境读)。

任一未过 / 中途回滚 → status=`gated` / `blocked`,STATE.next 指明(回滚后多回 build / review)。

---

## 7. 写什么进 HANDOFF(由 cap-flow 写 STATE)

阶段结束输出 `## HANDOFF`,经 cap-flow / 单写者写回 STATE:

```markdown
## HANDOFF
stage: done                 # 全量发布且 smoke 过;或停在某环境则 stage=release, status=gated
status: in-progress | gated | blocked
## Release 进度
- dev: deployed ✓  smoke ✓ (<time>)
- staging: deployed ✓  e2e ✓ (<time>)
- canary: deployed ✓  指标健康(err/lat/sat)✓  观察 <dur> (<time>)
- full: deployed ✓  smoke ✓ (<time>)
## Decisions log
- <date> canary 指标正常,晋级 full / 或:staging smoke 失败,回滚,回 build
## Next action
-> 发布完成(stage=done) / 或:修 <问题> 后重走 cap-release
```

---

## 8. 边界与兼容性(载重规则)

- **不写代码、不改业务逻辑** —— 那是 build 的事;发布中若发现实现 bug,回 cap-implement,不在 release 偷改。
- 纯文件 + 目标仓现有部署工具;不硬依赖结构化提问控件(编号文本兜底)、无子代理硬依赖。
- **密钥只在部署环境 / 本地,绝不入仓** —— 这也是当初放弃"CI 里跑 agent"方案的根本原因。
- 项目特定值全从目标仓抽,本阶段不预置任何项目的部署细节;适配器卡里出现的一律是 `<占位>`。
