# 部署目标适配器:Container(Docker → registry → K8s / 云容器)

cap-release 在 `目标类型 = container` 时加载的**命令骨架**卡。薄:只给命令骨架 + 回滚骨架,
语言无关(语言差异由项目的 Dockerfile 吸收)。所有项目特定值都是 `<占位>`,运行时从目标仓解析。

> 晋级门方法论(deploy → smoke/health → 门 → 晋级 / 回滚)在 cap-release 主流程,本文不重复;
> 本文只提供 container 形态的命令骨架。

---

## Placeholders — resolve at runtime, never hardcode

Extract these from the target project, do **not** invent them:

| Placeholder | Resolve from |
|---|---|
| `<registry>` | `PROFILE.Deploy.registry` / Dockerfile push target / CI config |
| `<image>` | `PROFILE.Deploy.image` / repo name |
| `<tag>` | git sha / version (`$(git rev-parse --short HEAD)`) per env |
| `<deployment>` | k8s manifests `metadata.name` (Deployment) |
| `<container>` | k8s manifests `spec.template.spec.containers[].name` |
| `<namespace-ENV>` | k8s manifests / `PROFILE.Deploy.namespaces` per environment |
| `<context-ENV>` | kubeconfig context per cluster/env |
| `<health-path>` | `PROFILE.Deploy.healthPath` / k8s probe `httpGet.path` (default `/health`) |
| `<service-host>` | per-env ingress/service host |

**Secrets rule:** registry creds, kubeconfig tokens, API keys live only in the deploy
environment or local shell. Reference via env (`$REGISTRY_TOKEN`) or a secrets manager.
Never write a real value into this file, the repo, or an image layer.

---

## 1. Build → tag → push image

Language differences are absorbed by the project's `Dockerfile` (multi-stage, non-root,
`HEALTHCHECK`). This adapter only drives build/tag/push — identical across languages.

```bash
# Build (pin platform for cross-arch CI; --build-arg for build-time config, never secrets)
docker build \
  --platform linux/amd64 \
  -f <dockerfile-path> \
  -t <image>:<tag> \
  .

# Tag for the registry + the per-env moving tag
docker tag <image>:<tag> <registry>/<image>:<tag>
docker tag <image>:<tag> <registry>/<image>:<ENV>   # e.g. staging / canary / latest

# Auth via env-injected creds, then push (immutable sha tag + env tag)
echo "$REGISTRY_TOKEN" | docker login <registry> -u "$REGISTRY_USER" --password-stdin
docker push <registry>/<image>:<tag>
docker push <registry>/<image>:<ENV>
```

> One-shot build+push alternative (buildx): `docker buildx build --platform linux/amd64 -t <registry>/<image>:<tag> --push .`

**Env mapping:** each environment = a distinct `<tag>` (always pin the immutable sha)
plus a moving env tag, deployed into a distinct `<namespace-ENV>` / `<context-ENV>`.

> **⚠ Registry/cluster region alignment — flag BEFORE pushing.** Pulls are fast & private
> only when `<registry>` is in the **same region** as the cluster. A cross-region registry
> otherwise surfaces later as a stuck `ImagePullBackOff` / slow pull with **no obvious cause** —
> the user just sees it hang and can't tell why. So:
> - Resolve the registry region from `PROFILE.Deploy` and compare to the cluster region.
> - **Differ → tell the user up front**, and pick one: push to a **same-region** registry, OR
>   use the registry's **public/internet endpoint** so the cluster can still pull (slower + egress cost),
>   OR enable registry cross-region replication.
> - On managed registries the **intra-region (VPC) endpoint** is the private, free, fast path —
>   prefer it when registry and cluster share a region.

Pick **one** path based on what the target repo ships.

> **Precondition (idempotent) — ensure the namespace exists before apply.** Check, then
> create-if-missing; **never auto-delete a namespace** (deleting cascades every resource in it).
> Use only the name the manifests/`PROFILE` declare — don't invent one.
> ```bash
> kubectl --context <context-ENV> get namespace <namespace-ENV> \
>   || kubectl --context <context-ENV> create namespace <namespace-ENV>
> ```

### Path A — Kubernetes (manifests present)

```bash
# Declarative apply of env-scoped manifests (preferred when manifests are version-controlled)
kubectl --context <context-ENV> -n <namespace-ENV> apply -f <k8s-manifests-dir>/

# OR imperative image bump of an existing Deployment
kubectl --context <context-ENV> -n <namespace-ENV> \
  set image deployment/<deployment> <container>=<registry>/<image>:<tag>

# Wait for rollout to converge — this is the deploy gate (non-zero exit = failed deploy)
kubectl --context <context-ENV> -n <namespace-ENV> \
  rollout status deployment/<deployment> --timeout=180s
```

### Path B — Cloud container service (no raw K8s)

Use the project's documented CLI; `PROFILE.Deploy` names the provider. Shape only:

```bash
# <cloud-deploy-cmd> --service <service-ENV> --image <registry>/<image>:<tag>
# then poll the provider's service-state/health until "stable" before gating.
```

**Env mapping:** dev → staging → canary → full differ only by
`<context-ENV>` / `<namespace-ENV>` (or `<service-ENV>`) and `<tag>` — same skeleton.

---

## 2.5 Expose — every deploy must end with an address the caller can hit

