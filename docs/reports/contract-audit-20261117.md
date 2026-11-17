# Contract audit calibration — 2026-11-17

范围仅 Skills `codex/factory-contract-guard`，以 f4bb97b 为父提交；v0.14.7 标签不移动。Ticket/Server 只读，不修复其中的发现项。

## 能力边界

守卫先执行、主命令后执行、结果 AND 和显式命令不可绕过，沿用原实现。本轮校准检测器能看见的源码范围、保守的安全条件形状及输出语义。

**文件名引用仅是词法接线证据，不能证明运行时实际加载、校验了 schema 或执行了引用代码。** 未调用的 import、未使用的字符串也可能通过。它不是 AST/控制流分析，不证明权限或默认拒绝：仅匹配独立 if 行与首条受控语句；别名、计算属性、复合条件、跨行条件、模板插值、后续受控语句和间接调用可能漏检。安全路径/附近动作也不能证明业务语义。仅支持 JS/TS 家族与 Python 源码；其他语言及 Git 忽略的未跟踪内容不扫描。结果必须结合运行时测试与评审。

full 为 advisory 盘点，完成时 `ok:true`/退出 0，即使 failures 非空；`gatePassed:null` 不表示门禁通过。diff 仅检查 HEAD 之后未提交的新增/重命名契约及新增安全条件行，不回溯已提交问题。扫描错误在两模式均失败。

`inventoryFiles` 为 Git 清单中当前存在的路径数，`productionFiles` 为排除测试/依赖/.cap/产物后的支持语言源码数，`inspectedFiles` 为实际读取的唯一文件数（含契约）。无待检查增量时 inspectedFiles=0 有效，不是扫描覆盖证明。

## 已知零件矩阵

每个案例均创建独立 Git fixture。依赖/测试/产物案例强制加入 index，防止仅靠 .gitignore 得到假通过。完整输入、输出及命令见同目录 JSON；以下输出保留 ok 与 failures（code）。

