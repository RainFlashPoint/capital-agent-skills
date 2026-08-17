#!/usr/bin/env python3
"""cap-flow 需求树派生操作 — readyqueue / coverage / lint.

读 <root>/<domain>/<subdomain>/<leaf>.md 的 frontmatter(事实源),机械派生:
  readyqueue : 解依赖的就绪叶(消费契约),JSON 到 stdout
  coverage   : 按 domain 的 status 计数 burndown,JSON 到 stdout
  lint       : 断依赖 / 重复 old_system_ref / 缺字段 / 孤儿;有问题则非 0 退出
  retire     : 特性退场(close-out)——归档 .cap 工件 + 标源叶 shipped + 回流追加 + 清栈

纯标准库,无第三方依赖(可移植:Claude / Codex 都能跑)。
事实源 = 叶 frontmatter;派生操作(readyqueue/coverage/lint)只读;
retire 写树(标 shipped)+ 移工件 + 回流追加。
"""
import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile

REQUIRED_FIELDS = [
    "id", "title", "domain_path", "cross_link", "old_system_ref",
    "new_domain_path", "status", "priority", "depends_on", "risk_level",
]
PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
# 生成器(#6)写入的 4 可选交叉字段;非必填(不进 REQUIRED_FIELDS),lint 校验取值合法性。
# failure_class 枚举(ascii token,对应 资金正确性/数据一致性/合规信任/体验):
FAILURE_CLASSES = {"funds", "consistency", "compliance", "experience"}
LEAF_OPTIONAL = ["actor", "failure_class", "contract_refs", "data_owner"]
SHIPPED = "shipped"
# status 状态机权威枚举(单一事实源;CSS/SKILL/钩子/reconcile 都引此,不各自硬编码顺序)
STATUS_ORDER = ["captured", "shaped", "planned", "built", "verified", "shipped"]
STATUS_SET = set(STATUS_ORDER)
# stage(cap 阶段) → 该阶段走过后叶应处的 status(供 post-checkout flush / cap-flow reconcile 映射)
STAGE_TO_STATUS = {
    "define": "shaped", "plan": "planned", "implement": "built",
    "test": "verified", "review": "verified", "release": "shipped",
}
LEGACY_STAGE_ALIASES = {"map": "understand", "shape": "define", "build": "implement", "verify": "test"}


def normalize_stage(stage):
    value = str(stage or "").strip().lower()
    return LEGACY_STAGE_ALIASES.get(value, value)
RETIRE_ARTIFACTS = ["task-context.md", "spec.md", "plan.md", "verify", "review", "STATE.md"]
RETIRE_PHASES = {"snapshot": 0, "cleanup": 1, "index": 2, "leaf": 3, "backflow": 4, "complete": 5}


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_manifest(root):
    rows = []
    for dirpath, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(dirpath, name)
            rows.append({"path": os.path.relpath(path, root).replace(os.sep, "/"),
                         "sha256": _sha256(path), "size": os.path.getsize(path)})
    return rows


def _atomic_write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _atomic_write_json(path, value):
    _atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _fail_retire_after(phase):
    if os.environ.get("CAP_RETIRE_FAIL_AFTER") == phase:
        raise RuntimeError(f"retire fault injection after {phase}")


def _relative_contained_path(root, candidate):
    if not candidate:
        return ""
    canonical_root = os.path.realpath(root)
    canonical_candidate = os.path.realpath(candidate)
    if os.path.commonpath([canonical_root, canonical_candidate]) != canonical_root:
        raise ValueError(f"路径必须位于 .cap 内: {candidate}")
    return os.path.relpath(canonical_candidate, canonical_root).replace(os.sep, "/")


def _safe_archive_segment(value, label):
    text = str(value or "")
    if not text or text in (".", "..") or "/" in text or "\\" in text or os.path.basename(text) != text:
        raise ValueError(f"非法 {label}: {value}")
    return text


