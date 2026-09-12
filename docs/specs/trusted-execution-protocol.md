# Execution Protocol: local v2 and future trusted execution

## 当前已实现：local-observed v2

本地日常入口为 `scripts/cap-execute.mjs` → `runtime/execution/local-flow.mjs`，无需签名密钥或新增授权配置。`ontology/execution.json` v2 驱动命令阶段契约；文档阶段不生成伪执行证明。

实际链路为：本地 Task/阶段 → request.json → 普通宿主进程 → bundle.json → 本地重新校验。请求绑定 Task、Session、仓库、分支、HEAD、脏源码快照、命令哈希和协议版本；结果绑定退出码、输出哈希和执行后快照。status 重算哈希与身份，不把 gate.json PASS 直接当证据。最近失败或中断优先于历史成功；执行锁防止同一仓库同时记录两个动作，动作 ID 不复用。

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
