# Deterministic eval fixtures

Each JSON scenario binds one public trust risk to a deterministic repository check. The runner emits `liveModel.status = not-run`; live model or private Server results must be added as separate evidence, never inferred from these fixtures.

Run all scenarios:

```bash
node scripts/eval-cap.mjs --markdown
```
