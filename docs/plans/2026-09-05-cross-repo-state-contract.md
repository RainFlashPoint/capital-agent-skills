# Cross Repository State Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make local execution state, Server delivery state, and Platform projection explicit and consistent, while preventing unrelated commits from being attached to the wrong Task and ensuring candidate delivery creates the required verification chain.

**Architecture:** Keep `.cap/STATE.md` as the local execution cursor. Keep Unified Task and Harness Actions as Server delivery facts. Add explicit source-labelled projections and deterministic commit-scope/identity checks at the Skills→Server boundary; expose both projections in Platform without letting UI infer gates. Preserve local fallback and Outbox as recoverable local mechanisms.

**Tech Stack:** Node.js ESM, Next.js/TypeScript, Server MCP/HTTP services, repository-local `.cap` files, Node test runner.

---

### Task 1: Freeze the cross-repository contract

**Files:**
- Create: `capital-agent-skills/docs/contracts/cross-repo-state-contract.md`
- Test: `capital-agent-skills/scripts/test-cross-repo-contract.mjs`

**Steps:**
1. Document authority, field names, source labels, commit identity, delivery candidate, action chain, fallback, and Outbox semantics.
2. Add deterministic fixtures for local-only, server-backed, pending delivery, candidate waiting for Test, and completed Test/Review states.
3. Run the contract test and confirm it fails for missing required fields.

### Task 2: Harden Skills commit-to-Task identity

**Files:**
- Modify: `capital-agent-skills/scripts/client-delivery.mjs`
- Modify: `capital-agent-skills/scripts/post-commit.mjs`
- Modify: `capital-agent-skills/scripts/cap-status.mjs`
- Test: existing client delivery and status tests plus new identity cases.

**Steps:**
1. Require repository, branch, base commit ancestry, and Task boundary checks before automatic Delivery.
2. Reject or queue commits outside the active Task scope with a structured reason.
3. Preserve idempotency and Outbox behavior for valid commits.
4. Add tests for unrelated same-branch commits, amended commits, and valid descendant commits.

### Task 3: Make local and Server projections explicit

**Files:**
- Modify: `capital-agent-skills/scripts/cap-status.mjs`
- Modify: `capital-agent-skills/skills/cap-flow/references/progress-protocol.md`
- Modify: `capital-agent-server/src/services/stage-protocol.mjs` and task projection code as needed
- Test: status/projection tests in Skills and Server.

**Steps:**
1. Return separate `localExecution` and `serverDelivery` projections with source labels.
2. Only reconcile the local cursor when the Server projection is authoritative for a matching Task and Commit.
3. Add conflict fixtures showing local implementation complete while Server Delivery is pending.
4. Ensure wording never calls local evidence a Server Gate.

### Task 4: Enforce Candidate → Test → Review lifecycle

**Files:**
- Modify: `capital-agent-server/src/services/task-automation.mjs`
- Modify: `capital-agent-server/src/services/task-harness-actions.mjs`
- Test: existing harness/task automation tests plus lifecycle contract cases.

**Steps:**
1. Require a valid candidate Delivery before automatic Test Action creation.
2. Ensure Test Action is bound to the exact candidate Commit and supersedes stale actions.
3. Ensure successful Test produces the expected Review transition and incomplete chains remain non-terminal.
4. Add idempotency, missing-provider, stale-commit, and retry tests.

### Task 5: Present both projections in Platform

**Files:**
- Modify: `capital-agent-platform/src/lib/api.ts`
- Modify: `capital-agent-platform/src/app/tasks/[id]/page.tsx`
- Modify: `capital-agent-platform/src/components/TaskExecutionGraph.tsx`
- Test: Platform type/build checks and focused rendering tests if available.

**Steps:**
1. Consume explicit local/server projection fields from the API.
2. Display local execution, Server delivery, and evidence source separately.
3. Remove UI inference that treats a local status or text as a Server Gate.
4. Verify loading, pending, blocked, and completed states.

### Task 6: Validate, record evidence, and commit each repository

**Steps:**
1. Run Skills tests and contract checks.
2. Run Server tests and contract checks.
3. Run Platform typecheck/build and focused checks.
4. Review diffs and ensure excluded security/audit scope was untouched.
5. Write `.cap/verify/*.md` evidence and commit each repository with its own focused commit.

