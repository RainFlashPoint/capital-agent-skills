# Deploy Target Adapter: Static Site (Vercel primary / Netlify)

Thin adapter for the **static-site** target type. Owns the command + rollback *skeleton*;
stays language-agnostic — the **build artifact comes from the language pack's build
command** (e.g. `pnpm build`, `npm run build`). This card only knows how to *push the
output up* and move traffic between environments. Every project-specific value is a
`<placeholder>` the runtime resolves from the target repo.

> Methodology (deploy → smoke/health → gate → promote/rollback) lives in the generic
> layer. This file only supplies the static-site-shaped command skeletons.
> Flags below verified against **Vercel CLI 54.9.1** (`vercel <cmd> --help`, 2026-06-05).

---

## Placeholders — resolve at runtime, never hardcode

Extract these from the target project, do **not** invent them:

| Placeholder | Resolve from |
|---|---|
| `<project>` | `vercel.json` (project name) / `.vercel/project.json` / `PROFILE.Deploy.project` |
| `<scope>` | Vercel team/org slug — `PROFILE.Deploy.team` / `.vercel/project.json` `orgId` |
| `<output-dir>` | build output dir — `vercel.json` / framework default (`dist`, `.next`, `build`) |
| `<prod-domain>` | the production alias/custom domain — `vercel.json` / `PROFILE.Deploy.domain` |
| `<canary-domain>` | dedicated canary alias host — `PROFILE.Deploy.canaryDomain` (optional) |
| `<health-path>` | `PROFILE.Deploy.healthPath` (default `/`, SPA: a known route; or a `/healthz` static file) |
| `<netlify-site>` | `netlify.toml` / `PROFILE.Deploy.netlifySite` (Netlify path only) |

**Secrets rule:** Vercel/Netlify tokens (`$VERCEL_TOKEN`, `$NETLIFY_AUTH_TOKEN`) and any
build-time env vars live **only in the deploy environment or local shell**. Reference via
env or the provider's encrypted env store (`vercel env`). Never write a real token, custom
env value, or `.vercel`/`.netlify` credential into this file, the repo, or build output.
`-t/--token $VERCEL_TOKEN` and `-S/--scope <scope>` make every call non-interactive in CI.

---

## 0. Build the artifact (owned by the language pack, shown for context)

```bash
# Language pack runs the project's real build — NOT this adapter's job:
<pkg> install            # e.g. pnpm install / npm ci
<pkg> build              # e.g. pnpm build / npm run build  → emits <output-dir>/
```

Two ways to hand the artifact to Vercel — pick per `PROFILE.Deploy`:

- **Remote build (default):** push source, let Vercel build. Simplest; needs Vercel env vars configured.
- **Prebuilt:** build locally with `vercel build`, then `vercel deploy --prebuilt` to upload
  the already-built `.vercel/output`. Use when CI already built, or to keep build off Vercel.

```bash
# Prebuilt path (optional): produce .vercel/output locally
vercel build --yes                 # add --prod to build a production target
vercel build --prod --yes
```

---

## 1. Environment mapping (the core of the static-site model)

| Pipeline stage | Vercel concept | How |
|---|---|---|
| `dev` | local | language pack dev server (`<pkg> dev`) — not a Vercel deploy |
| `staging` | **preview** deployment | `vercel deploy` (no `--prod`) → unique preview URL |
| `canary` | preview pinned to a canary alias | `vercel deploy` → `vercel alias set <url> <canary-domain>` |
| `full` | **production** | `vercel deploy --prod` *or* `vercel promote <url>` of the gated preview |

> Every Vercel deploy is immutable and addressable by its own URL — that *is* the rollback
> primitive (no artifact to rebuild). Capture each deploy URL; promote/alias moves traffic
> without redeploying.

---

## 2. Deploy per environment (Vercel — primary)

```bash
# staging = preview deploy. Capture the printed URL = the gate's subject under test.
STAGING_URL=$(vercel deploy --yes \
  --scope <scope> --token "$VERCEL_TOKEN" \
  -m stage=staging -m sha="$(git rev-parse --short HEAD)")
# (add --prebuilt if you ran `vercel build` in step 0)

# canary = same preview deploy, then move the canary alias onto it
CANARY_URL=$(vercel deploy --yes --scope <scope> --token "$VERCEL_TOKEN" -m stage=canary)
vercel alias set "$CANARY_URL" <canary-domain> --scope <scope> --token "$VERCEL_TOKEN"

# full = production. Either deploy straight to prod...
PROD_URL=$(vercel deploy --prod --yes --scope <scope> --token "$VERCEL_TOKEN")
# ...or PROMOTE the already-gated canary/preview deployment to production (no rebuild):
vercel promote "$CANARY_URL" --yes --scope <scope> --token "$VERCEL_TOKEN"
```