def _validate_retire_manifest(archive_dir, manifest, expected_task_id="", expected_delivery_commit=""):
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ValueError("retire manifest schemaVersion 非法")
    if manifest.get("status") != "completed":
        raise ValueError("retire manifest status 非 completed")
    required = ("taskId", "parentTaskId", "title", "intentSummary", "keywords", "branch", "baseCommit", "deliveryCommit", "completedAt")
    if any(key not in manifest for key in required):
        raise ValueError("retire manifest 缺少索引必需字段")
    if expected_task_id and manifest.get("taskId") != expected_task_id:
        raise ValueError(f"retire manifest taskId 不匹配: {manifest.get('taskId')} != {expected_task_id}")
    if expected_delivery_commit and manifest.get("deliveryCommit") != expected_delivery_commit:
        raise ValueError("retire manifest deliveryCommit 与本次请求不匹配")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("retire manifest artifacts 非数组")
    canonical_archive = os.path.realpath(archive_dir)
    copied = set()
    for index, item in enumerate(artifacts):
        if not isinstance(item, dict):
            raise ValueError(f"retire manifest artifact[{index}] 非对象")
        raw_path = item.get("path")
        if not isinstance(raw_path, str) or not raw_path or "\\" in raw_path or os.path.isabs(raw_path):
            raise ValueError(f"retire manifest artifact[{index}] 路径非法")
        parts = raw_path.split("/")
        if any(part in ("", ".", "..") for part in parts) or parts[0] not in RETIRE_ARTIFACTS:
            raise ValueError(f"retire manifest artifact[{index}] 越过允许的工件范围: {raw_path}")
        artifact_path = os.path.join(archive_dir, *parts)
        if os.path.islink(artifact_path):
            raise ValueError(f"retire manifest artifact[{index}] 不允许软链接: {raw_path}")
        canonical_artifact = os.path.realpath(artifact_path)
        if os.path.commonpath([canonical_archive, canonical_artifact]) != canonical_archive or not os.path.isfile(canonical_artifact):
            raise ValueError(f"retire manifest artifact[{index}] 不在归档内或不存在: {raw_path}")
        if item.get("sha256") != _sha256(canonical_artifact) or item.get("size") != os.path.getsize(canonical_artifact):
            raise ValueError(f"retire manifest artifact[{index}] 哈希或大小不匹配: {raw_path}")
        copied.add(parts[0])
    for name in RETIRE_ARTIFACTS:
        archived_item = os.path.join(archive_dir, name)
        if not os.path.lexists(archived_item):
            continue
        if os.path.islink(archived_item):
            raise ValueError(f"retire archive 顶层工件不允许软链接: {name}")
        if os.path.commonpath([canonical_archive, os.path.realpath(archived_item)]) != canonical_archive:
            raise ValueError(f"retire archive 顶层工件越界: {name}")
        copied.add(name)
    return sorted(copied)


def _validate_retire_transaction(cap, transaction, history_mode, expected_task_id=""):
    if not isinstance(transaction, dict) or transaction.get("schemaVersion") != 1:
        raise ValueError("retirement transaction schemaVersion 非法")
    if transaction.get("phase") not in RETIRE_PHASES:
        raise ValueError(f"retirement transaction phase 非法: {transaction.get('phase')}")
    if bool(transaction.get("historyMode")) != history_mode:
        raise ValueError("retirement transaction historyMode 与本次请求不匹配")
    copied = transaction.get("copied")
    if not isinstance(copied, list) or any(item not in RETIRE_ARTIFACTS for item in copied):
        raise ValueError("retirement transaction copied 超出工件白名单")
    request = transaction.get("request")
    if not isinstance(request, dict):
        raise ValueError("retirement transaction request 非对象")
    if expected_task_id and request.get("taskId") != expected_task_id:
        raise ValueError(f"retirement transaction taskId 不匹配: {request.get('taskId')} != {expected_task_id}")
    req_root_relative = request.get("reqRootRelative", "")
    if req_root_relative:
        if not isinstance(req_root_relative, str) or "\\" in req_root_relative or os.path.isabs(req_root_relative):
            raise ValueError("retirement transaction reqRootRelative 非法")
        resolved = _relative_contained_path(cap, os.path.join(cap, *req_root_relative.split("/")))
        if resolved != req_root_relative:
            raise ValueError("retirement transaction reqRootRelative 非规范路径")
    return sorted(set(copied))


def _retire_cleanup_path(cap, name):
    if name not in RETIRE_ARTIFACTS:
        raise ValueError(f"拒绝清理非白名单工件: {name}")
    canonical_cap = os.path.realpath(cap)
    candidate = os.path.abspath(os.path.join(canonical_cap, name))
    if os.path.commonpath([canonical_cap, candidate]) != canonical_cap:
        raise ValueError(f"退场清理路径越界: {name}")
    return candidate


def _state_value(path, key):
    if not os.path.isfile(path):
        return ""
    pattern = re.compile(rf"^{re.escape(key)}\s*:\s*(.*?)\s*$", re.I)
    with open(path, encoding="utf-8") as f:
        for line in f:
            match = pattern.match(line.strip())
            if match:
                return match.group(1).strip()
    return ""


def parse_frontmatter(text):
    """解析叶文件首块 --- frontmatter。只认 `key: scalar` 与内联 list `key: [a, b]`/`[]`。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fm = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [x.strip() for x in inner.split(",") if x.strip()] if inner else []
        else:
            fm[key] = val
    return fm


def _extract_body(text):
    """取 frontmatter 之后的正文(需求描述/验收线索/老系统参照)。无 frontmatter 则返回全文。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text.strip()
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[i + 1:]).strip()
    return ""


