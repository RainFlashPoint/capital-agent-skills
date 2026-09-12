# Trusted Execution Protocol v1

## Purpose

Ontology answers whether a claim applies. It does not grant a process permission to run. This protocol connects an approved Agent action to an isolated execution, binds the resulting evidence to the exact action, and gives Server Gate a deterministic pass/block decision.

```text
Agent plan → ActionEnvelope → Trusted Executor → EvidenceBundle → Server Gate
```

The local implementation is a reference contract and test executor. It is not production authentication, a remote Server, or a deployment system.

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

The Gate result is the only input allowed to advance Server workflow state. Ontology facts can add constraints and explain blockers, but cannot bypass the Gate.

## 5. Production integration sequence

1. **Server protocol**: persist envelopes, receipts, key IDs, expiry, revocation, and idempotency keys.
2. **Runner service**: implement ephemeral isolated workers with signed attestation and resource/network policy.
3. **Evidence verifier**: store immutable evidence manifests and artifact provenance, then expose only verified summaries to Agent context.
4. **CI/CD adapters**: bind build, test, scan, package, deploy, canary, and rollback evidence to one commit and task.
5. **Release policy**: require review, security, environment, and delivery evidence before promotion; deny by default and support human takeover.

## 6. Explicit non-goals

This repository does not claim that the local HMAC test secret is a production trust root, that local execution is a Server Gate, or that a payment system was deployed. Those are integration acceptance criteria for the platform repository.
