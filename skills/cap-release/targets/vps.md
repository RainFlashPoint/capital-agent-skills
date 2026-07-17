<!--
  vps.md — cap-release 目标类型适配器：自有服务器（ssh + systemd）
  ─────────────────────────────────────────────────────────
  三层分工里的【第②层：目标类型适配器】。薄。只给"命令骨架 + 回滚骨架"。
    ① 通用门引擎 = cap-release 主流程（deploy→smoke/health→门）。本文不重复。
    ② 适配器（本文）= 把通用阶段映射成 "ssh 这个目标类型怎么发、怎么重启、怎么回滚"。
       骨架按【目标类型】分（vps / container / static …），不按语言分。
    ③ 项目特定配置 = 运行时从【目标仓】抽，不写进本文：
       主机 / 用户 / release 根路径 / 服务名 / health 路径 / canary 编排细节
       → 全部写成 <占位>，由 cap-release 从目标仓的部署脚本 + PROFILE.Deploy 解析。
  铁律：
    - 命令真实可跑（rsync/ssh/systemctl/ln/nginx flag 对真实 CLI 校验过，别臆造）。
    - 密钥 / SSH key 只在本地或部署环境，绝不入仓；示例一律占位或 env 引用。
    - 本文是纯数据 playbook，不是 skill；引擎 = 一个能跑 Bash(ssh/rsync) 的模型。
  ─────────────────────────────────────────────────────────
-->

# 部署目标适配器 / vps — 自有服务器（ssh + systemd）

> 目标类型 = **你能 ssh 进去的 Linux 主机**，用 systemd 管服务、（通常）nginx 做反代。
> 产物用 **带时间戳的 release 目录 + `current` 软链** 部署，回滚 = 把软链切回上一个 release + 重启。
> 各环境（dev / staging / canary / full）= **不同主机或不同用户**，由 cap-release 从目标仓抽，不在本文写死。

本文是 cap-release 在「目标类型 = vps」时加载的**命令骨架**。所有大写或尖括号的 `<占位>`
都由运行时从【目标仓】解析（来源见每节标注），**绝不在适配器里硬编码项目值**。

---

## 0. 运行时要先抽的项目特定值（全是 `<占位>`）

cap-release 进入本阶段前，从目标仓按下表解析；解析不到就停下问人，**不要猜主机/路径**。

| 占位 | 含义 | 抽取来源（优先级从高到低） |
|---|---|---|
| `<SSH_HOST_dev/staging/canary/full>` | 各环境主机（host 或 ssh alias） | 目标工程部署脚本 / `PROFILE.Deploy.hosts` / `~/.ssh/config` |
| `<SSH_USER>` | 部署用户（建议非 root 专用账号） | 部署脚本 / `PROFILE.Deploy.user` |
| `<RELEASE_ROOT>` | 服务器上 release 根目录 | 部署脚本 / `PROFILE.Deploy.release_root`（如 `/srv/<app>`） |
| `<SVC>` | systemd 服务名（`<app>.service`） | 部署脚本 / `PROFILE.Deploy.service` |
| `<HEALTH_PATH>` | health/smoke 端点路径 | `PROFILE.Deploy.health`（如 `/healthz`） |
| `<HEALTH_URL_<env>>` | 各环境对外可探活的 URL | PROFILE / 部署脚本 |
| `<BUILD_DIR>` | 本地待传产物目录 | 目标工程构建输出（PROFILE.test-commands.build 的产物） |
| `<CANARY_HOSTS>` / `<CANARY_WEIGHT>` | canary 的"先发哪台/组"或 nginx 权重 | 部署脚本 / PROFILE.Deploy.canary |

> SSH key / 密钥：**只在本地或部署环境**（`ssh-agent` / `~/.ssh/` / 部署 runner 的 secret store）。
> 适配器示例里出现的认证一律 env 或 ssh-config 引用，**不收任何凭据进目标工程仓库**。

派生路径（下文反复用，先在主流程里固化为变量）：

```bash
# 这些是【骨架变量】；右侧 <占位> 运行时替换为目标仓实际值
HOST="<SSH_HOST_${ENV}>"          # ENV ∈ {dev,staging,canary,full}
USER="<SSH_USER>"
RELEASE_ROOT="<RELEASE_ROOT>"     # 例：/srv/<app>
SVC="<SVC>"                        # 例：<app>.service
RELEASES_DIR="$RELEASE_ROOT/releases"
CURRENT_LINK="$RELEASE_ROOT/current"
STAMP="$(date -u +%Y%m%d-%H%M%S)"  # release 目录用 UTC 时间戳，天然有序、便于回滚
NEW_RELEASE="$RELEASES_DIR/$STAMP"
SSH="ssh -o BatchMode=yes ${USER}@${HOST}"   # BatchMode：禁交互，凭据走 agent/ssh-config
```

---

## 1. 环境 = 主机映射（晋级链）