def load_leaves(root):
    """返回叶 list:每个 = {fields..., _path, _depth, _body}。跳过 _ 前缀与 _index。"""
    leaves = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith(".md") or fn.startswith("_"):
                continue
            full = os.path.join(dirpath, fn)
            with open(full, encoding="utf-8") as f:
                text = f.read()
            fm = parse_frontmatter(text)
            rel = os.path.relpath(full, root)
            fm["_path"] = rel
            fm["_depth"] = len(os.path.dirname(rel).split(os.sep)) if os.path.dirname(rel) else 0
            fm["_body"] = _extract_body(text)
            leaves.append(fm)
    return leaves


def cmd_readyqueue(root):
    leaves = load_leaves(root)
    by_id = {lf.get("id"): lf for lf in leaves}
    ready = []
    for lf in leaves:
        if lf.get("status") == SHIPPED:
            continue  # 已完成,不再入队
        deps = lf.get("depends_on") or []
        if all(by_id.get(d, {}).get("status") == SHIPPED for d in deps):
            ready.append(lf)
    ready.sort(key=lambda lf: (PRIORITY_ORDER.get(lf.get("priority"), 99), lf.get("id", "")))
    out = [{
        "leaf_id": lf.get("id"),
        "title": lf.get("title"),
        "priority": lf.get("priority"),
        "deps_resolved": True,
        "old_system_ref": lf.get("old_system_ref"),
        "risk_level": lf.get("risk_level"),
        "status": lf.get("status"),
    } for lf in ready]
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


TREE_LEAF_KEYS = [
    "id", "title", "status", "priority", "risk_level",
    "depends_on", "old_system_ref", "new_domain_path", "cross_link",
]


def build_tree(leaves):
    """把扁平叶 list 组装成 domain→subdomain→leaf 嵌套树 + summary。board 与 tree 共用。"""
    by_id = {lf.get("id"): lf for lf in leaves}

    def _is_ready(lf):
        if lf.get("status") == SHIPPED:
            return False
        deps = lf.get("depends_on") or []
        return all(by_id.get(d, {}).get("status") == SHIPPED for d in deps)

    doms = {}            # domain -> {subdomain -> [leaf dict]}（dict 保序）
    by_status = {}
    for lf in leaves:
        dp = lf.get("domain_path") or os.path.dirname(lf.get("_path", ""))
        parts = dp.split("/") if dp else [""]
        dom = parts[0] or "(未分类)"
        sub = parts[1] if len(parts) > 1 else "(根)"
        doms.setdefault(dom, {}).setdefault(sub, []).append(
            {k: lf.get(k) for k in TREE_LEAF_KEYS})
        st = lf.get("status", "unknown")
        by_status[st] = by_status.get(st, 0) + 1
    domains = [
        {"domain": dom,
         "subdomains": [{"subdomain": sub, "leaves": lvs} for sub, lvs in subs.items()]}
        for dom, subs in doms.items()
    ]
    return {
        "domains": domains,
        "summary": {
            "total": len(leaves),
            "by_status": by_status,
            "ready_count": sum(1 for lf in leaves if _is_ready(lf)),
        },
    }


def cmd_tree(root):
    print(json.dumps(build_tree(load_leaves(root)), ensure_ascii=False, indent=2))
    return 0




def cmd_coverage(root):
    leaves = load_leaves(root)
    cov = {}
    for lf in leaves:
        domain = (lf.get("domain_path") or lf["_path"]).split("/")[0]
        d = cov.setdefault(domain, {"total": 0, "by_status": {}})
        d["total"] += 1
        st = lf.get("status", "unknown")
        d["by_status"][st] = d["by_status"].get(st, 0) + 1
    print(json.dumps(cov, ensure_ascii=False, indent=2))
    return 0


def cmd_lint(root):
    leaves = load_leaves(root)
    by_id = {lf.get("id"): lf for lf in leaves}
    problems = []
    seen_ref = {}
    for lf in leaves:
        lid = lf.get("id", lf["_path"])
        # 缺字段
        for fld in REQUIRED_FIELDS:
            if fld not in lf:
                problems.append(f"missing-field: {lid} 缺字段 '{fld}'")
        # 断依赖
        for d in (lf.get("depends_on") or []):
            if d not in by_id:
                problems.append(f"dangling-dep: {lid} 的 depends_on 指向不存在的 '{d}'")
        # 孤儿:叶不在 <domain>/<subdomain>/ 形态(目录深度 < 2)
        if lf["_depth"] < 2:
            problems.append(f"orphan: {lid} 路径深度不足(应在 <domain>/<subdomain>/ 下)")
        # status 取值校验(存在但非法;缺失已由 missing-field 抓)
        status = lf.get("status")
        if status and status not in STATUS_SET:
            problems.append(f"bad-status: {lid} status='{status}' 不在 {STATUS_ORDER}")
        # 重复 old_system_ref
        ref = lf.get("old_system_ref")
        if ref:
            seen_ref.setdefault(ref, []).append(lid)
        # 可选交叉字段取值校验(存在才校验;不存在不报缺字段——非必填)
        fc = lf.get("failure_class")
        if fc and fc not in FAILURE_CLASSES:
            problems.append(f"bad-failure-class: {lid} failure_class='{fc}' 不在 {sorted(FAILURE_CLASSES)}")
        cr = lf.get("contract_refs")
        if cr is not None and not isinstance(cr, list):
            problems.append(f"bad-contract-refs: {lid} contract_refs 须为 list")
    for ref, ids in seen_ref.items():
        if len(ids) > 1:
            problems.append(f"dup-old_system_ref: '{ref}' 出现在多叶 {ids}")
    if problems:
        for p in problems:
            print(p, file=sys.stderr)
        print(f"\nlint: {len(problems)} 个问题", file=sys.stderr)
        return 1
    print("lint: clean")
    return 0


