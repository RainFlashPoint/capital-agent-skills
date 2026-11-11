---
updated: 2026-10-13
distilled-from:
  - session:semantic-context-compaction-2026-10-13
  - https://developers.openai.com/api/docs/guides/deployment-checklist#leverage-compaction
  - https://learn.chatgpt.com/docs/app-server#api-overview
  - https://platform.claude.com/docs/en/build-with-claude/context-editing
---

# Priority-aware semantic compaction

Use this protocol when a long-running task approaches its context limit, crosses a stage boundary, or must survive a provider-native compaction. Its purpose is to reduce replay cost without changing intent, authorization, evidence strength, or task identity.

This is a `cap-flow` capability, not a new lifecycle stage or top-level Skill.

## Two parallel states

Keep two states separate:

1. **Provider-native machine state** — the runtime's compact payload or context-editing state. Pass it through exactly as the provider produced it. Do not parse, rewrite, merge, or treat it as auditable evidence.
2. **Auditable semantic checkpoint** — a provider-neutral record of the facts that must survive compaction. It carries source references, trust, task/Commit scope, invalidation rules and supersedes lineage.

Native compaction keeps the model running. The semantic checkpoint keeps the task trustworthy. Neither replaces `.cap/STATE.md`, Context Guard, Server Gate, source artifacts, or Git history.

## Storage contract

Store active checkpoint data under:

```text
.cap/context/
├── atoms.jsonl       # append-only change log; each event records a complete atom revision
├── checkpoint-<id>.json # immutable validated snapshot
├── summary.md        # human-readable projection; never an authority source
└── manifest-<id>-<phase>.json # immutable checkpoint/event bindings; STATE selects current path
```

The directory follows the repository's active `.cap` tracking policy. Do not store secrets, credentials, raw provider compact payloads, or full tool output. `sourceRefs` point to existing user messages, Git objects, Server Actions, or bounded artifacts instead of copying their bodies.

`checkpoint.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "identity": {
    "taskId": "task_...",
    "repo": "owner/repo",
    "branch": "feature/example",
    "commit": "<full Git object id>",
    "stage": "implement"
  },
  "atoms": [
    {
      "id": "intent-1",
      "type": "intent",
      "assertion": "Implement the approved behavior",
      "protection": "P0",
      "priority": 100,
      "scope": { "taskId": "task_...", "repo": "owner/repo", "branch": "feature/example", "commit": "<full Git object id>" },
      "sourceRefs": ["user-message:42"],
      "trust": "user-authorized",
      "status": "active",
      "certainty": "confirmed",
      "recoverability": "irrecoverable",
      "invalidation": ["task identity changes"],
      "supersedes": []
    }
  ]
}
```

An atom ID is immutable. A stronger or changed claim becomes a new atom that names the old ID in `supersedes`; do not mutate local evidence into Server evidence or rewrite an unknown claim as confirmed in place.

Every prior atom remains in later snapshots, even when invalidated, superseded or omitted from replay. Deleting a terminal authorization/evidence record could let its original ID reappear without its revocation in a later snapshot. Reduce replay through tier planning; keep historical records cold rather than removing them from the audit chain.

Retain ancestor atoms in subsequent snapshots with their superseded/invalidated status; the planner keeps them cold. Never erase existing supersedes edges. `scopeBinding: task` allows intent/constraints/decisions and other non-evidence facts to retain their original Commit provenance across Commit updates, while still binding Task/repo/branch. Authorization and evidence remain Commit-bound; a new Commit expires their prior active status and requires new scoped authorization/evidence before use. The atom log contains full revisions, preserves immutable identity/source/lineage, and its latest revisions must reproduce all checkpoint atoms.

## Protection and dynamic priority

Protection uses five levels, `P0–P4`. It is a semantic floor; priority is a dynamic ordering within that floor.

| Level | Meaning | Default treatment |
|---|---|---|
| `P0` | Intent, task/repo/branch/Commit identity, prohibitions, active authorization boundaries, security constraints | Always hot; overflow fails closed |
| `P1` | Accepted decisions, active blockers/unknowns, next actions, invariants, current acceptance criteria | Hot when possible, otherwise warm |
| `P2` | Source-backed evidence indexes, validated implementation facts, reusable context | Hot only when budget and current action justify it; otherwise warm |
| `P3` | Recomputable exploration, narrative, superseded working notes | Cold |
| `P4` | Chitchat, duplicates, formatting chatter and obsolete narration | Dropped from replay |