cap-release 的晋级链 dev → staging → canary → full，在 vps 上落成**不同主机/用户**：

| env | 落点（运行时抽） | 说明 |
|---|---|---|
| dev | `<SSH_HOST_dev>` | 研发机/共享 dev 主机 |
| staging | `<SSH_HOST_staging>` | 独立测试主机，配置贴近生产 |
| canary | `<CANARY_HOSTS>`（prod 集群的子集） | 生产里"先发一台/一组"，见 §5 |
| full | `<SSH_HOST_full>` 或 prod 集群全体 | 全量 |

> staging 与 prod 通常是**不同主机/不同凭据**；切 env 时同时切 `HOST/USER`，别复用同一把 key 跨环境（最小权限）。

---

## 2. 传产物（rsync，原子切换友好）

把本地构建产物推到**新建的带时间戳 release 目录**，不直接覆盖 `current`——这样切换可原子、回滚可即时。

```bash
# 1) 在目标主机建好 release 目录骨架（幂等）
$SSH "mkdir -p '$NEW_RELEASE' '$RELEASES_DIR'"

# 2) rsync 推产物到新 release 目录
#    -a 归档(保权限/符号链接/时间戳)  -z 压缩  --delete 让目标与源一致
#    -e 指定 ssh(带 BatchMode)        --exclude 排除不该上线的东西
rsync -az --delete \
  -e "ssh -o BatchMode=yes" \
  --exclude='.git' --exclude='.env' --exclude='node_modules/.cache' \
  "<BUILD_DIR>/" "${USER}@${HOST}:$NEW_RELEASE/"
```

> 备选：单文件/无 rsync 环境用 `scp -r "<BUILD_DIR>/" "${USER}@${HOST}:$NEW_RELEASE/"`。
> rsync 更优（增量 + `--delete` 保证干净）。**`.env`/密钥一律 `--exclude`，密钥只在服务器本地或部署环境注入。**

共享的运行时配置（如服务器本地的 `.env`、上传目录）用软链挂进新 release，避免每次重传：

```bash
$SSH "ln -sfn '$RELEASE_ROOT/shared/.env' '$NEW_RELEASE/.env'"   # 服务器本地密钥，不入仓
```

---

## 3. 切换 + 重启服务（current 软链 + systemd）

发布 = **原子切软链**到新 release，再重启服务；有 nginx 则 reload。

```bash
# 1) 原子切换 current 软链到新 release
#    ln -s 建软链  -f 覆盖已存在  -n 把"指向目录的软链"当普通文件处理(避免软链进目录内部)
$SSH "ln -sfn '$NEW_RELEASE' '$CURRENT_LINK'"

# 2) 重启 systemd 服务（服务的 WorkingDirectory/ExecStart 应指向 current 软链）
$SSH "sudo systemctl restart '$SVC'"

# 3)（若用 nginx 反代）校验配置再热加载，零停机
$SSH "sudo nginx -t && sudo systemctl reload nginx"   # 或: sudo nginx -s reload
```

> `restart` vs `reload`：进程类服务用 `systemctl restart <SVC>`；nginx 配置变更用 `reload`（不断连接）。
> sudo：建议给部署用户配**仅限这几条命令**的 sudoers 白名单（`systemctl restart/reload <SVC>`、`nginx -t/-s reload`），不给全权 root。

---

## 4. smoke / health 门（curl 探活）

切换后**立即探活**，这是晋级门：过 = 进下一环境；不过 = 立刻回滚（§6）。

```bash
HEALTH_URL="<HEALTH_URL_${ENV}>"     # 例：https://staging.<app>/healthz
# -f 非2xx即失败  -s 静默  -S 仍报错  -o /dev/null 丢正文  -w 打印状态码  --max-time 防卡死
code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || echo "000")
if [ "$code" = "200" ]; then
  echo "SMOKE_PASS $ENV $code"
else
  echo "SMOKE_FAIL $ENV $code"      # → 触发 §6 回滚
fi
```

> 加固：探活带**重试 + 退避**（服务重启需预热），如循环 5 次每次 sleep 3s 任一 200 即通过，全败才判 FAIL。
> 探活路径/URL 从 `PROFILE.Deploy.health` 抽；没有 health 端点时退化为探主页 2xx，并在报告标注"无专用 health 端点"。

---

## 5. canary（先发一组 / nginx 权重）

canary = 生产里只让**一小撮**先吃新版本，探活稳定再全量。vps 上两种骨架，按目标工程实际取：

**方式 A：先发一台/一组主机**（无流量切分基础设施时最简单）

```bash
# 只对 <CANARY_HOSTS>（prod 集群子集）跑 §2→§3→§4
for H in <CANARY_HOSTS>; do
  ssh -o BatchMode=yes "${USER}@${H}" "ln -sfn '$NEW_RELEASE' '$CURRENT_LINK' && sudo systemctl restart '$SVC'"
done
# 对 canary 主机逐台 §4 探活；全过 → 进 full，否则 → §6 回滚 canary 主机
```