Useful flags (verified): `--prebuilt` (deploy `.vercel/output` from `vercel build`),
`--skip-domain` (deploy prod build but DON'T auto-alias yet — gate first, then `vercel promote`),
`--no-wait` (don't block), `-F json`/`--format json` (machine-readable output for capturing the URL).

> **Gate-before-promote pattern:** `vercel deploy --prod --skip-domain` builds the production
> deployment but withholds the domain alias; run smoke/health against the returned URL, and
> only `vercel promote <url>` (or `vercel alias set`) on pass. Clean fit for the canary→full gate.

**Env mapping:** dev → staging → canary → full differ only by `--prod`/`--skip-domain` and
which alias (`<canary-domain>` vs `<prod-domain>`) gets moved — same deploy skeleton.

---

## 3. Get the preview / deployment URL

```bash
# Capture directly from deploy stdout (Vercel prints the URL as the last line):
URL=$(vercel deploy --yes --scope <scope> --token "$VERCEL_TOKEN")

# Or list recent deployments for a project (machine-readable):
vercel list <project> --scope <scope> --token "$VERCEL_TOKEN" -F json
# filter by status: --status READY ; by env: --environment preview|production

# Inspect one deployment (state, aliases, logs):
vercel inspect "$URL" --scope <scope> --token "$VERCEL_TOKEN"        # add -l for build logs
```

---

## 4. Rollback (the gate's "fail" branch)

Static deploys are immutable, so rollback = **point traffic at the last known-good
deployment** — no rebuild.

```bash
# Fastest: revert to the immediately previous production deployment
vercel rollback <prev-deployment-url-or-id> --yes \
  --scope <scope> --token "$VERCEL_TOKEN"
vercel rollback status <project> --scope <scope> --token "$VERCEL_TOKEN"   # confirm it converged

# Equivalent (explicit alias control): re-point the prod alias to the last-good deployment
vercel alias set <prev-deployment-url> <prod-domain> \
  --scope <scope> --token "$VERCEL_TOKEN"

# Canary fail: re-point (or remove) the canary alias, leave production untouched
vercel alias set <prev-good-url> <canary-domain> --scope <scope> --token "$VERCEL_TOKEN"
# or: vercel alias remove <canary-domain> --scope <scope> --token "$VERCEL_TOKEN"
```

**Precondition:** capture `<prev-deployment-url>` (the last *passing* prod/canary deploy)
**before** each promote. Vercel retains prior deployments, so the target stays addressable;
record its URL/ID rather than relying on "the one before".

> Note: `vercel rollback` reverts to the *previous* production deployment by default, or to a
> specific `url|deploymentId` you pass — verified via `vercel rollback --help`.

---

## 5. Smoke / health (probe after deploy, before gate)

Probe the just-deployed URL (or the alias for canary/prod) from outside:

```bash
# Per stage, probe the URL captured in step 2/3:
curl -fsS --max-time 10 "$STAGING_URL/<health-path>"          # staging: the preview URL
curl -fsS --max-time 10 "https://<canary-domain>/<health-path>"   # canary alias
curl -fsS --max-time 10 "https://<prod-domain>/<health-path>"     # full / production
# non-2xx → curl -f exits non-zero → gate fails
```

> Static sites have no `/health` endpoint by default. Either ship a tiny static
> `<output-dir>/healthz` (or `health.json`) file, or smoke a real known route plus an asset
> (`curl -fsS .../ && curl -fsS .../assets/<known-built-file>`) to catch broken builds.
> For SPAs also assert the HTML actually contains an app-root marker, not just a 200.

---

## 6. Netlify path (alternative provider)

Same environment model; different CLI. Resolve `<netlify-site>` from `netlify.toml`.
**Not re-verified here — confirm flags against `netlify deploy --help` at runtime.**

```bash
# staging = preview (draft) deploy → prints a unique deploy URL
netlify deploy --dir <output-dir> --site <netlify-site> --json     # add --build to build first
# (auth via $NETLIFY_AUTH_TOKEN in env; --message "stage=staging sha=$(git rev-parse --short HEAD)")

# full = production deploy
netlify deploy --prod --dir <output-dir> --site <netlify-site>

# Rollback: Netlify keeps deploy history; restore a previous published deploy.
# CLI surface for restore varies by version — confirm with `netlify deploy --help` /
# `netlify rollback --help` (needs confirm), or use the API/UI "publish deploy" on the
# last-good deploy id. Capture <prev-deploy-id> before each prod publish either way.
```

> Canary on Netlify: no first-class slice. Use branch/preview deploys + Netlify split-testing
> (config-level), or alias a branch deploy — **project-specific, confirm at runtime**.

---

## Runtime resolution checklist

Before running any command above, resolve placeholders by reading the target repo:

1. `vercel.json` (+ `.vercel/project.json` if present) → `<project>`, `<scope>`/orgId, `<output-dir>`, domains.
2. `PROFILE.Deploy` / `CLAUDE.md` → provider (Vercel vs Netlify), `<prod-domain>`, `<canary-domain>`, build/prebuilt choice, `<health-path>`.
3. Language pack → the real build command emitting `<output-dir>` (this adapter does not build).
4. Token + scope → `$VERCEL_TOKEN`/`$NETLIFY_AUTH_TOKEN` from the deploy env; record `<prev-deployment-url>` before every promote for rollback.