Recompute `priority` from 0–100 when the stage, current action, evidence or identity changes. Raise priority for current-action relevance, authority, risk, dependency fan-out and low recoverability; lower it for staleness, easy recomputation and duplication. Dynamic scoring may promote an atom's replay tier but must not silently lower a `P0` protection floor or upgrade its trust/certainty.

Source coverage includes a reviewed semantic `category` and `minProtection`. External-operation/authorization boundaries (including invalidation and rollback limits), identity, prohibitions and security require P0; decisions, acceptance and next actions require at least P1. Ordinary paths and implementation detail default to P2, not blanket P0. In spec/plan, use a meaningful known heading or `<!-- cap-semantic: prohibition -->` for a protected section; the category inherits into subsections. Set `atom.semanticCategory` when the type alone does not express its protection requirement. The validator enforces explicit categories and known types; it cannot infer arbitrary business prose or prove paraphrase accuracy. Review uncategorized detail against original user intent. A misspelled category fails closed. P0 inflation produces review candidates, never automatic downgrades or deletion of prior intent/lineage.

Hot content is replayed directly. Warm content is retained by reference and fetched only when needed. Cold content remains recoverable from artifacts or Git but is not replayed. Dropped content is intentionally omitted from future model context; authoritative source artifacts remain untouched.

New manifests declare `plan.replayVersion: 1`. Only exact semantic duplicates are coalesced in the replay projection; all original atom IDs remain in the checkpoint, coverage, log and tier lists. A replay group retains `coveredAtomIds` and the union of source references. Type, assertion, protection, scope/binding, trust, certainty, invalidation, lineage and all other semantic metadata must agree; only IDs, sources, priority and token estimates may differ. Group priority uses the highest member priority; budgeting includes the projected IDs and sources. No fuzzy paraphrase match may delete or merge authorization. Review repeated prose against original sources and use one accurate canonical assertion when justified. Legacy manifests without a replay version retain their original planning and receipt semantics. Receipts bind the exact versioned projection, including group membership and every source.

## CLI recovery pages

The CLI returns `recovery-paged` metadata instead of printing the complete receipt. Read every page in order with `read-recovery <repo> --event <event> --digest <digest> --sha256 <recovery.sha256> --page <1-based index>`. The CLI validates the complete receipt SHA-256 against this expected value on each read and returns one bounded page with its `pageSha256`. Read each page in a separate tool response, verify its page hash, and review all hot atoms and needed warm references across the pages. Do not print the concatenated receipt, a full hot-atom JSON dump, or several pages in one tool response: that recreates the truncated output this protocol prevents. A missing page, failed read, mismatched hash, or truncated output leaves recovery incomplete. Retry the failed page rather than inferring missing content. The complete receipt stays on disk and remains bound to the manifest.

A repeated `resume` for the same verified event returns compact reuse metadata without another STATE write or receipt. A newly compacted model context must still read the saved pages. `prepare` returns compact reuse for an unchanged binding; when it creates a new recovery receipt, use the same page protocol.

## Trigger policy

Pressure is `used tokens / provider context window`. Default thresholds are configurable but ordered:

| Pressure | Default | Required action |
|---|---:|---|
| low | `< 55%` | Normal on-demand loading; update atoms only when semantics change |
| medium | `55–<70%` | Refresh and validate the checkpoint; deduplicate P3/P4 |
| high | `70–<82%` | Run a context plan, keep P0/P1 hot, demote source-backed detail to warm/cold, write manifest |
| critical | `≥ 82%` | Validate a final checkpoint, invoke provider-native compaction when exposed, then restore from the validated checkpoint |

Also checkpoint independent of token pressure:

- before and after a stage handoff;
- before a provider-native compaction or context-editing event;
- when Task/repo/branch/Commit identity changes;
- when authorization is granted, narrowed, revoked or invalidated;
- when authoritative evidence changes an unknown or supersedes a decision;
- before loading tool output large enough to displace P0/P1 context.