def _set_frontmatter_status(path, value):
    """把叶文件首块 frontmatter 的首个 `status:` 行改成 value,写回(count=1 只改首行)。"""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    new = re.sub(r"(?m)^status:.*$", f"status: {value}", text, count=1)
    _atomic_write_text(path, new)


def _mark_leaf_shipped(req_root, leaf_id):
    """源叶 status -> shipped。命中返回叶绝对路径,未命中返回 None。"""
    for lf in load_leaves(req_root):
        if lf.get("id") == leaf_id:
            path = os.path.join(req_root, lf["_path"])
            _set_frontmatter_status(path, SHIPPED)
            return path
    return None


def cmd_set_status(args):
    """把指定叶 status 机械改为 args.to(allow-any:只校验值∈STATUS_SET,不查迁移合法性)。
    供 post-checkout 钩子 / cap-flow reconcile / 人手调用。叶不存在→2;status 非法→1;成功→0。"""
    if args.to not in STATUS_SET:
        print(f"非法 status '{args.to}',须∈ {STATUS_ORDER}", file=sys.stderr)
        return 1
    for lf in load_leaves(args.root):
        if lf.get("id") == args.leaf:
            _set_frontmatter_status(os.path.join(args.root, lf["_path"]), args.to)
            print(f"set-status: {args.leaf} -> {args.to}")
            return 0
    print(f"叶不存在: {args.leaf}", file=sys.stderr)
    return 2


LEAF_CAP_LOG_HEADER = "## cap 记录"


def _append_leaf_cap_log(leaf_path, entry):
    """把 entry append 到叶的 `## cap 记录` 段(段缺则在文件末尾建段头;仿 _append_evolution)。
    entry 总追加到文件末尾——该段恒为叶末段,故条目累积其下。"""
    with open(leaf_path, encoding="utf-8") as f:
        text = f.read()
    if entry in text.splitlines():
        return leaf_path
    if LEAF_CAP_LOG_HEADER not in text:
        text = text.rstrip("\n") + f"\n\n{LEAF_CAP_LOG_HEADER}\n"
    text = text.rstrip("\n") + "\n" + entry + "\n"
    _atomic_write_text(leaf_path, text)
    return leaf_path


def _append_evolution(cap_dir, entry):
    """耐久教训回流:统一 append `<cap>/EVOLUTION.md`(唯一正屋;缺则建 `# Evolution log` 头)。
    PROFILE 不承载流水(仅留指针)——见 templates/PROFILE.md。"""
    target = os.path.join(cap_dir, "EVOLUTION.md")
    text = ""
    if os.path.isfile(target):
        with open(target, encoding="utf-8") as f:
            text = f.read()
    if entry not in text.splitlines():
        if not text:
            text = "# Evolution log\n\n"
        text = text.rstrip("\n") + "\n" + entry + "\n"
        _atomic_write_text(target, text)
    return target