**方式 B：nginx upstream 权重**（同机/同 LB 按比例放量）

```nginx
# nginx upstream 骨架：把 <CANARY_WEIGHT> 比例的流量导到新版本 upstream
# 实际权重/后端地址从目标工程 nginx 配置 + PROFILE.Deploy.canary 抽
upstream <app>_pool {
    server <STABLE_BACKEND> weight=<STABLE_WEIGHT>;   # 旧版本
    server <CANARY_BACKEND> weight=<CANARY_WEIGHT>;   # 新版本，小权重
}
```

```bash
# 改权重后校验 + 热加载；观测期探活 + 看错误率，稳定再调大权重直至全量
$SSH "sudo nginx -t && sudo systemctl reload nginx"
```

> canary 门：观测期内 §4 探活持续 200 且关键指标（错误率/延迟，从目标工程监控抽）不退化 → 晋级 full；
> 任一退化 → §6 回滚（方式 A 切回 canary 主机软链；方式 B 把 `<CANARY_WEIGHT>` 调 0 再 reload）。

---

## 6. rollback（软链切回上一个 release + 重启）

**核心**：release 目录都还在，回滚只是把 `current` 软链指回**上一个** release 再重启——秒级、可逆。

```bash
# 1) 找出上一个 release（按时间戳目录名排序，倒数第二个 = current 的前一版）
PREV=$($SSH "ls -1d '$RELEASES_DIR'/*/ | sort | tail -n 2 | head -n 1")
#    更稳的做法：发布成功时把当前指向写入 $RELEASE_ROOT/PREVIOUS，回滚直接读它
#    PREV=$($SSH "cat '$RELEASE_ROOT/PREVIOUS'")

# 2) 软链切回上一个 release（原子）
$SSH "ln -sfn '${PREV%/}' '$CURRENT_LINK'"

# 3) 重启服务 + reload nginx（与 §3 对称）
$SSH "sudo systemctl restart '$SVC'"
$SSH "sudo nginx -t && sudo systemctl reload nginx"   # 若用 nginx

# 4) 回滚后再探活一次，确认旧版本起得来（与 §4 相同）
curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "<HEALTH_URL_${ENV}>"
```

canary 专属回滚：
- 方式 A：只对 `<CANARY_HOSTS>` 执行上面 1–4。
- 方式 B：`<CANARY_WEIGHT>` 改回 0 → `nginx -t && systemctl reload nginx`，新版本即下线。

> 何时回滚：§4/§5 探活 FAIL、canary 指标退化、或部署任一步非 0 退出。
> 回滚是**默认安全动作**（检测到 prod 异常即回滚）；
> 失败别原地反复重试——回滚到已知好版本，再回 build 定位。

---

## 7. 一次环境晋级的命令序列（骨架汇总）

```
对每个 env ∈ [dev, staging, canary, full]：
  1. 解析 <占位>（§0）：HOST/USER/RELEASE_ROOT/SVC/HEALTH_URL（按 env 切主机/凭据）
  2. 传产物（§2）：mkdir 新 release → rsync -az --delete → 软链共享配置
  3. 切换+重启（§3）：ln -sfn current → systemctl restart → nginx -t && reload
     ↳ 若 env=canary：改用 §5（先发一组 或 权重放量）
  4. smoke/health 门（§4）：curl health（带重试）
        PASS → 记 STATE，晋级下一 env
        FAIL → §6 回滚本 env + STOP，回报现状交人决策
```

> 与通用方法论的边界：**晋级/回滚的"决策"在 cap-release 主流程**；本文只提供 vps 上每一步的**可跑命令骨架**。
> 项目特定值（主机/用户/路径/服务名/canary 编排）一律 `<占位>`，运行时从目标仓部署脚本 + PROFILE.Deploy 抽。

---

## 8. 适配器自检（cap-release 加载本文后过一遍）

- [ ] 所有 `<占位>` 都已从目标工程解析到具体值？解析不到的已 STOP 问人，**未猜**？
- [ ] dev/staging/canary/full 的 `HOST/USER` 已按环境分开，**未跨环境复用同一把 key**？
- [ ] 产物走**新建时间戳 release 目录**，未直接覆盖 `current`？`.env`/密钥已 `--exclude`、只在服务器本地？
- [ ] 切换是 `ln -sfn`（原子、可回滚），不是 `cp` 覆盖？
- [ ] 每个 env 切换后都有 §4 探活作门？canary 有独立门与独立回滚？
- [ ] rollback 路径验证过：能定位上一个 release 并切回（PREVIOUS 文件或时间戳排序）？
- [ ] sudo 仅限白名单命令（restart/reload <SVC>、nginx reload），未要求全权 root？
- [ ] 任何凭据都未写进本适配器、也未写进目标工程仓库（只 env / ssh-config / 服务器本地）？