The Skill cannot remove tokens already loaded unless the runtime exposes compaction. When no compaction hook exists, preserve the checkpoint and use the next safe stage/new-session handoff to rebuild minimal context.

## Validation and planning

### Executable entry detection

Resolve this file and all tools through the current loaded `cap` entry's `scripts/cap-package.mjs`; package-relative paths below never refer to installation siblings or a searched old worktree. A missing resource is an installation error, not permission to use another version.

`scripts/cap-context-gate.mjs` is the shared read-only detector used by status, POSIX/Node Context Guard and `cap-execute run`. For an initialized active Task with task-context, entering plan/implement/test/review/release requires a current bound manifest. Status exposes `contextGate` and automatic `create_context_checkpoint`, `refresh_context_checkpoint` or `recover_context_checkpoint` actions; the stage and execution entries fail before proceeding. Resolve these local actions within existing authorization, then retry; do not ask the user to run scripts or approve checkpoint generation.

Create the semantic atoms from reviewed original sources, retain the predecessor and history, then add `--bind-entry <repo>` to `create-manifest`. This binds the manifest to the current Task/Session/repo/branch/Commit/stage, source fingerprint and a hash of the full task-context, existing spec/plan, STATE authorization, decisions, evidence gates and next action. Publish the STATE checkpoint path/digest/manifest pointer together with `context-previous-manifest` and `context-previous-digest` from the new manifest entry, only after validation. These pointer fields and STATE `updated` are excluded from the input hash so publication does not invalidate itself. An older unbound manifest is retained and migrated on the first guarded entry. Execution uses the same effective stage selected by `stage`, `action`, then STATE as its recorder.

Binding detects changed inputs; it does not establish semantic coverage or authenticate user authorization. Reconcile changed protected facts with the atom set before binding. No detector synthesizes authorization, facts or Provider success. Resolve original messages and receipts before authority-sensitive actions.

### Source coverage before publication

An initial checkpoint must have active P0/P1 intent, constraint, acceptance criterion and next-action atoms. The bound entry additionally inventories the original task intent, each external-boundary and impact line, each STATE authorization/decision/gate/next-action line, and the substantive sections of spec/plan. Map **every** inventory ID to an active atom of an allowed type with the exact file-backed semantic source reference. The `coverage` array records `{ "id": "<inventory hash>", "atomIds": ["<atom id>"] }`; the referenced atom must cite the requirement's `sourceRef`. Review each assertion against the original source: a hash and a map alone cannot prove that a paraphrase is accurate. Newly observed user corrections belong in task-context/spec before taking another checkpoint. Use `coverage <repo>` to see all obligations, then run the full Context Guard **before** `create-manifest --bind-entry`; this returns all reconnaissance defects together without publishing an unusable manifest. Old bound manifests without coverage require one migration refresh, not a silent PASS.

When the host supplies current `context-used-tokens` and `context-window-tokens`, detection classifies pressure at the default thresholds; an explicit current `context-pressure` may conservatively raise it. Without telemetry, use `unknown` in STATE and manifest rather than inventing counts. Stage, Session, identity, source and semantic-input changes still trigger. Repeated checks of an unchanged binding reuse it without rewriting checkpoints or repeatedly requesting native compaction.

On an observed host compaction/resume event, record a unique `context-recovery-event` in STATE, validate the saved manifest and restore hot atoms plus required warm sources, then bind a new immutable manifest phase to that event. Pending/running/failed Provider requests in either STATE or manifest never unlock recovery. An observed STATE success must match the manifest's success event and declared provider kind; an old success cannot complete a newer event. Native internal compaction without an exposed hook can only be detected when the caller receives the resume/event; entry detection is not a background process and cannot intercept an invisible runtime event.

When the model actually receives a resume summary or a host terminal event, immediately run the local `resume` operation for the locked repo with a unique event reference, **before** reading more source or executing commands. Before replaying any hot atom or writing a receipt, resume runs the same published-snapshot integrity validation as the guarded entry: current raw manifest SHA, canonical artifact paths, recursive predecessor chain, Session/runtime Session, the prior entry receipt and every bound source hash must all pass. Source drift is a refresh classification for a later reviewed prepare, never permission to replay stale evidence during resume. It then returns paged recovery metadata and records a receipt plus event in STATE. Read and verify every page, fetch needed warm sources, then generate a fresh bound manifest; the stage stays blocked until the receipt, checkpoint digest and event all agree. If validation fails, the event still blocks the stage and the original sources must be repaired. An internal compaction with no visible notification remains outside this mechanism; never invent a Provider success.