def cmd_move(args):
    """叶迁域:mv 文件 + 改 id/domain_path + 改写全树指向旧 id 的 depends_on。确定性写 op(仿 retire)。
    源叶不存在 → 2;目标已存在同 id → 1 拒绝(幂等守卫),均不动文件。"""
    leaves = load_leaves(args.root)
    by_id = {lf.get("id"): lf for lf in leaves}
    src = by_id.get(args.leaf)
    if not src:
        print(f"源叶不存在: {args.leaf}", file=sys.stderr)
        return 2
    slug = args.leaf.split(".")[-1]
    new_dp = args.to.strip("/")                       # "<domain>/<subdomain>"
    parts = new_dp.split("/")
    if not new_dp or any(p in ("", ".", "..") for p in parts):  # 防路径遍历:禁空段/./..
        print(f"非法目标域(须为 <domain>/<subdomain>,禁含空段/./..): {args.to}", file=sys.stderr)
        return 2
    new_id = new_dp.replace("/", ".") + "." + slug
    new_dir = os.path.join(args.root, *new_dp.split("/"))
    new_path = os.path.join(new_dir, new_id + ".md")
    if os.path.exists(new_path):
        print(f"目标已存在,拒绝覆盖: {new_path}", file=sys.stderr)
        return 1
    old_path = os.path.join(args.root, src["_path"])
    with open(old_path, encoding="utf-8") as f:
        text = f.read()
    text = re.sub(r"(?m)^id:.*$", f"id: {new_id}", text, count=1)
    text = re.sub(r"(?m)^domain_path:.*$", f"domain_path: {new_dp}", text, count=1)
    os.makedirs(new_dir, exist_ok=True)
    with open(new_path, "w", encoding="utf-8") as f:
        f.write(text)
    os.remove(old_path)
    rewritten = 0
    for lf in leaves:                                 # 改写其余叶对旧 id 的 depends_on 引用
        if lf.get("id") == args.leaf:
            continue
        if args.leaf in (lf.get("depends_on") or []):
            p = os.path.join(args.root, lf["_path"])
            with open(p, encoding="utf-8") as f:
                t = f.read()
            t = re.sub(r"(?m)^(depends_on:.*)$",
                       lambda m: m.group(1).replace(args.leaf, new_id), t, count=1)
            with open(p, "w", encoding="utf-8") as f:
                f.write(t)
            rewritten += 1
    print(json.dumps({"moved": args.leaf, "to": new_id, "deps_rewritten": rewritten},
                     ensure_ascii=False))
    return 0


def _fmt_fm_value(v):
    """frontmatter 值:list → `[a, b]`(与 parse_frontmatter 互逆);其它 → 原样。"""
    if isinstance(v, list):
        return "[" + ", ".join(str(x) for x in v) + "]"
    return "" if v is None else str(v)


def _render_leaf_md(leaf):
    """把一片叶 dict 渲染成 .md 文本(10 必填按固定顺序 + 出现的可选字段 + updated + 正文)。"""
    lines = ["---"]
    for k in REQUIRED_FIELDS:
        lines.append(f"{k}: {_fmt_fm_value(leaf.get(k))}")
    for k in LEAF_OPTIONAL:
        if leaf.get(k) is not None:
            lines.append(f"{k}: {_fmt_fm_value(leaf[k])}")
    if leaf.get("updated"):
        lines.append(f"updated: {leaf['updated']}")
    lines.append("---")
    body = leaf.get("body") or ("## 需求描述\n（待补）\n\n## 验收线索\n（待补）\n\n"
                                 "## 老系统行为参照\n（待补）")
    return "\n".join(lines) + "\n\n" + body + "\n"


