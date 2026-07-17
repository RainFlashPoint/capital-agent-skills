# Codex runtime adapter

> updated: 2026-06-17

This adapter is data, not a skill. It defines how the cap playbooks map their portable contracts onto Codex runtimes without depending on Claude-only APIs.

## Interface map

| cap interface | Codex implementation | Fallback |
|---|---|---|
| User choice | Use a native structured-input tool only when it is exposed and allowed by the current mode | `text_mode`: numbered plain-text options; stop at the gate and wait |
| Multi-agent fan-out | Use Codex multi-agent tools only when explicitly available | Sequential inline execution of the same playbook |
| Parallel shell/file reads | `multi_tool_use.parallel` is safe for read-only commands | Sequential `rg`/`sed`/`git` reads |
| File edits | `apply_patch` for manual text edits; target scripts for mechanical writes | No shell heredocs or ad hoc file writes |
| Long document review | `web-review` file mode or Live mode with blocking `/wait` | Plain text review gate |
| Headless/non-interactive | Do not ask questions; write `needs-human` and choose the safe default | Block rather than accepting risk |
| Cross-model adversary | Do not call `codex` from inside Codex | Run the adversarial pass inline |

## Multi-agent adapter

Codex may expose different orchestration tools across environments. Treat them as an optional implementation detail behind the cap `Task-or-sequential` interface.

1. If a true sub-agent tool is available, fan out only to independent units that write disjoint files.
2. If only `multi_tool_use.parallel` is available, use it for read-only evidence gathering, not as a replacement for independent writing agents.
3. If no multi-agent tool is available, run each role, mode, focus, or phase sequentially in the current session and write the same per-unit output files.
4. The orchestrator remains the only writer for shared state files such as `.cap/STATE.md`.

Before any write fan-out, run a deterministic write-set preflight. For build waves, compute each phase's planned `files` set from `plan.md`; if two same-wave phases intersect, do not fan out. Either downgrade to sequential execution or return to `cap-plan` to repair the wave assignment.

## User-choice adapter

Codex sessions do not always permit structured choice widgets. Every gate must therefore have a plain-text representation:

```text
我需要你选一个:
  1) 选项 A — 说明
  2) 选项 B — 说明
回复编号即可。
```

Rules:
- Use structured input only when the tool is present and the current collaboration mode allows it.
- In normal interactive mode, stop at approval gates until the user answers.
- In headless mode, never prompt. Mark the item `needs-human`, use the safe default, and keep the gate blocked when risk acceptance would be required.
- Do not run two active feedback channels at once. If `web-review` Live mode is waiting on `/wait`, defer terminal questions until that wait returns.

## Handoff adapter

Stage playbooks produce a machine-readable `## HANDOFF` block. The cap-flow driver is the canonical writer of `.cap/STATE.md`.

```markdown
## HANDOFF
stage: <stage>
status: in-progress | gated | blocked
checks: [...]
active-roles: [...]
changed-files:
- <path>
gates-passed:
- <gate>
decisions:
- <date> <decision>
next-action: -> invoke <cap-stage>
```

Standalone stage execution may write `.cap/STATE.md` only when no driver is active; in that case it must still use the same `## HANDOFF` schema first, then apply it as the single writer.

## Discovery adapter

For repository-local Codex discovery, maintain `.agents/skills/cap*` symlinks that point at the writable skill source or installed skill directories. After adding or changing these links:

```bash
for skill in .agents/skills/cap*; do
  readlink "$skill"
done
```

If the current Codex session was already running, a new session may be required before the skill registry sees new links.