| 案例 | 输入：路径及内容 | ok | failures |
|---|---|---|---|
| wiring backend/app/validator.py | `docs/contracts/a.schema.json`: `{}`<br>`backend/app/validator.py`: `schema = "a.schema.json"` | true | [] |
| wiring workers/runner/lib/validator.mjs | `docs/contracts/a.schema.json`: `{}`<br>`workers/runner/lib/validator.mjs`: `const schema = "a.schema.json"` | true | [] |
| wiring server/check.js | `docs/contracts/a.schema.json`: `{}`<br>`server/check.js`: `const schema = "a.schema.json"` | true | [] |
| wiring services/check.ts | `docs/contracts/a.schema.json`: `{}`<br>`services/check.ts`: `const schema = "a.schema.json"` | true | [] |
| wiring bin/check.cjs | `docs/contracts/a.schema.json`: `{}`<br>`bin/check.cjs`: `const schema = "a.schema.json"` | true | [] |
| wiring check.jsx | `docs/contracts/a.schema.json`: `{}`<br>`check.jsx`: `const schema = "a.schema.json"` | true | [] |
| JS user explicit | `backend/gate.mjs`: `if (user.enforce === true) { deny() }` | false | safety_opt_in |
| JS cfg explicit | `backend/gate.mjs`: `if (cfg.enforce === true) { deny() }` | false | safety_opt_in |
| JS ctx explicit | `backend/gate.mjs`: `if (ctx.enforce === true) { deny() }` | false | safety_opt_in |
| Python input.enforce == True | `backend/gate.py`: `if input.enforce == True:\n    deny()\n` | false | safety_opt_in |
| Python input.enforce is True | `backend/gate.py`: `if input.enforce is True:\n    deny()\n` | false | safety_opt_in |
| Python input.enforce == true | `backend/gate.py`: `if input.enforce == true:\n    deny()\n` | false | safety_opt_in |
| Python cfg.enforce | `backend/gate.py`: `if cfg.enforce:\n    deny()\n` | false | safety_opt_in |
| Python input.enforce | `backend/gate.py`: `if input.enforce:\n    deny()\n` | false | safety_opt_in |
| non-safety truthy | `backend/theme.js`: `if (input.enforce) render()` | true | [] |
| aggregate path is business | `backend/aggregate.js`: `if (cfg.enforce) render()` | true | [] |
| navigate path is business | `backend/navigate.js`: `if (cfg.enforce) render()` | true | [] |
| unrelated adjacent identifier | `backend/theme.js`: `if (cfg.enforce) render()\nconst aggregate = 1` | true | [] |
| unrelated function declaration | `backend/theme.js`: `if (input.enforce) render()\nfunction deny() {}` | true | [] |
| unrelated following call | `backend/theme.js`: `if (input.enforce) render()\ndeny()` | true | [] |
| unrelated same-line call | `backend/theme.js`: `if (input.enforce) render(); deny()` | true | [] |
| regex sample is data | `backend/gate.js`: `const pattern = /if (cfg.enforce) deny()/;` | true | [] |
| normal config read | `backend/gate.py`: `enabled = cfg.enforce\n` | true | [] |
| legacy business field | `backend/gate.py`: `if user.legacy:\n    archive_order()` | true | [] |
| comment and string | `backend/gate.js`: `// if (ctx.enforce === true) deny()\nconst sample="if (user.enforce === true) deny()"` | true | [] |
| Python multiline string | `backend/gate.py`: `text = """\nif cfg.enforce:\n    deny()\n"""` | true | [] |
| ordinary feature | `backend/gate.js`: `if (cfg.darkMode === true) render()` | true | [] |
| business legacy explicit | `backend/gate.js`: `if (user.legacy === true) archiveOrder()` | true | [] |
| safety action in ordinary path | `backend/feature.js`: `if (ctx.enforce === true) { deny() }` | false | safety_opt_in |
| unwired contract | `docs/contracts/a.schema.json`: `{}` | false | contract_not_wired |
| test-only reference | `docs/contracts/a.schema.json`: `{}`<br>`backend/tests/check.py`: `schema="a.schema.json"` | false | contract_not_wired |
| version only reference | `docs/contracts/a.schema.json`: `{}`<br>`backend/gate.py`: `schema="a/v1"` | false | contract_not_wired |
| comment only reference | `docs/contracts/a.schema.json`: `{}`<br>`backend/check.js`: `/* "a.schema.json" */` | false | contract_not_wired |
| excluded node_modules | `node_modules/gate.js`: `if (cfg.enforce === true) deny()`<br>`node_modules/a.schema.json`: `{}` | true | [] |
| excluded web/node_modules/next | `web/node_modules/next/gate.js`: `if (cfg.enforce === true) deny()`<br>`web/node_modules/next/a.schema.json`: `{}` | true | [] |
| excluded vendor | `vendor/gate.js`: `if (cfg.enforce === true) deny()`<br>`vendor/a.schema.json`: `{}` | true | [] |
| excluded third_party | `third_party/gate.js`: `if (cfg.enforce === true) deny()`<br>`third_party/a.schema.json`: `{}` | true | [] |
| excluded dist | `dist/gate.js`: `if (cfg.enforce === true) deny()`<br>`dist/a.schema.json`: `{}` | true | [] |
| excluded build | `build/gate.js`: `if (cfg.enforce === true) deny()`<br>`build/a.schema.json`: `{}` | true | [] |
| excluded .cap | `.cap/gate.js`: `if (cfg.enforce === true) deny()`<br>`.cap/a.schema.json`: `{}` | true | [] |
| excluded backend/__pycache__ | `backend/__pycache__/gate.js`: `if (cfg.enforce === true) deny()`<br>`backend/__pycache__/a.schema.json`: `{}` | true | [] |
| excluded tests | `tests/gate.js`: `if (cfg.enforce === true) deny()`<br>`tests/a.schema.json`: `{}` | true | [] |
| excluded fixtures | `fixtures/gate.js`: `if (cfg.enforce === true) deny()`<br>`fixtures/a.schema.json`: `{}` | true | [] |

另外 5 项回归覆盖：full 有存量发现仍退出 0；两模式计数一致（6 个 inventory、1 个 production、1 个实际读取）；已修改文件只检查新增条件并保留文件级注释/字符串状态；full 排除已跟踪依赖 schema；符号链接或非法模式均失败。新合成测试共 48 项；父提交红色结果见 JSON 原始输出，修复后全部通过。父提交原始红色输出与 SHA 收在 JSON baseline 中。

## 三仓原始输出

Skills 是本轮源码工作区快照（审计器 SHA 见 JSON），HEAD 仍为父提交；下列计数对应实际扫描时刻。Ticket 的既有 `.cap/PROFILE.md` 修改保留，Server 干净。三仓扫描前后 HEAD、status 和 tracked diff hash 一致；没有写入 Ticket/Server。diff 在干净业务树上 checked=0，不能把它解释成全仓无问题。

### skills

根目录：`/Users/hongzhi/Desktop/lzsk1/capital-agent-skills-recovery-fix`

分支：`codex/factory-contract-guard`；HEAD：`f4bb97b81847a859fe9f25db0d9d66dc042e1a8a`。