def cmd_write_tree(args):
    """tree JSON → 叶 .md 文件(机械落盘;agent 产 JSON,本脚本写文件)。已存在叶跳过(不覆盖人工改)。"""
    with open(args.from_, encoding="utf-8") as f:
        data = json.load(f)
    leaves = data.get("leaves", []) if isinstance(data, dict) else data
    written = skipped = 0
    for leaf in leaves:
        lid, dp = leaf.get("id"), leaf.get("domain_path")
        if not lid or not dp:
            print(f"skip: 叶缺 id/domain_path: {lid}", file=sys.stderr)
            skipped += 1
            continue
        # 防路径遍历:domain_path 分段禁空/./..,id 禁含 / 或 ..(叶文件不得逃出 root)
        if (any(p in ("", ".", "..") for p in dp.split("/"))
                or "/" in lid or ".." in lid):
            print(f"skip: 非法 domain_path/id(防路径遍历): {lid} @ {dp}", file=sys.stderr)
            skipped += 1
            continue
        d = os.path.join(args.root, *dp.split("/"))
        path = os.path.join(d, lid + ".md")
        if os.path.exists(path):
            skipped += 1
            continue
        os.makedirs(d, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(_render_leaf_md(leaf))
        written += 1
    print(json.dumps({"written": written, "skipped": skipped, "root": args.root},
                     ensure_ascii=False))
    return 0


def cmd_retire(args):
    """特性退场:快照提交后按耐久 phase 推进；中断时从 retirement.json 幂等恢复。"""
    state_path = os.path.join(args.cap, "STATE.md")
    state_task_id = _state_value(state_path, "task-id")
    state_stage = normalize_stage(_state_value(state_path, "stage"))
    history_mode = bool(args.task_id)
    try:
        if history_mode:
            task_segment = _safe_archive_segment(args.task_id, "task-id")
            archive_dir = os.path.join(args.cap, "history", task_segment)
        else:
            date_segment = _safe_archive_segment(args.date, "date")
            slug_segment = _safe_archive_segment(args.slug, "slug")
            archive_dir = os.path.join(args.cap, "archive", f"{date_segment}-{slug_segment}")
        _relative_contained_path(args.cap, archive_dir)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    manifest_path = os.path.join(archive_dir, "manifest.json")
    transaction_path = os.path.join(archive_dir, "retirement.json")
    try:
        req_root_relative = _relative_contained_path(args.cap, args.req_root)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    if os.path.islink(archive_dir):
        print(f"archive 不允许为软链接: {archive_dir}", file=sys.stderr)
        return 2
    archive_exists = os.path.isdir(archive_dir)
    transaction = _read_json(transaction_path) if os.path.isfile(transaction_path) else None
    if archive_exists and not os.path.isfile(manifest_path):
        print(f"archive 已存在但缺 manifest,拒绝覆盖: {archive_dir}", file=sys.stderr)
        return 1
    expected_task_id = args.task_id or state_task_id
    manifest = _read_json(manifest_path) if archive_exists else None
    try:
        manifest_copied = _validate_retire_manifest(
            archive_dir, manifest, expected_task_id,
            args.delivery_commit if args.strict else "",
        ) if manifest else []
        if transaction:
            transaction_copied = _validate_retire_transaction(args.cap, transaction, history_mode, expected_task_id)
            if transaction_copied != manifest_copied:
                raise ValueError("retirement transaction copied 与 manifest 工件不一致")
            copied = transaction_copied
        else:
            copied = manifest_copied
    except (KeyError, TypeError, ValueError) as error:
        print(f"retire 恢复证据无效: {error}", file=sys.stderr)
        return 2
    if args.strict:
        if not args.task_id:
            print("strict retire requires --task-id", file=sys.stderr)
            return 2
        if args.gate_status != "passed":
            print("Server Gate 未确认通过,拒绝退场", file=sys.stderr)
            return 2
        if not args.delivery_commit:
            print("缺少 delivery commit,拒绝退场", file=sys.stderr)
            return 2
        if os.path.isfile(state_path):
            if state_task_id != args.task_id:
                print(f"STATE task-id 不匹配: {state_task_id or 'missing'} != {args.task_id}", file=sys.stderr)
                return 2
            if state_stage != "done":
                print(f"Task 尚未完成,拒绝退场: stage={state_stage or 'missing'}", file=sys.stderr)
                return 2
        elif not transaction:
            print("缺少同 Task 的 STATE 或可信 retirement transaction,拒绝恢复", file=sys.stderr)
            return 2
    elif archive_exists and not transaction and state_stage and state_stage != "done":
        print(f"当前仍有活动 Task,拒绝从旧 manifest 恢复退场: stage={state_stage}", file=sys.stderr)
        return 2
    if not os.path.isfile(state_path) and transaction:
        remaining = [name for name in copied if os.path.lexists(_retire_cleanup_path(args.cap, name))]
        if remaining:
            print(f"STATE 缺失但仍存在待清理工件,拒绝自动恢复: {', '.join(remaining)}", file=sys.stderr)
            return 2
    if transaction and transaction.get("phase") == "complete":
        print(json.dumps({"archived": archive_dir, "idempotent": True, "recovered": False}, ensure_ascii=False))
        return 0
    recovered = archive_exists
    if not transaction:
        if archive_exists:
            pass
        else:
            parent = os.path.dirname(archive_dir)
            os.makedirs(parent, exist_ok=True)
            temp_dir = tempfile.mkdtemp(prefix=".snapshot-", dir=parent)
            copied = []
            try:
                for name in RETIRE_ARTIFACTS:
                    src = os.path.join(args.cap, name)
                    dst = os.path.join(temp_dir, name)
                    if os.path.isdir(src):
                        shutil.copytree(src, dst)
                        copied.append(name)
                    elif os.path.isfile(src):
                        shutil.copy2(src, dst)
                        copied.append(name)
                manifest = {
                    "schemaVersion": 1,
                    "taskId": args.task_id or state_task_id,
                    "parentTaskId": args.parent_task_id or "",
                    "title": args.title or args.slug,
                    "intentSummary": args.intent_summary or "",
                    "keywords": [item.strip() for item in (args.keywords or "").split(",") if item.strip()],
                    "branch": args.branch or "",
                    "baseCommit": args.base_commit or "",
                    "deliveryCommit": args.delivery_commit or "",
                    "completedAt": args.completed_at or args.date,
                    "status": "completed",
                    "artifacts": _artifact_manifest(temp_dir),
                }
                _atomic_write_json(os.path.join(temp_dir, "manifest.json"), manifest)
                transaction = {
                    "schemaVersion": 1, "phase": "snapshot", "copied": copied,
                    "historyMode": history_mode,
                    "request": {"taskId": args.task_id or state_task_id, "leaf": args.leaf or "", "reqRootRelative": req_root_relative, "evolutionEntry": args.evolution_entry or ""},
                }
                _atomic_write_json(os.path.join(temp_dir, "retirement.json"), transaction)
                os.rename(temp_dir, archive_dir)
                temp_dir = ""
            finally:
                if temp_dir and os.path.isdir(temp_dir):
                    shutil.rmtree(temp_dir)
            _fail_retire_after("snapshot")
        if transaction is None:
            transaction = {
                "schemaVersion": 1, "phase": "snapshot", "copied": copied,
                "historyMode": history_mode,
                "request": {"taskId": args.task_id or state_task_id, "leaf": args.leaf or "", "reqRootRelative": req_root_relative, "evolutionEntry": args.evolution_entry or ""},
            }
            _atomic_write_json(transaction_path, transaction)
    else:
        copied = _validate_retire_transaction(args.cap, transaction, history_mode, expected_task_id)

    try:
        manifest_copied = _validate_retire_manifest(
            archive_dir, manifest, expected_task_id,
            args.delivery_commit if args.strict else "",
        )
        transaction_copied = _validate_retire_transaction(args.cap, transaction, history_mode, expected_task_id)
        if manifest_copied != transaction_copied:
            raise ValueError("retirement transaction copied 与 manifest 工件不一致")
        copied = transaction_copied
    except (KeyError, TypeError, ValueError) as error:
        print(f"retire 事务证据无效: {error}", file=sys.stderr)
        return 2

    def advance(phase):
        transaction["phase"] = phase
        _atomic_write_json(transaction_path, transaction)

    current_phase = lambda: RETIRE_PHASES[transaction.get("phase", "snapshot")]

    if current_phase() < RETIRE_PHASES["cleanup"]:
        for name in copied:
            src = _retire_cleanup_path(args.cap, name)
            if os.path.islink(src):
                os.remove(src)
            elif os.path.isdir(src):
                shutil.rmtree(src)
            elif os.path.exists(src):
                os.remove(src)
        _fail_retire_after("cleanup")
        advance("cleanup")

    index_path = None
    if transaction.get("historyMode"):
        task_id = transaction.get("request", {}).get("taskId") or manifest.get("taskId")
        index_path = os.path.join(args.cap, "history", "index", f"{task_id}.json")
        if current_phase() < RETIRE_PHASES["index"]:
            index_item = {key: manifest[key] for key in ("schemaVersion", "taskId", "parentTaskId", "title", "intentSummary", "keywords", "branch", "baseCommit", "deliveryCommit", "completedAt", "status")}
            index_item["artifactRoot"] = f".cap/history/{task_id}"
            _atomic_write_json(index_path, index_item)
            _fail_retire_after("index")
            advance("index")
    elif current_phase() < RETIRE_PHASES["index"]:
        advance("index")

    request = transaction.get("request", {})
    request_root = os.path.join(args.cap, request["reqRootRelative"]) if request.get("reqRootRelative") else request.get("reqRoot", "")
    leaf_path = None
    if current_phase() < RETIRE_PHASES["leaf"]:
        if request.get("leaf") and request_root:
            leaf_path = _mark_leaf_shipped(request_root, request["leaf"])
            if leaf_path is None:
                print(f"warn: 未找到源叶 '{request['leaf']}',跳过标 shipped", file=sys.stderr)
        _fail_retire_after("leaf")
        advance("leaf")
    elif request.get("leaf") and request_root:
        for leaf in load_leaves(request_root):
            if leaf.get("id") == request["leaf"]:
                leaf_path = os.path.join(request_root, leaf["_path"])
                break

    backflow = None
    leaf_evolution = None
    if current_phase() < RETIRE_PHASES["backflow"]:
        if request.get("evolutionEntry"):
            backflow = _append_evolution(args.cap, request["evolutionEntry"])
            if leaf_path:
                leaf_evolution = _append_leaf_cap_log(leaf_path, request["evolutionEntry"])
        _fail_retire_after("backflow")
        advance("backflow")
    elif request.get("evolutionEntry"):
        backflow = os.path.join(args.cap, "EVOLUTION.md")
        leaf_evolution = leaf_path

    advance("complete")
    print(json.dumps({"archived": archive_dir, "moved": copied, "manifest": manifest_path, "index": index_path,
                      "leaf_shipped": leaf_path is not None, "backflow": backflow,
                      "leaf_evolution": leaf_evolution, "recovered": recovered}, ensure_ascii=False))
    return 0


def cmd_prepare_next(args):
    """新需求前置守卫：根 .cap 只能承载一个活动 Task，不替模型猜测或覆盖旧产物。"""
    state_path = os.path.join(args.cap, "STATE.md")
    if not os.path.isfile(state_path):
        print(json.dumps({"ready": True, "reason": "no_active_task"}, ensure_ascii=False))
        return 0
    task_id = _state_value(state_path, "task-id")
    stage = normalize_stage(_state_value(state_path, "stage"))
    history_path = os.path.join(args.cap, "history", task_id) if task_id else ""
    result = {"ready": False, "taskId": task_id, "stage": stage,
              "historyPath": history_path if history_path and os.path.isdir(history_path) else ""}
    if stage == "done":
        result["reason"] = "retirement_required"
        result["nextAction"] = "run strict retire after confirming Server Gate and delivery commit"
    else:
        result["reason"] = "active_task_exists"
        result["nextAction"] = "resume current task or use another branch/worktree"
    print(json.dumps(result, ensure_ascii=False))
    return 3


def main(argv=None):
    ap = argparse.ArgumentParser(description="cap-flow 需求树派生操作")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("readyqueue", "coverage", "lint", "tree"):
        p = sub.add_parser(name)
        p.add_argument("--root", required=True, help=".cap/requirements 目录")
    pr = sub.add_parser("retire", help="特性退场:归档 + 标叶 shipped + 回流 + 清栈")
    pr.add_argument("--cap", required=True, help=".cap 目录")
    pr.add_argument("--slug", required=True, help="特性 slug(归档目录名用)")
    pr.add_argument("--date", required=True, help="日期 YYYY-MM-DD(归档目录名用)")
    pr.add_argument("--task-id", help="平台 Task ID；提供后写入 .cap/history/<task-id>")
    pr.add_argument("--parent-task-id", default="")
    pr.add_argument("--title", default="")
    pr.add_argument("--intent-summary", default="")
    pr.add_argument("--keywords", default="", help="逗号分隔的检索词")
    pr.add_argument("--branch", default="")
    pr.add_argument("--base-commit", default="")
    pr.add_argument("--delivery-commit", default="")
    pr.add_argument("--completed-at", default="")
    pr.add_argument("--gate-status", choices=("passed", "pending", "blocked"), default="pending")
    pr.add_argument("--strict", action="store_true", help="要求 Task/Commit/Server Gate 完整后才允许退场")
    pr.add_argument("--leaf", help="源叶 id(给则标 shipped)")
    pr.add_argument("--req-root", dest="req_root", help="requirements 树根(配合 --leaf)")
    pr.add_argument("--evolution-entry", dest="evolution_entry",
                    help="回流到 Evolution log 的一行(由调用方蒸馏)")
    pn = sub.add_parser("prepare-next", help="新需求前检查是否仍有活动 Task 或待退场 Task")
    pn.add_argument("--cap", required=True, help=".cap 目录")
    pm = sub.add_parser("move", help="叶迁域:mv 文件 + 改 id/domain_path + 改写依赖")
    pm.add_argument("--root", required=True, help=".cap/requirements 目录")
    pm.add_argument("--leaf", required=True, help="要迁移的叶 id")
    pm.add_argument("--to", required=True, help="目标 <domain>/<subdomain>")
    pb = sub.add_parser("board", help="渲染折叠树 HTML 看板(注入 web-review annotate)")
    pb.add_argument("--root", required=True, help=".cap/requirements 目录")
    pb.add_argument("--out", help="输出 HTML 路径(默认 <root>/_board.html)")
    pwt = sub.add_parser("write-tree", help="tree JSON → 叶文件(机械落盘;生成器#6 用)")
    pwt.add_argument("--root", required=True, help=".cap/requirements 目录")
    pwt.add_argument("--from", dest="from_", required=True, help="merged tree JSON 路径")
    pss = sub.add_parser("set-status", help="把指定叶 status 机械改为目标值(allow-any 迁移)")
    pss.add_argument("--root", required=True, help=".cap/requirements 目录")
    pss.add_argument("--leaf", required=True, help="叶 id")
    pss.add_argument("--to", required=True, help="目标 status(须∈STATUS_ORDER)")
    args = ap.parse_args(argv)
    if args.cmd == "retire":
        return cmd_retire(args)
    if args.cmd == "prepare-next":
        return cmd_prepare_next(args)
    if not os.path.isdir(args.root):
        print(f"root 不存在: {args.root}", file=sys.stderr)
        return 2
    if args.cmd == "move":
        return cmd_move(args)
    if args.cmd == "board":
        import board  # 惰性 import:看板渲染抽到 board.py(守 800 行),仅 board 子命令时加载
        return board.cmd_board(args)
    if args.cmd == "write-tree":
        return cmd_write_tree(args)
    if args.cmd == "set-status":
        return cmd_set_status(args)
    return {"readyqueue": cmd_readyqueue, "coverage": cmd_coverage,
            "lint": cmd_lint, "tree": cmd_tree}[args.cmd](args.root)


if __name__ == "__main__":
    sys.exit(main())