The checkpoint identity stage is the stage being entered; publish the same stage through HANDOFF. `unknown` manifest pressure is accepted when no observation exists. Standalone unbound manifest validation remains compatible but cannot unlock a guarded stage.

### Preferred recovery and publication entry

After reviewing original sources and preparing an immutable checkpoint, use package `scripts/cap-context-checkpoint.mjs prepare <repo> --checkpoint <repo-relative-checkpoint> --budget-tokens <hot-budget> [--event <unique-visible-event>]`. Finish the current batch of STATE, task-context, spec, plan and source updates before this call; after it passes, do not mutate those inputs before the guarded action, otherwise refresh once from the settled sources. The single writer uses one preflight to collect reconnaissance defects, fully validates the currently published predecessor before either reuse or successor publication, checks coverage floors, generates the frozen atom log, replays the exact candidate hot set when needed, binds its receipt and atomically publishes STATE cursors. New publications declare `integrityVersion: 1`, bind the raw manifest bytes as `context-manifest-sha256`, and bind each direct predecessor manifest SHA in the successor entry; this separates an unchanged manifest observing real source drift from edits to the manifest's own source hashes. A versioned manifest cannot downgrade to legacy by deleting STATE cursors: missing or malformed current/previous manifest SHA fails closed. Only manifests genuinely lacking the integrity-version marker use the legacy compatibility path. Manifest, predecessor-manifest and recovery-receipt cursors are canonical direct children of `.cap/context/`; lexical traversal, empty segments, nested aliases and normalization changes fail before reading. Output gives a receipt path and page count: read and verify every page to recover hot atoms and warm references, then fetch required sources before continuing. An unchanged valid snapshot is reused without extra files. A content-identical candidate under a new filename is canonicalized to the published checkpoint and returns compact reuse metadata instead of creating a duplicate manifest. Identity, Session/runtime Session, predecessor, manifest projection or recovery-receipt integrity failures are not refresh signals and cannot be replaced by a duplicate or different successor. Source/semantic refresh requires observable source drift against a manifest whose own SHA is still bound; receipt reconstruction requires a genuinely newer visible recovery event, while a missing, redirected or damaged receipt for the already-bound event fails closed. Failed preparation leaves the stage blocked and retains a visible event even if other preflight checks fail. Failed/crashed preparation may leave unselected immutable artifacts; these are not published evidence. A busy writer lock requires inspecting the writer before retry, never concurrent STATE edits.

### Unselected artifact cleanup

`prepare` may leave an unselected immutable artifact after a crash or failed
publication. It is not evidence, but it must not be deleted by guessing. Use
`scripts/cap-context-gc.mjs <repo> --json` to build a dry-run plan. The current
STATE-selected manifest chain is the active root; every other recognizable
manifest, including a same-Task branch or a legacy-named manifest, is a
historical root. An unselected manifest alone does not prove that its history
is disposable. Only files referenced by neither set are candidates. Missing
references or a changed source inventory block cleanup. The plan reports
current, historical and candidate files separately, including exact hashes,
sizes and potential duplicate bytes. `--apply` rechecks the plan under an
exclusive writer lock, moves candidates to
`.cap/local-state/garbage/context/<run>/`, and stores identical candidates as
hard links within that quarantine batch. This reduces physical duplicate data
while preserving each filename and its bytes for recovery. It does not change
STATE or touch any manifest chain. Run it before a task boundary/Retire, after
reviewing the dry-run. Historical chains that contain distinct evidence remain
intact; their size needs a separate audited archive/retention policy, not GC.

Quarantine is recoverable working storage, not a permanent archive. After
reviewing the isolation result, run `scripts/cap-context-gc.mjs <repo> --prune --json`
to obtain the exact `planSha256`, file hashes and `reviewForGit` /
`reviewForGitFiles` lists. The latter list reachable context artifacts and present task documents with exact hashes for
human review; it is not permission to publish secrets or inherit a Gate. A
deliberate `--prune --apply --plan-sha256 <reviewed digest>` rechecks the
current and historical roots, isolated file bytes and writer lock before
removing quarantine files. It writes a local prune log. Changed plans,
missing references and unsafe paths fail closed. Retain distinct historical
manifest chains until they receive a separate audited disposition. Count
files after review and choose the project's Git tracking policy for the
retained set; a numeric file target is never a deletion criterion.

