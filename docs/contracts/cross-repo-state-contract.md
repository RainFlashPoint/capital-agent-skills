# Cross Repository State Contract

This contract separates three facts that must not be collapsed into one status:

| Projection | Authority | Meaning |
|---|---|---|
| `localExecution` | repository `.cap/STATE.md` | What the local Skills client should do next |
| `serverDelivery` | Server Unified Task | What the organization has accepted as delivery evidence |
| `serverAction` | Server Harness Action | The exact Commit and verification/review execution state |

`workflow` is a compatibility summary only. A local PASS, a successful command, or a finished Skills session cannot become a Server Gate without matching Server evidence for the exact Commit.

Every delivery identity is the tuple `repo_url + branch + task_id + commit_sha`; idempotency keys must include the same identity. Ordinary Commit Delivery records evidence only. `delivery_candidate=true` is reserved for the final remotely visible Commit and must create or reuse one Test Action bound to that Commit. A successful Test Action is required before Review; stale Actions are superseded when a newer candidate Commit is accepted.

Local explicit mode and one-task fallback may continue without Server writes. They must label evidence as local and may not claim Server Gate PASS. Failed Server writes remain in the task-scoped Outbox until acknowledged; Outbox presence is not proof of delivery.