`--mode diff`，退出码 0：

```json
{
  "ok": true,
  "mode": "diff",
  "advisory": false,
  "scanComplete": true,
  "gatePassed": true,
  "checked": 0,
  "inventoryFiles": 272,
  "productionFiles": 75,
  "inspectedFiles": 1,
  "failures": []
}
```

`--mode full`，退出码 0：

```json
{
  "ok": true,
  "mode": "full",
  "advisory": true,
  "scanComplete": true,
  "gatePassed": null,
  "checked": 0,
  "inventoryFiles": 272,
  "productionFiles": 75,
  "inspectedFiles": 75,
  "failures": []
}
```

### ticket

根目录：`/Users/hongzhi/.codex/worktrees/3587/capital-agent-ticket`

分支：`codex/fix-ticket-unified-regressions`；HEAD：`5d98c52e992db3c2b68c128da56e6042922a036f`。

`--mode diff`，退出码 0：

```json
{
  "ok": true,
  "mode": "diff",
  "advisory": false,
  "scanComplete": true,
  "gatePassed": true,
  "checked": 0,
  "inventoryFiles": 574,
  "productionFiles": 237,
  "inspectedFiles": 0,
  "failures": []
}
```

`--mode full`，退出码 0：

```json
{
  "ok": true,
  "mode": "full",
  "advisory": true,
  "scanComplete": true,
  "gatePassed": null,
  "checked": 0,
  "inventoryFiles": 574,
  "productionFiles": 237,
  "inspectedFiles": 237,
  "failures": [
    {
      "code": "safety_opt_in",
      "file": "backend/app/agent_kernel/policy.py",
      "line": 98,
      "detail": "Possible safety enforcement controlled by an optional boolean condition (heuristic).",
      "remediation": "Check enforcement defaults; use an auditable policy for any exception."
    }
  ]
}
```

### server

根目录：`/Users/hongzhi/.codex/worktrees/7ba4/capital-agent-server`

分支：`codex/harness-p2-observation-2d`；HEAD：`6da8a1e30535f7015ad2f6ef204bce7511fccebc`。

`--mode diff`，退出码 0：

```json
{
  "ok": true,
  "mode": "diff",
  "advisory": false,
  "scanComplete": true,
  "gatePassed": true,
  "checked": 0,
  "inventoryFiles": 615,
  "productionFiles": 279,
  "inspectedFiles": 0,
  "failures": []
}
```

`--mode full`，退出码 0：

```json
{
  "ok": true,
  "mode": "full",
  "advisory": true,
  "scanComplete": true,
  "gatePassed": null,
  "checked": 3,
  "inventoryFiles": 615,
  "productionFiles": 279,
  "inspectedFiles": 282,
  "failures": [
    {
      "code": "contract_not_wired",
      "file": "docs/contracts/evidence-v1.schema.json",
      "detail": "No quoted filename reference in production source (lexical evidence only).",
      "remediation": "Wire runtime consumption and verify it independently, or record a reasoned PROFILE exemption."
    },
    {
      "code": "contract_not_wired",
      "file": "docs/contracts/gate-v1.schema.json",
      "detail": "No quoted filename reference in production source (lexical evidence only).",
      "remediation": "Wire runtime consumption and verify it independently, or record a reasoned PROFILE exemption."
    },
    {
      "code": "contract_not_wired",
      "file": "docs/contracts/harness-preflight-v1.schema.json",
      "detail": "No quoted filename reference in production source (lexical evidence only).",
      "remediation": "Wire runtime consumption and verify it independently, or record a reasoned PROFILE exemption."
    }
  ]
}
```

Server 三份契约未找到词法引用，与原评审结论一致；这不是运行时缺陷证明。Ticket full 标出 `backend/app/agent_kernel/policy.py:98` 的 `if require_fact_binding:`，函数参数默认 False；它可能是有意策略分支，业务适用性未在本轮确认，**不认定漏洞**。该发现只在 advisory 中列出，未修改 Ticket。

## 验证

- 合成与原守卫集成：64/64，通过；顺序、AND、显式命令、指针篡改、冻结失败回归保留。
- 既有 local flow / efficiency / ontology / boundaries：61/61，通过。
- test-state 与 ontology CLI 回归、结构检查、独立复核：最终结果见本任务 `.cap/verify` 与 `.cap/review`，不把正在运行的检查预写为 PASS。
- 不改 canonical `verifyBundle` / `verifyCanonicalEvidence`，不 Push、不发布、不改安装源、不移动版本标签或归档分支。