### Explicit legacy-chain recovery

When a genuinely old chain has no integrity-version markers and cannot pass current historical source/receipt checks, review original current sources, retain protected predecessor atoms, rebuild current coverage, and write a specific review note as a direct file under `.cap/context/`. Use package `scripts/cap-context-checkpoint.mjs migrate-legacy <repo> --checkpoint <reviewed-current-checkpoint> --budget-tokens <hot-budget> --event <visible-event> --review <repo-relative-review-note>` from the locked repository. This is an explicit compatibility operation, never an automatic retry or a request for repeated user authorization already granted for the task.

The migration seals retained manifests/checkpoints/atom logs/available receipts and the review note into a hash-bound lineage audit. Historical source bytes and incompatible/missing legacy receipts remain **unverified**, never historical PASS. The current candidate must independently pass current identity, coverage, protected transition, hot budget and exact event replay. Read the hot output and required warm references, then rerun the full stage guard. The new root points to the audit; later guards recheck the sealed artifacts and protected transition. Keep the old artifacts in place. Modern integrity-version records, mismatched declared hashes, structural defects, unsafe paths, cycles or resource-budget failures block migration. A failed attempt may leave an unselected audit artifact and still blocks the stage.

Ordinary chain validation is iterative with a bounded node/unique-byte budget; reaching a fixed lifecycle depth is no longer itself an error. Resource limits remain explicit failures, never permission to delete lineage.

Keep exact checkpoint/plan/receipt digest checks. A normal successor after recovery can require replay of its new hot set; `prepare` performs that replay and binding in the same operation instead of asking the model to hand-build intermediate manifests. It does not silently treat an old receipt as evidence for changed content. Legacy `resume` and `create-manifest` remain low-level compatibility operations.

A host adapter that actually observes compaction may supply `CAPITAL_AGENT_CONTEXT_RESUME_EVENT=<unique-event>` to status, guards, execution and prepare. All entries then block until that event has been replayed and bound. `prepare --event` must agree with a supplied host event. This variable is an adapter input, not an installed listener: no callback is added to Codex itself, and an invisible native compaction cannot be intercepted by this Skill. Without an adapter, the public entry's visible-summary rule remains required. Do not scan private rollout payloads or invent events to simulate a callback.

### Removed global Codex callbacks

Capital Agent does not install global PreCompact, PostCompact, PreToolUse or PostToolUse callbacks. Remove prior registrations pointing to `scripts/cap-context-hooks.mjs` from host configuration. The old executable remains an inert compatibility entry point for hosts caching that command: it always continues, reads no repository state, creates no records and emits no registration. Existing private native lifecycle files are historical artifacts and do not gate tools or explicit cap stages.

Native compaction remains the host's responsibility. Inside an explicit cap workflow, use the visible-summary and reviewed checkpoint preparation protocol above. Ordinary chats do not participate in Capital Agent recovery. Do not recreate global callbacks to enforce this workflow.

Use the package-root CLI for deterministic checks. Reserve system/tool/output headroom before assigning the hot budget; token estimates are planning signals, not provider counts. Preserve an immutable predecessor snapshot before replacing a checkpoint:

```text
node scripts/cap-context-checkpoint.mjs validate .cap/context/checkpoint.json
node scripts/cap-context-checkpoint.mjs plan .cap/context/checkpoint.json --budget-tokens <hot-budget>
node scripts/cap-context-checkpoint.mjs transition .cap/context/previous.json .cap/context/checkpoint.json
node scripts/cap-context-checkpoint.mjs create-atom-log .cap/context/checkpoint-2.json --output .cap/context/atoms-2.jsonl
node scripts/cap-context-checkpoint.mjs create-manifest .cap/context/checkpoint-2.json --previous .cap/context/checkpoint-1.json --atom-log .cap/context/atoms-2.jsonl --budget-tokens <hot-budget> --trigger <trigger> --pressure <level> --provider-kind <kind> --provider-status <status> --provider-event <ref|none> --output .cap/context/manifest-2-requested.json
node scripts/cap-context-checkpoint.mjs validate-manifest .cap/context/manifest-2-requested.json
```