A rollout that leaves only a `ClusterIP` Service is **in-cluster only** — the user "deployed
successfully" but then can't reach it and is stuck. **Don't stop at ClusterIP.** Provision a
`LoadBalancer` Service so the deploy yields a concrete **IP** the user can hit directly, no extra
steps. Default to an **internal/intranet** LB unless public exposure was explicitly requested.

```bash
# LoadBalancer Service → provider provisions an LB and assigns an IP
kubectl --context <context-ENV> -n <namespace-ENV> expose deployment/<deployment> \
  --name <svc> --port <port> --target-port <container-port> --type LoadBalancer

# Internal/intranet IP (reachable inside the VPC, NOT public) — add the provider's
# internal-LB annotation; it is provider-specific, resolve from PROFILE. Examples:
#   Alibaba ACK : service.beta.kubernetes.io/alibaba-cloud-loadbalancer-address-type: intranet
#   AWS EKS     : service.beta.kubernetes.io/aws-load-balancer-internal: "true"
#   GCP GKE     : networking.gke.io/load-balancer-type: "Internal"
kubectl --context <context-ENV> -n <namespace-ENV> annotate svc <svc> <internal-lb-annotation>

# Wait until the IP is assigned (EXTERNAL-IP stops showing <pending>), then read it
kubectl --context <context-ENV> -n <namespace-ENV> get svc <svc> -w
```

**Finish by handing the user the resolved `<IP>:<port>`** (or domain if Ingress) and a one-line
verify, e.g. `curl -fsS http://<IP>:<port>/<health-path>`. Access should require nothing further.

> No-LB fallback (cluster can't provision an LB): `NodePort` + a reachable node IP, or
> `kubectl port-forward` for a quick check — but state clearly it's a fallback, not the delivered address.
> `<pending>` forever on EXTERNAL-IP → the LB didn't provision (RAM/perms or wrong address-type
> annotation); see the generic methodology's exposure-chain checks.

---

## 3. Canary (line per environment, applied at the canary stage)

Two skeletons; the target repo's setup decides which.

### Replica-ratio canary (plain K8s, no mesh)

Run a separate canary Deployment behind the **same** Service selector; scale the ratio.

```bash
# Stand up canary at new tag, small replica count
kubectl --context <context-canary> -n <namespace-canary> \
  set image deployment/<deployment>-canary <container>=<registry>/<image>:<tag>
kubectl --context <context-canary> -n <namespace-canary> \
  scale deployment/<deployment>-canary --replicas=1      # e.g. 1 canary : N stable

kubectl --context <context-canary> -n <namespace-canary> \
  rollout status deployment/<deployment>-canary --timeout=120s
# Gate on canary health/metrics, THEN ramp stable to <tag> (Path A) and scale canary to 0.
```

### Traffic-split canary (service mesh / weighted routing)

```bash
# Apply a weighted route (e.g. 95% stable / 5% canary) via the mesh's CRD/manifest.
kubectl --context <context-canary> -n <namespace-canary> apply -f <canary-route>.yaml
# Gate, then re-apply with higher canary weight, finally 100% → promote.
```

---

## 4. Rollback (the gate's "fail" branch)

```bash
# Fastest: undo the last rollout (Deployment revision history)
kubectl --context <context-ENV> -n <namespace-ENV> rollout undo deployment/<deployment>

# Or pin back to a known-good previous tag (keep <prev-tag> from the last passing deploy)
kubectl --context <context-ENV> -n <namespace-ENV> \
  set image deployment/<deployment> <container>=<registry>/<image>:<prev-tag>

# Confirm the rollback itself converged
kubectl --context <context-ENV> -n <namespace-ENV> \
  rollout status deployment/<deployment> --timeout=180s

# Canary fail: scale canary to 0 (or re-apply 100%-stable route), keep stable untouched
kubectl --context <context-canary> -n <namespace-canary> \
  scale deployment/<deployment>-canary --replicas=0
```

> Cloud Path B rollback: redeploy the previous `<prev-tag>` via `<cloud-deploy-cmd>`,
> or use the provider's "rollback to previous revision" command.

**Precondition:** the previous image tag must still exist in `<registry>` (immutable
sha tags make this reliable). Capture `<prev-tag>` before every promote.

---

## 5. Smoke / health (probe after deploy, before gate)

Probe the live `<health-path>` from outside the cluster (post-rollout):

```bash
curl -fsS --max-time 5 "https://<service-host>/<health-path>"   # non-2xx → curl -f exits non-zero → gate fails
```

Or in-cluster against the Service:

```bash
kubectl --context <context-ENV> -n <namespace-ENV> \
  run smoke-$RANDOM --rm -i --restart=Never --image=curlimages/curl -- \
  curl -fsS --max-time 5 "http://<service>.<namespace-ENV>.svc/<health-path>"
```

> K8s liveness/readiness probes (in the manifests) gate pod readiness during rollout;
> this external smoke check gates the *pipeline*. Both target `<health-path>`.

---

## Runtime resolution checklist

Before running any command above, resolve placeholders by reading the target repo:

1. `Dockerfile` (+ `.dockerignore`) → `<dockerfile-path>`, exposed port, health path.
2. k8s manifests dir → `<deployment>`, `<container>`, probe path, per-env `<namespace-ENV>`.
3. `PROFILE.Deploy` / `CLAUDE.md` → `<registry>`, `<image>`, provider, contexts, env→namespace map.
4. Tag policy → `<tag>` = immutable git sha; record `<prev-tag>` for rollback.
