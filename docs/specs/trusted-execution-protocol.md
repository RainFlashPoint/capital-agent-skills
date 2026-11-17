# Execution Protocol: local v2 and future trusted execution

## 当前已实现：local-observed v2

本地日常入口为 `scripts/cap-execute.mjs` → `runtime/execution/local-flow.mjs`，无需签名密钥或新增授权配置。`ontology/execution.json` v2 驱动命令阶段契约；文档阶段不生成伪执行证明。

实际链路为：本地 Task/阶段 → request.json → 普通宿主进程 → bundle.json → 本地重新校验。请求绑定 Task、Session、仓库、分支、HEAD、脏源码快照、命令哈希和协议版本；结果绑定退出码、输出哈希和执行后快照。status 重算哈希与身份，不把 gate.json PASS 直接当证据。最近失败或中断优先于历史成功；执行锁防止同一仓库同时记录两个动作，动作 ID 不复用。

`test` 阶段另运行工厂级 contract guard：独立守卫 envelope 先于项目主命令执行，二者按 AND 汇总。最新指针引用守卫的 ID、请求哈希、来源和结果；status 会重新验证守卫证据，缺失、篡改、失败或策略漂移都不能被主命令 PASS 覆盖。显式项目命令不会关闭守卫。该本地审计仍是 `local-observed`，不是 Server Gate 或恶意本机写者无法伪造的远程证明。

这是本机一致性检查，不能认证恶意本机写者，不能证明命令覆盖了全部业务验收，也没有连接 Server Gate。使用与兼容范围见 [本地升级说明](../local-efficiency-upgrade.md)。

## 后续设计与保留的 v1 参考实现

以下描述是 `protocol.mjs`、`executor.mjs`、`gate.mjs` 的签名参考协议与未来 Server 接入方向，不是当前本地日常使用要求。v1 HMAC 示例不作为生产信任根，旧记录只保留为历史，不授予 v2 PASS。本轮按产品决策延后授权服务、权限分级、系统隔离和生产 CI/CD 接入。

未来目标：Agent plan → ActionEnvelope → Trusted Executor → EvidenceBundle → Server Gate。只有完成独立身份、执行器与 Server 验证接入后，才能把本地结果升级为平台可信交付。

## 1. ActionEnvelope

The Server (or a locally explicit test authority) creates a signed envelope. Required identity is:

- `tenant`, `project`, `task`, `repo`, `branch`, `commit`
- `agent`, `runner`, `action`, `issuedAt`, `expiresAt`
- an argv-style `command`, environment allowlist, and named constraints

The signature covers every field except `authorization.signature`. The executor rejects expired envelopes, windows longer than one hour, unknown actions, shell metacharacters, oversized commands, and unsigned or invalid envelopes.

The Agent can propose an envelope but cannot self-authorize it. In production the key belongs to a Server authorization service or workload identity provider, never to the coding Agent.

## 2. Trusted Executor

The executor validates the envelope before starting a process. The reference runner additionally:

- accepts only an explicit executable allowlist;
- uses argv execution, never a shell string;
- passes only explicitly allowed environment variables;
- uses a bounded working directory, output buffer, and timeout;
- returns `passed`, `failed`, or `timed_out` with hashes of output and command.

A production runner must add an ephemeral container/VM, read-only source mount where possible, network allowlists, workload attestation, short-lived secrets, and cleanup after every action.

## 3. EvidenceBundle and receipt

The executor produces an evidence body bound to the envelope ID, task, repository, branch, commit, runner, command hash, timestamps, exit code, status, output hashes, and declared constraints. A receipt contains the evidence hash, `authority: trusted-executor`, and a second signature.

Evidence from another commit, task, branch, runner, or future timestamp is invalid. Text saying “passed” is not evidence.

## 4. Server Gate

Gate verification is fail-closed:

1. validate envelope signature and time window;
2. validate receipt signature and provenance;
3. compare every identity field and evidence hash;
4. require `status=passed` and `exitCode=0`;
5. return `PASS` only when all checks succeed, otherwise `BLOCKED` with stable blocker codes.

In the future Server integration, the verified Gate result is required to advance Server workflow state. Ontology facts can add constraints and explain blockers, but cannot bypass the Gate.

## 5. Production integration sequence

1. **Server protocol**: persist envelopes, receipts, key IDs, expiry, revocation, and idempotency keys.
2. **Runner service**: implement ephemeral isolated workers with signed attestation and resource/network policy.
3. **Evidence verifier**: store immutable evidence manifests and artifact provenance, then expose only verified summaries to Agent context.
4. **CI/CD adapters**: bind build, test, scan, package, deploy, canary, and rollback evidence to one commit and task.
5. **Release policy**: require review, security, environment, and delivery evidence before promotion; deny by default and support human takeover.

## 6. Explicit non-goals

This repository does not claim that the local HMAC test secret is a production trust root, that local execution is a Server Gate, or that a payment system was deployed. Those are integration acceptance criteria for the platform repository.

## Contract audit boundaries

`runtime/execution/contract-audit.mjs` 是保守的词法启发式检查器。源码按扩展名识别（JS/TS 家族和 Python），位置不限于某些根目录；从 Git 的 tracked + 未忽略 untracked 清单中排除测试、fixtures、依赖（包括已提交的 node_modules/vendor/third_party）、.cap、构建产物和缓存。忽略的未跟踪文件不在清单内；不支持的语言不扫描。

契约为 docs/contracts 下的 JSON 或任意非排除位置的 *.schema.json。生产源码中的带引号文件名仅是**词法接线证据**，不能证明运行时实际加载、校验了 schema，或执行了引用代码；未调用的 import、未使用的字符串同样可能通过。协议版本字符串不等于文件名引用；测试和注释不提供接线证据。

安全扫描只识别 if 中直接的布尔开关：不限接收变量名，覆盖 enforce/require 等约定开关的 JS 比较与 Python == True / is True / == true / 裸 truthy；还需安全路径标识符或该 if 首条受控语句中的安全调用上下文。普通配置赋值、非安全文件中的普通 truthy、legacy 业务字段不应触发。检测不是 AST/控制流分析；别名、计算属性、复合条件、跨行条件、模板插值、间接调用可能漏检，仅匹配独立 if 行，动作证据只取首条受控语句；无法确认范围时跳过，后续安全语句可能漏检。路径或动作名称也不能证明安全语义。宁可漏检，避免扩大模式造成误报；不能作为权限、默认拒绝或契约有效性的证明。需要独立运行时测试/评审。

`--mode diff` 以 HEAD 为基准，仅检查新增/重命名/未跟踪契约及新增的安全条件行；已提交问题不会自动成为本次增量失败。`--mode full` 明确输出 `advisory:true`，完成盘点时即使有 findings 也 `ok:true`、退出 0，`gatePassed:null`，不是门禁通过；应查看 failures。diff 则 `advisory:false`，`gatePassed` 与 findings 对应。任何模式读取失败、符号链接、非法参数等不完整扫描都 `ok:false`、`scanComplete:false`、退出 1，无门禁结论。

两个模式的计数含义一致：`inventoryFiles` 是 Git 清单中当前存在的全部路径数；`productionFiles` 是按上述规则剩余源码数；`inspectedFiles` 是实际成功读取内容的唯一文件数（包括被检查契约），缓存复读不重复计数。`checked` 是本次检查的契约数；diff 没有契约/源码变更时 inspectedFiles 可为 0，这不证明检测器覆盖有效。