Before replacing an existing checkpoint, validate the previous/current transition. The initial checkpoint omits `--previous`; a new checkpoint in a bound Task must reference the currently published snapshot with `--previous`. A new lifecycle manifest for the exact same checkpoint omits `--previous` and retains the preceding manifest link instead. The creator writes an immutable manifest beside the checkpoint and refuses to overwrite an existing file. Checkpoint/log/predecessor paths are manifest-relative and cannot escape its directory; file-backed sources are repository-root-relative and cannot escape the repository. Run these operations from the repository root. Validate the saved manifest; add `--require-recovery` after an observed matching provider success event. Requested/running/failed is insufficient.

Use unique snapshot/log/manifest names for each checkpoint and lifecycle phase. Keep the append-only working log, then freeze a log snapshot for each manifest. After a genuinely observed terminal provider event, the single STATE writer first records its status, kind and event reference; the old entry remains blocked. Then create a separate `manifest-2-succeeded.json` (or `-failed`) against the frozen checkpoint/log and current sources, validate it, and publish only the checkpoint/manifest cursor fields. This order keeps STATE-backed source hashes valid. A subsequent checkpoint uses a new ID and retains its predecessor. Never overwrite a requested manifest to claim success. STATE pointer publication does not change authorization or Gate authority.

All operations emit JSON and exit non-zero on an invalid result. Stable error codes cover at least:

- active `P0` loss without supersedes lineage;
- `unknown` becoming confirmed without a new authoritative source;
- local evidence being relabelled as Server evidence;
- active evidence bound to a different Commit;
- authorization without invalidation conditions;
- decision lineage loss;
- checkpoint/summary self-certification;
- `P0` hot-budget overflow.
- missing, tampered or mismatched manifest/checkpoint/atom-log/source/plan/provider-event bindings.

Failure is a gate: retain the pre-compaction state, repair the atom set or open a new safe handoff. Never solve overflow by dropping `P0`.

## Recovery and audit

After compaction, verify `manifest.json` against the checkpoint digest, then restore hot atoms and STATE pointers. Warm/cold material is read only when the current action needs it. If the Task identity or Commit no longer matches, invalidate affected authorization/evidence atoms and rebuild from authoritative sources.

An audit should be able to answer: what was kept or dropped, why it had that priority, which source supported it, which event superseded it, which identity it applied to, and which provider compaction event followed it. A summary alone cannot answer these questions and therefore cannot certify itself.

SHA-256 bindings detect file drift; because the manifest is editable too, they are not signatures or proof of authority. Source schemes and provider event references are structural checks: resolve the original user message or canonical Server/runtime receipt before relying on a claim for authorization, recovery or an external action. Do not store hidden chain-of-thought; retain concise decisions, rationale, evidence pointers, uncertainty and next actions.

For the canonical `.cap/STATE.md` source, new manifests declare `state-without-cursors-v1`: its hash excludes checkpoint and manifest cursors (including the predecessor pointer), pressure/token telemetry, `updated`, and blank lines. For `.cap/task-context.md`, new manifests declare `task-context-without-inspected-at-v1`: only the `inspected-at` observation timestamp is excluded, while intent, HEAD, fingerprints, boundaries, decisions and impact remain bound. This prevents a timestamp-only freshness check from invalidating otherwise identical semantics; actual code reconnaissance still updates the timestamp and any changed facts together. Authorization, decisions, provider lifecycle and all other semantic fields remain hashed; pressure is compared separately by the entry detector. Legacy sources without a declared projection keep their raw byte hash and legacy semantic binding; unsupported projections fail validation. Derived cursor or observation timestamps cannot serve as authority for a semantic claim.

## Provider references

- OpenAI deployment guidance: <https://developers.openai.com/api/docs/guides/deployment-checklist#leverage-compaction>
- Codex App Server compaction API (`thread/compact/start`): <https://learn.chatgpt.com/docs/app-server#api-overview> (request acceptance is separate from terminal turn/item notifications)
- Anthropic context editing: <https://platform.claude.com/docs/en/build-with-claude/context-editing>
