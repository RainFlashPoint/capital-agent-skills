#!/usr/bin/env python3
"""Tests for scripts/intake.py — stdlib unittest, no third-party deps."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INTAKE = os.path.join(HERE, "intake.py")
sys.path.insert(0, HERE)
import intake  # noqa: E402  (直接引用常量/函数;CLI 行为仍走 subprocess run())

VALID_COMMIT = "d" * 40
OTHER_COMMIT = "e" * 40

LEAF_TMPL = """---
id: {id}
title: {title}
domain_path: {domain_path}
cross_link: {cross_link}
old_system_ref: {old_system_ref}
new_domain_path: {domain_path}
status: {status}
priority: {priority}
depends_on: {depends_on}
risk_level: {risk_level}
updated: 2026-06-15
---

## 需求描述
test leaf {id}
"""


def write_leaf(root, id, *, status="captured", priority="P2", depends_on="[]",
               cross_link="[]", old_system_ref="ref", risk_level="medium",
               title="t"):
    domain_path = "/".join(id.split(".")[:2])
    d = os.path.join(root, *domain_path.split("/"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, id + ".md"), "w", encoding="utf-8") as f:
        f.write(LEAF_TMPL.format(id=id, title=title, domain_path=domain_path,
                                 cross_link=cross_link, old_system_ref=old_system_ref,
                                 status=status, priority=priority,
                                 depends_on=depends_on, risk_level=risk_level))


def run(*args, root):
    r = subprocess.run([sys.executable, INTAKE, *args, "--root", root],
                       capture_output=True, text=True)
    return r


class ReadyQueueTest(unittest.TestCase):
    def test_excludes_dep_blocked_then_unblocks(self):
        with tempfile.TemporaryDirectory() as root:
            # a: no deps, P1, captured (ready to work)
            write_leaf(root, "order.checkout.a", priority="P1")
            # b: depends on a, P0; a not shipped -> b blocked
            write_leaf(root, "order.checkout.b", priority="P0",
                       depends_on="[order.checkout.a]")
            r = run("readyqueue", root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            q = json.loads(r.stdout)
            ids = [e["leaf_id"] for e in q]
            self.assertEqual(ids, ["order.checkout.a"])  # only a is ready

            # now ship a -> a excluded (done), b becomes ready
            write_leaf(root, "order.checkout.a", priority="P1", status="shipped")
            r = run("readyqueue", root=root)
            q = json.loads(r.stdout)
            ids = [e["leaf_id"] for e in q]
            self.assertEqual(ids, ["order.checkout.b"])
            # contract fields present
            self.assertEqual(
                set(q[0].keys()),
                {"leaf_id", "title", "priority", "deps_resolved",
                 "old_system_ref", "risk_level", "status"},
            )

    def test_priority_sorted_p0_first(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "x.y.low", priority="P3")
            write_leaf(root, "x.y.high", priority="P0")
            r = run("readyqueue", root=root)
            q = json.loads(r.stdout)
            self.assertEqual([e["leaf_id"] for e in q], ["x.y.high", "x.y.low"])


class CoverageLintTest(unittest.TestCase):
    def test_coverage_counts_by_domain(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="captured")
            write_leaf(root, "order.checkout.b", status="shipped")
            write_leaf(root, "user.auth.c", status="built")
            r = run("coverage", root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            cov = json.loads(r.stdout)
            self.assertEqual(cov["order"]["total"], 2)
            self.assertEqual(cov["order"]["by_status"]["shipped"], 1)
            self.assertEqual(cov["user"]["total"], 1)

    def test_lint_flags_dangling_and_dup(self):
        with tempfile.TemporaryDirectory() as root:
            # dangling dep
            write_leaf(root, "order.checkout.a", depends_on="[order.checkout.ghost]")
            # duplicate old_system_ref
            write_leaf(root, "order.checkout.b", old_system_ref="SHARED")
            write_leaf(root, "user.auth.c", old_system_ref="SHARED")
            r = run("lint", root=root)
            self.assertNotEqual(r.returncode, 0)  # problems -> nonzero exit
            out = r.stdout + r.stderr
            self.assertIn("dangling", out.lower())
            self.assertIn("dup", out.lower())

    def test_lint_clean_passes(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a")
            r = run("lint", root=root)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


def run_retire(*args, env=None):
    process_env = os.environ.copy()
    if env:
        process_env.update(env)
    r = subprocess.run([sys.executable, INTAKE, "retire", *args],
                       capture_output=True, text=True, env=process_env)
    return r


def run_prepare_next(cap):
    return subprocess.run([sys.executable, INTAKE, "prepare-next", "--cap", cap],
                          capture_output=True, text=True)


def run_knowledge_audit(cap):
    return subprocess.run([sys.executable, INTAKE, "knowledge-audit", "--cap", cap],
                          capture_output=True, text=True)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _make_cap(cap, names=("spec.md", "plan.md", "experience.md", "STATE.md"),
              dirs=("verify", "review")):
    for name in names:
        with open(os.path.join(cap, name), "w", encoding="utf-8") as f:
            f.write(name)
    for d in dirs:
        os.makedirs(os.path.join(cap, d), exist_ok=True)
        with open(os.path.join(cap, d, "r.md"), "w", encoding="utf-8") as f:
            f.write(d)


def _write_valid_experience(cap, task_id="task_123", commit=VALID_COMMIT):
    with open(os.path.join(cap, "experience.md"), "w", encoding="utf-8") as f:
        f.write(f"""---
schema: cap-experience/v1
title: 支付异步状态查询收敛
task-id: {task_id}
source-commit: {commit}
---

## 复用触发与检索线索 / Reuse triggers and retrieval cues
- 触发：当支付同步返回处理中且存在官方查询接口时。
- 关键词：PROCESSING、查询收敛、幂等终态。

## 问题与根因 / Problem and cause
- 问题：同步处理中被误写为成功。
- 根因：把接口受理等同于支付终态。

## 决策与行动 / Decision and actions
- 决策：当同步状态为处理中时，必须通过官方查询收敛终态。

## 实现锚点与不变量 / Implementation anchors and invariants
- 入口：src/payment/callback.ts 的 getPaymentStatus
- 改动点：src/payment/callback.ts；src/payment/status.ts
- 不变量：PaymentStatus_PROCESSING 不能直接写入成功。

## 失效信号 / Invalidation signals
- 失效信号：厂商状态枚举或查询协议发生变化。
""")


def _experience_outbox_event(task_id="task_123", commit=VALID_COMMIT, **overrides):
    idempotency_key = f"experience:{task_id}:{commit}:fixture"
    event = {
        "id": f"evt_{task_id}",
        "idempotencyKey": idempotency_key,
        "type": "experience.record",
        "localTaskRef": task_id,
        "dependsOn": [],
        "payload": {
            "task_id": task_id,
            "commit_sha": commit,
            "idempotency_key": idempotency_key,
            "intent": "沉淀支付异步状态查询收敛经验",
            "changed_files": ["src/payment/callback.ts"],
            "experience": {
                "problem": "同步处理中被误写为成功",
                "solution": "必须通过官方查询收敛终态",
                "conditions": ["同步状态为处理中"],
                "counterexamples": ["厂商取消查询接口时不可使用"],
                "evidence_refs": [f"commit:{commit}"],
                "outcome": "查询状态可靠收敛",
            },
        },
    }
    event.update(overrides)
    return event


def _write_completed_archive(cap, task_id="task_123", **metadata):
    archive = os.path.join(cap, "history", task_id)
    os.makedirs(archive, exist_ok=True)
    archived_spec = os.path.join(archive, "spec.md")
    with open(archived_spec, "w", encoding="utf-8") as f:
        f.write("archived")
    with open(os.path.join(cap, "spec.md"), "w", encoding="utf-8") as f:
        f.write("active")
    with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
        f.write(f"stage: done\ntask-id: {task_id}\n")
    manifest = {
        "schemaVersion": 1, "taskId": task_id, "parentTaskId": "", "title": "test",
        "intentSummary": "test intent", "keywords": ["test"], "branch": "main",
        "baseCommit": "abc", "deliveryCommit": VALID_COMMIT, "completedAt": "2026-09-19",
        "status": "completed", "knowledgeDisposition": "no-reusable-experience",
        "artifacts": [{"path": "spec.md", "sha256": intake._sha256(archived_spec), "size": 8}],
    }
    manifest.update(metadata)
    with open(os.path.join(archive, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return archive


def _valid_history_index(task_id):
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "knowledgeDisposition": "local-only",
        "artifactRoot": f".cap/history/{task_id}",
        "experienceIndex": {
            "schema": "cap-experience-index/v1",
            "path": f".cap/history/{task_id}/experience.md",
        },
    }


class RetireTest(unittest.TestCase):
    def test_retire_rejects_symlinked_active_artifacts_without_cleanup(self):
        cases = ("top-level-file", "top-level-directory", "nested")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as cap, tempfile.TemporaryDirectory() as outside:
                _make_cap(cap)
                with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                    f.write("stage: done\ntask-id: task_symlink\n")
                outside_file = os.path.join(outside, "outside.md")
                with open(outside_file, "w", encoding="utf-8") as f:
                    f.write("OUTSIDE_RETIRE_MARKER")

                if case == "top-level-file":
                    link_path = os.path.join(cap, "spec.md")
                    os.remove(link_path)
                    os.symlink(outside_file, link_path)
                elif case == "top-level-directory":
                    outside_dir = os.path.join(outside, "verify")
                    os.makedirs(outside_dir)
                    with open(os.path.join(outside_dir, "outside.md"), "w", encoding="utf-8") as f:
                        f.write("OUTSIDE_RETIRE_MARKER")
                    link_path = os.path.join(cap, "verify")
                    shutil.rmtree(link_path)
                    os.symlink(outside_dir, link_path)
                else:
                    link_path = os.path.join(cap, "verify", "outside.md")
                    os.symlink(outside_file, link_path)

                result = run_retire(
                    "--cap", cap, "--slug", "symlink", "--date", "2026-09-19",
                    "--task-id", "task_symlink", "--delivery-commit", VALID_COMMIT,
                    "--knowledge-disposition", "no-reusable-experience",
                    "--gate-status", "passed", "--strict",
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("软链接", result.stderr)
                self.assertTrue(os.path.lexists(link_path))
                self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
                self.assertFalse(os.path.exists(os.path.join(cap, "history", "task_symlink")))

    def test_retire_rejects_symlinked_history_index_parent_before_snapshot_or_cleanup(self):
        with tempfile.TemporaryDirectory() as cap, tempfile.TemporaryDirectory() as outside:
            _make_cap(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_index_link\n")
            history = os.path.join(cap, "history")
            os.makedirs(history)
            os.symlink(outside, os.path.join(history, "index"))
            outside_before = sorted(os.listdir(outside))

            result = run_retire(
                "--cap", cap, "--slug", "index-link", "--date", "2026-09-19",
                "--task-id", "task_index_link", "--delivery-commit", VALID_COMMIT,
                "--knowledge-disposition", "no-reusable-experience",
                "--gate-status", "passed", "--strict",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("history index", result.stderr.lower())
            self.assertEqual(sorted(os.listdir(outside)), outside_before)
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
            self.assertTrue(os.path.isfile(os.path.join(cap, "spec.md")))
            self.assertFalse(os.path.exists(os.path.join(history, "task_index_link")))

    def test_prepare_next_allows_empty_activity_area(self):
        with tempfile.TemporaryDirectory() as cap:
            r = run_prepare_next(cap)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(json.loads(r.stdout)["ready"])

    def test_prepare_next_blocks_active_task(self):
        with tempfile.TemporaryDirectory() as cap:
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: implement\ntask-id: task_active\n")
            r = run_prepare_next(cap)
            self.assertEqual(r.returncode, 3)
            self.assertEqual(json.loads(r.stdout)["reason"], "active_task_exists")

    def test_prepare_next_requires_done_task_retirement(self):
        with tempfile.TemporaryDirectory() as cap:
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_done\n")
            r = run_prepare_next(cap)
            self.assertEqual(r.returncode, 3)
            self.assertEqual(json.loads(r.stdout)["reason"], "retirement_required")

    def test_task_history_snapshot_is_indexed_and_clears_after_validation(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            _write_valid_experience(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                           "--task-id", "task_123", "--parent-task-id", "task_parent",
                           "--title", "支付 DTO 续作", "--keywords", "支付,DTO",
                           "--branch", "dev", "--base-commit", "abc",
                           "--delivery-commit", VALID_COMMIT, "--completed-at", "2026-07-29T01:00:00Z",
                           "--knowledge-disposition", "local-only",
                           "--gate-status", "passed", "--strict")
            self.assertEqual(r.returncode, 0, r.stderr)
            history = os.path.join(cap, "history", "task_123")
            with open(os.path.join(history, "manifest.json"), encoding="utf-8") as f:
                manifest = json.load(f)
            with open(os.path.join(cap, "history", "index", "task_123.json"), encoding="utf-8") as f:
                index = json.load(f)
            self.assertEqual(manifest["taskId"], "task_123")
            self.assertEqual(manifest["parentTaskId"], "task_parent")
            self.assertEqual(manifest["deliveryCommit"], VALID_COMMIT)
            self.assertEqual(index["artifactRoot"], ".cap/history/task_123")
            self.assertEqual(index["experienceIndex"]["path"], ".cap/history/task_123/experience.md")
            self.assertIn("查询收敛", " ".join(index["experienceIndex"]["retrievalCues"]))
            self.assertIn("必须通过官方查询", " ".join(index["experienceIndex"]["decisionRules"]))
            self.assertIn("src/payment/callback.ts", index["experienceIndex"]["codePaths"])
            self.assertIn("PaymentStatus_PROCESSING", index["experienceIndex"]["symbols"])
            self.assertIn("getPaymentStatus", index["experienceIndex"]["symbols"])
            self.assertIn("PaymentStatus_PROCESSING 不能直接写入成功。", index["experienceIndex"]["invariants"])
            self.assertTrue(any(item["path"] == "plan.md" and item["sha256"] for item in manifest["artifacts"]))
            self.assertTrue(any(item["path"] == "experience.md" and item["sha256"] for item in manifest["artifacts"]))
            self.assertTrue(os.path.isfile(os.path.join(history, "experience.md")))
            self.assertFalse(os.path.exists(os.path.join(cap, "experience.md")))
            self.assertFalse(os.path.exists(os.path.join(cap, "STATE.md")))
            self.assertEqual(index["knowledgeDisposition"], "local-only")

    def test_strict_retire_requires_explicit_knowledge_disposition_before_cleanup(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                           "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                           "--gate-status", "passed", "--strict")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("knowledge disposition", (r.stdout + r.stderr).lower())
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
            self.assertFalse(os.path.exists(os.path.join(cap, "history", "task_123")))

    def test_pending_sync_requires_same_task_experience_outbox_event(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            _write_valid_experience(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            args = ("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                    "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                    "--knowledge-disposition", "pending-sync",
                    "--gate-status", "passed", "--strict")
            rejected = run_retire(*args)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("experience.record", rejected.stderr)
            with open(os.path.join(cap, "outbox.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps(_experience_outbox_event("task_other", VALID_COMMIT)) + "\n")
                f.write(json.dumps({
                    "type": "experience.record", "localTaskRef": "task_123",
                    "idempotencyKey": "placeholder", "payload": {"task_id": "task_123"},
                }) + "\n")
                f.write(json.dumps(_experience_outbox_event("task_123", OTHER_COMMIT)) + "\n")
                unsafe = _experience_outbox_event("task_123", VALID_COMMIT)
                unsafe["id"] = "evt_unsafe_path"
                unsafe["idempotencyKey"] += ":unsafe"
                unsafe["payload"]["idempotency_key"] = unsafe["idempotencyKey"]
                unsafe["payload"]["changed_files"] = ["/Users/example/private.py"]
                f.write(json.dumps(unsafe) + "\n")
            still_rejected = run_retire(*args)
            self.assertNotEqual(still_rejected.returncode, 0)
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
            with open(os.path.join(cap, "outbox.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(_experience_outbox_event("task_123", VALID_COMMIT)) + "\n")
            accepted = run_retire(*args)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            path = os.path.join(cap, "history", "index", "task_123.json")
            with open(path, encoding="utf-8") as f:
                index = json.load(f)
            self.assertEqual(index["knowledgeDisposition"], "pending-sync")

    def test_strict_retire_requires_experience_task_and_full_delivery_commit_binding(self):
        cases = {
            "wrong-task": ("task_other", VALID_COMMIT),
            "stale-commit": ("task_123", OTHER_COMMIT),
            "malformed-commit": ("task_123", "not-a-commit"),
        }
        for label, (task_id, source_commit) in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as cap:
                _make_cap(cap)
                _write_valid_experience(cap, task_id=task_id, commit=source_commit)
                with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                    f.write("stage: done\ntask-id: task_123\n")
                result = run_retire(
                    "--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                    "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                    "--knowledge-disposition", "local-only",
                    "--gate-status", "passed", "--strict",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
                self.assertFalse(os.path.exists(os.path.join(cap, "history", "index", "task_123.json")))

    def test_strict_retire_revalidates_experience_binding_when_resuming_snapshot(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            _write_valid_experience(cap, task_id="task_123", commit=VALID_COMMIT)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            args = (
                "--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                "--knowledge-disposition", "local-only",
                "--gate-status", "passed", "--strict",
            )
            interrupted = run_retire(*args, env={"CAP_RETIRE_FAIL_AFTER": "snapshot"})
            self.assertNotEqual(interrupted.returncode, 0)
            self.assertTrue(os.path.isdir(os.path.join(cap, "history", "task_123")))

            archived_experience = os.path.join(cap, "history", "task_123", "experience.md")
            with open(archived_experience, encoding="utf-8") as f:
                text = f.read().replace(f"task-id: task_123", "task-id: task_other").replace(
                    f"source-commit: {VALID_COMMIT}", f"source-commit: {OTHER_COMMIT}")
            with open(archived_experience, "w", encoding="utf-8") as f:
                f.write(text)
            manifest_path = os.path.join(cap, "history", "task_123", "manifest.json")
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
            for artifact in manifest["artifacts"]:
                if artifact["path"] == "experience.md":
                    artifact["sha256"] = intake._sha256(archived_experience)
                    artifact["size"] = os.path.getsize(archived_experience)
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f)

            resumed = run_retire(*args)
            self.assertNotEqual(resumed.returncode, 0)
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
            self.assertFalse(os.path.exists(os.path.join(cap, "history", "index", "task_123.json")))

    def test_synced_requires_document_id_and_no_reusable_rejects_valid_experience(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            _write_valid_experience(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            common = ("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                      "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                      "--gate-status", "passed", "--strict")
            no_doc = run_retire(*common, "--knowledge-disposition", "synced")
            self.assertNotEqual(no_doc.returncode, 0)
            contradicted = run_retire(*common, "--knowledge-disposition", "no-reusable-experience")
            self.assertNotEqual(contradicted.returncode, 0)
            accepted = run_retire(*common, "--knowledge-disposition", "synced",
                                  "--knowledge-document-id", "kn_123")
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            path = os.path.join(cap, "history", "index", "task_123.json")
            with open(path, encoding="utf-8") as f:
                index = json.load(f)
            self.assertEqual(index["knowledgeDocumentId"], "kn_123")

    def test_document_id_is_allowed_only_for_synced_disposition(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            _write_valid_experience(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            result = run_retire(
                "--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                "--knowledge-disposition", "local-only",
                "--knowledge-document-id", "kn_must_not_persist",
                "--gate-status", "passed", "--strict",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("only valid for synced", result.stderr)
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))

            index_root = os.path.join(cap, "history", "index")
            os.makedirs(index_root, exist_ok=True)
            contradictory = _valid_history_index("task_123")
            contradictory["knowledgeDocumentId"] = "kn_must_not_persist"
            with open(os.path.join(index_root, "task_123.json"), "w", encoding="utf-8") as f:
                json.dump(contradictory, f)
            self.assertIsNone(intake._read_valid_history_index(cap, "task_123"))
            audit = run_knowledge_audit(cap)
            self.assertEqual(audit.returncode, 0, audit.stderr)
            self.assertEqual(json.loads(audit.stdout)["indexes"]["invalid"], 1)

    def test_retire_manifest_includes_execution_and_release_artifacts(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap, names=("STATE.md",))
            for name in ("execution", "release"):
                os.makedirs(os.path.join(cap, name))
                with open(os.path.join(cap, name, "evidence.md"), "w", encoding="utf-8") as f:
                    f.write(name)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_exec\n")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                           "--task-id", "task_exec", "--delivery-commit", VALID_COMMIT,
                           "--knowledge-disposition", "no-reusable-experience",
                           "--gate-status", "passed", "--strict")
            self.assertEqual(r.returncode, 0, r.stderr)
            archive = os.path.join(cap, "history", "task_exec")
            with open(os.path.join(archive, "manifest.json"), encoding="utf-8") as f:
                manifest = json.load(f)
            paths = {item["path"] for item in manifest["artifacts"]}
            self.assertIn("execution/evidence.md", paths)
            self.assertIn("release/evidence.md", paths)
            self.assertFalse(os.path.exists(os.path.join(cap, "execution")))
            self.assertFalse(os.path.exists(os.path.join(cap, "release")))

    def test_strict_retire_refuses_without_done_and_preserves_active_files(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: test\ntask-id: task_123\n")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                           "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                           "--gate-status", "passed", "--strict")
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(os.path.join(cap, "STATE.md")))
            self.assertFalse(os.path.exists(os.path.join(cap, "history", "task_123")))

    def test_strict_retire_refuses_legacy_manifest_without_disposition_and_preserves_active_files(self):
        with tempfile.TemporaryDirectory() as cap:
            archive = _write_completed_archive(cap)
            manifest_path = os.path.join(archive, "manifest.json")
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
            manifest.pop("knowledgeDisposition")
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f)

            result = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                                "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                                "--gate-status", "passed", "--strict")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("legacy", result.stderr.lower())
            self.assertEqual(_read(os.path.join(cap, "spec.md")), "active")
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))

    def test_history_index_rejects_unsafe_top_level_metadata_before_cleanup(self):
        unsafe_cases = {
            "secret": {"title": "token=super-secret-value"},
            "absolute-path": {"intentSummary": "read /Users/alice/private.txt"},
            "generic-absolute-path": {"intentSummary": "read /opt/internal/private/config"},
            "private-address": {"branch": "deploy-" + ".".join(("10", "2", "7", "214"))},
            "authorization": {"title": "Authorization: Bearer dummy-secret-value"},
            "internal-host": {"intentSummary": "connect to db.internal"},
            "account": {"title": "account: local-user"},
            "raw-jwt": {"title": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlMTIzNDU2"},
            "github-token": {"title": "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz"},
            "aws-access-key": {"title": "AKIA" + "0123456789ABCDEF"},
            "api-token": {"title": "sk-proj-0123456789abcdefghijklmnop"},
            "unc-path": {"intentSummary": r"read \\fileserver\private\config.json"},
        }
        for label, metadata in unsafe_cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as cap:
                _write_completed_archive(cap, **metadata)
                result = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                                    "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                                    "--knowledge-disposition", "no-reusable-experience",
                                    "--gate-status", "passed", "--strict")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(_read(os.path.join(cap, "spec.md")), "active")
                self.assertFalse(os.path.exists(os.path.join(cap, "history", "index", "task_123.json")))

    def test_history_index_rejects_sensitive_experience_projection_before_cleanup(self):
        unsafe_cases = {
            "absolute-code-path": ("src/payment/callback.ts", "/Users/example/.ssh/id_rsa"),
            "authorization": ("必须通过官方查询收敛终态", "Authorization: Bearer dummy-secret-value"),
        }
        for label, replacement in unsafe_cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as cap:
                _make_cap(cap)
                _write_valid_experience(cap)
                experience_path = os.path.join(cap, "experience.md")
                with open(experience_path, encoding="utf-8") as f:
                    experience = f.read()
                with open(experience_path, "w", encoding="utf-8") as f:
                    f.write(experience.replace(*replacement))
                with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                    f.write("stage: done\ntask-id: task_123\n")

                result = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                                    "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                                    "--knowledge-disposition", "local-only",
                                    "--gate-status", "passed", "--strict")

                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))
                self.assertFalse(os.path.exists(os.path.join(cap, "history", "index", "task_123.json")))

    def test_history_index_bounds_oversized_manifest_metadata(self):
        with tempfile.TemporaryDirectory() as cap:
            _write_completed_archive(cap, title="x" * (300 * 1024), keywords=["k" * 4096] * 100)
            result = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                                "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                                "--knowledge-disposition", "no-reusable-experience",
                                "--gate-status", "passed", "--strict")
            self.assertEqual(result.returncode, 0, result.stderr)
            index_path = os.path.join(cap, "history", "index", "task_123.json")
            self.assertLessEqual(os.path.getsize(index_path), 256 * 1024)
            with open(index_path, encoding="utf-8") as f:
                index = json.load(f)
            self.assertLessEqual(len(index["title"]), 500)
            self.assertLessEqual(len(index["keywords"]), intake.MAX_EXPERIENCE_INDEX_ITEMS)

    def test_legacy_manifest_path_traversal_is_rejected_without_deleting_repository(self):
        with tempfile.TemporaryDirectory() as repo:
            cap = os.path.join(repo, ".cap")
            archive = os.path.join(cap, "history", "task_attack")
            os.makedirs(archive)
            marker = os.path.join(repo, "keep", "data.txt")
            os.makedirs(os.path.dirname(marker))
            with open(marker, "w", encoding="utf-8") as f:
                f.write("keep")
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_attack\n")
            manifest = {
                "schemaVersion": 1, "taskId": "task_attack", "parentTaskId": "", "title": "attack",
                "intentSummary": "", "keywords": [], "branch": "main", "baseCommit": "abc",
                "deliveryCommit": VALID_COMMIT, "completedAt": "2026-08-17", "status": "completed",
                "artifacts": [{"path": "../keep/data.txt", "sha256": "invalid", "size": 4}],
            }
            with open(os.path.join(archive, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f)
            r = run_retire("--cap", cap, "--slug", "attack", "--date", "2026-08-17",
                           "--task-id", "task_attack", "--delivery-commit", VALID_COMMIT,
                           "--gate-status", "passed", "--strict")
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(os.path.isfile(marker))

    def test_legacy_manifest_cannot_retire_another_active_task(self):
        with tempfile.TemporaryDirectory() as cap:
            archive = os.path.join(cap, "history", "task_audit")
            os.makedirs(archive)
            archived_spec = os.path.join(archive, "spec.md")
            with open(archived_spec, "w", encoding="utf-8") as f:
                f.write("archived")
            with open(os.path.join(cap, "spec.md"), "w", encoding="utf-8") as f:
                f.write("current")
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: implement\ntask-id: task_other\n")
            manifest = {
                "schemaVersion": 1, "taskId": "task_audit", "parentTaskId": "", "title": "audit",
                "intentSummary": "", "keywords": [], "branch": "main", "baseCommit": "abc",
                "deliveryCommit": VALID_COMMIT, "completedAt": "2026-08-17", "status": "completed",
                "artifacts": [{"path": "spec.md", "sha256": intake._sha256(archived_spec), "size": 8}],
            }
            with open(os.path.join(archive, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f)
            r = run_retire("--cap", cap, "--slug", "audit", "--date", "2026-08-17",
                           "--task-id", "task_audit", "--gate-status", "pending", "--strict")
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(_read(os.path.join(cap, "spec.md")), "current")
            self.assertIn("task_other", _read(os.path.join(cap, "STATE.md")))

    def test_retirement_transaction_cannot_expand_manifest_cleanup_scope(self):
        with tempfile.TemporaryDirectory() as cap:
            archive = os.path.join(cap, "history", "task_123")
            os.makedirs(archive)
            archived_spec = os.path.join(archive, "spec.md")
            with open(archived_spec, "w", encoding="utf-8") as f:
                f.write("archived")
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            manifest = {
                "schemaVersion": 1, "taskId": "task_123", "parentTaskId": "", "title": "test",
                "intentSummary": "", "keywords": [], "branch": "main", "baseCommit": "abc",
                "deliveryCommit": VALID_COMMIT, "completedAt": "2026-08-17", "status": "completed",
                "artifacts": [{"path": "spec.md", "sha256": intake._sha256(archived_spec), "size": 8}],
            }
            transaction = {
                "schemaVersion": 1, "phase": "snapshot", "copied": ["spec.md", "STATE.md"],
                "historyMode": True,
                "request": {"taskId": "task_123", "leaf": "", "reqRootRelative": "", "evolutionEntry": ""},
            }
            with open(os.path.join(archive, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f)
            with open(os.path.join(archive, "retirement.json"), "w", encoding="utf-8") as f:
                json.dump(transaction, f)
            r = run_retire("--cap", cap, "--slug", "test", "--date", "2026-08-17",
                           "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                           "--gate-status", "passed", "--strict")
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(os.path.isfile(os.path.join(cap, "STATE.md")))

    def test_task_history_retire_is_idempotent(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            args = ("--cap", cap, "--slug", "feat", "--date", "2026-07-29",
                    "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                    "--knowledge-disposition", "no-reusable-experience",
                    "--gate-status", "passed", "--strict")
            first = run_retire(*args)
            second = run_retire(*args)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertTrue(json.loads(second.stdout)["idempotent"])

    def test_completed_retire_repairs_missing_or_corrupt_durable_index(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                f.write("stage: done\ntask-id: task_123\n")
            args = (
                "--cap", cap, "--slug", "feat", "--date", "2026-09-19",
                "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                "--knowledge-disposition", "no-reusable-experience",
                "--gate-status", "passed", "--strict",
            )
            first = run_retire(*args)
            self.assertEqual(first.returncode, 0, first.stderr)
            index_path = os.path.join(cap, "history", "index", "task_123.json")

            os.remove(index_path)
            repaired_missing = run_retire(*args)
            self.assertEqual(repaired_missing.returncode, 0, repaired_missing.stderr)
            self.assertTrue(json.loads(repaired_missing.stdout)["idempotent"])
            self.assertIsNotNone(intake._read_valid_history_index(cap, "task_123"))

            with open(index_path, "w", encoding="utf-8") as f:
                f.write('{"schemaVersion": 1, "taskId": "task_other"}\n')
            repaired_corrupt = run_retire(*args)
            self.assertEqual(repaired_corrupt.returncode, 0, repaired_corrupt.stderr)
            self.assertTrue(json.loads(repaired_corrupt.stdout)["idempotent"])
            self.assertIsNotNone(intake._read_valid_history_index(cap, "task_123"))

    def test_retire_recovers_every_transaction_phase_without_duplicate_backflow(self):
        for phase in ("snapshot", "cleanup", "index", "leaf", "backflow"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as cap:
                req = os.path.join(cap, "requirements")
                os.makedirs(req)
                write_leaf(req, "order.checkout.a")
                _make_cap(cap)
                with open(os.path.join(cap, "STATE.md"), "w", encoding="utf-8") as f:
                    f.write("stage: done\ntask-id: task_123\n")
                entry = "- 2026-08-17 · feat · 可恢复退场"
                args = ("--cap", cap, "--slug", "feat", "--date", "2026-08-17",
                        "--task-id", "task_123", "--delivery-commit", VALID_COMMIT,
                        "--knowledge-disposition", "no-reusable-experience",
                        "--gate-status", "passed", "--strict",
                        "--leaf", "order.checkout.a", "--req-root", req,
                        "--evolution-entry", entry)
                interrupted = run_retire(*args, env={"CAP_RETIRE_FAIL_AFTER": phase})
                self.assertNotEqual(interrupted.returncode, 0, interrupted.stdout)
                recovered = run_retire(*args)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                result = json.loads(recovered.stdout)
                self.assertTrue(result["recovered"])
                history = os.path.join(cap, "history", "task_123")
                with open(os.path.join(history, "retirement.json"), encoding="utf-8") as f:
                    transaction = json.load(f)
                self.assertEqual(transaction["phase"], "complete")
                self.assertEqual(transaction["request"]["reqRootRelative"], "requirements")
                self.assertNotIn(cap, json.dumps(transaction, ensure_ascii=False))
                self.assertTrue(os.path.isfile(os.path.join(cap, "history", "index", "task_123.json")))
                self.assertFalse(os.path.exists(os.path.join(cap, "STATE.md")))
                leaf = _read(os.path.join(req, "order", "checkout", "order.checkout.a.md"))
                self.assertIn("status: shipped", leaf)
                self.assertEqual(leaf.count("可恢复退场"), 1)
                evolution = _read(os.path.join(cap, "EVOLUTION.md"))
                self.assertEqual(evolution.count("可恢复退场"), 1)
                repeated = run_retire(*args)
                self.assertEqual(repeated.returncode, 0, repeated.stderr)
                self.assertTrue(json.loads(repeated.stdout)["idempotent"])

    def test_archives_and_clears(self):
        with tempfile.TemporaryDirectory() as cap:
            _make_cap(cap)
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16")
            self.assertEqual(r.returncode, 0, r.stderr)
            arch = os.path.join(cap, "archive", "2026-06-16-feat")
            for name in ("spec.md", "plan.md", "experience.md", "STATE.md", "verify", "review"):
                self.assertTrue(os.path.exists(os.path.join(arch, name)),
                                f"archived missing {name}")
                self.assertFalse(os.path.exists(os.path.join(cap, name)),
                                 f"top-level not cleared: {name}")

    def test_marks_leaf_shipped_and_unblocks(self):
        with tempfile.TemporaryDirectory() as cap:
            req = os.path.join(cap, "req")
            os.makedirs(req)
            write_leaf(req, "order.checkout.a", priority="P1")
            write_leaf(req, "order.checkout.b", priority="P0",
                       depends_on="[order.checkout.a]")
            _make_cap(cap, names=("STATE.md",), dirs=())
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--leaf", "order.checkout.a", "--req-root", req)
            self.assertEqual(r.returncode, 0, r.stderr)
            leaf_path = os.path.join(req, "order", "checkout", "order.checkout.a.md")
            self.assertIn("status: shipped", _read(leaf_path))
            rq = run("readyqueue", root=req)
            ids = [e["leaf_id"] for e in json.loads(rq.stdout)]
            self.assertEqual(ids, ["order.checkout.b"])  # downstream unblocked

    def test_backflow_always_evolution_md(self):
        # 即便目标有 PROFILE.md，回流也只进 EVOLUTION.md（PROFILE 仅留指针，不被追加）
        with tempfile.TemporaryDirectory() as cap:
            prof = os.path.join(cap, "PROFILE.md")
            with open(prof, "w", encoding="utf-8") as f:
                f.write("# Profile\n\n## Tech stack\npython\n")
            entry = "- 2026-06-16 · feat · lesson-X"
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--evolution-entry", entry)
            self.assertEqual(r.returncode, 0, r.stderr)
            ev_text = _read(os.path.join(cap, "EVOLUTION.md"))
            self.assertIn("lesson-X", ev_text)
            prof_text = _read(prof)
            self.assertNotIn("## Evolution log", prof_text)  # PROFILE 不承载流水
            self.assertNotIn("lesson-X", prof_text)

    def test_retire_rejects_profile_flag(self):
        # --profile 已废除：Evolution log 唯一正屋是 EVOLUTION.md，不再写 PROFILE 节
        with tempfile.TemporaryDirectory() as cap:
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--profile", os.path.join(cap, "PROFILE.md"),
                           "--evolution-entry", "- x")
            self.assertNotEqual(r.returncode, 0)  # argparse 拒绝未知参数
            self.assertIn("profile", (r.stderr + r.stdout).lower())

    def test_backflow_fallback_evolution_md(self):
        with tempfile.TemporaryDirectory() as cap:
            entry = "- 2026-06-16 · feat · lesson-Y"
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--evolution-entry", entry)
            self.assertEqual(r.returncode, 0, r.stderr)
            ev = os.path.join(cap, "EVOLUTION.md")
            self.assertTrue(os.path.exists(ev))
            self.assertIn("lesson-Y", _read(ev))

    def test_archive_exists_refuses(self):
        with tempfile.TemporaryDirectory() as cap:
            with open(os.path.join(cap, "spec.md"), "w", encoding="utf-8") as f:
                f.write("spec")
            os.makedirs(os.path.join(cap, "archive", "2026-06-16-feat"))
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16")
            self.assertNotEqual(r.returncode, 0)  # refuse to overwrite
            self.assertTrue(os.path.exists(os.path.join(cap, "spec.md")))  # untouched

    def test_no_leaf_graceful(self):
        with tempfile.TemporaryDirectory() as cap:
            with open(os.path.join(cap, "spec.md"), "w", encoding="utf-8") as f:
                f.write("spec")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(os.path.exists(
                os.path.join(cap, "archive", "2026-06-16-feat", "spec.md")))

    def test_marks_leaf_and_writes_cap_log(self):
        with tempfile.TemporaryDirectory() as cap:
            req = os.path.join(cap, "req")
            os.makedirs(req)
            write_leaf(req, "order.checkout.a", priority="P1")
            _make_cap(cap, names=("STATE.md",), dirs=())
            entry = "- 2026-06-16 · feat · 学到了X · → archive/2026-06-16-feat/"
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--leaf", "order.checkout.a", "--req-root", req,
                           "--evolution-entry", entry)
            self.assertEqual(r.returncode, 0, r.stderr)
            leaf = _read(os.path.join(req, "order", "checkout", "order.checkout.a.md"))
            self.assertIn("status: shipped", leaf)
            self.assertIn("## cap 记录", leaf)
            self.assertIn("学到了X", leaf)
            self.assertIn("学到了X", _read(os.path.join(cap, "EVOLUTION.md")))
            self.assertTrue(json.loads(r.stdout)["leaf_evolution"])

    def test_leaf_no_entry_no_cap_log(self):
        with tempfile.TemporaryDirectory() as cap:
            req = os.path.join(cap, "req")
            os.makedirs(req)
            write_leaf(req, "order.checkout.a")
            _make_cap(cap, names=("STATE.md",), dirs=())
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--leaf", "order.checkout.a", "--req-root", req)
            self.assertEqual(r.returncode, 0, r.stderr)
            leaf = _read(os.path.join(req, "order", "checkout", "order.checkout.a.md"))
            self.assertIn("status: shipped", leaf)
            self.assertNotIn("## cap 记录", leaf)

    def test_cap_log_appends_to_existing_section(self):
        with tempfile.TemporaryDirectory() as cap:
            req = os.path.join(cap, "req")
            os.makedirs(req)
            write_leaf(req, "order.checkout.a")
            lp = os.path.join(req, "order", "checkout", "order.checkout.a.md")
            with open(lp, "a", encoding="utf-8") as f:
                f.write("\n## cap 记录\n- 旧条目prior\n")
            _make_cap(cap, names=("STATE.md",), dirs=())
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--leaf", "order.checkout.a", "--req-root", req,
                           "--evolution-entry", "- 新条目fresh")
            self.assertEqual(r.returncode, 0, r.stderr)
            leaf = _read(lp)
            self.assertEqual(leaf.count("## cap 记录"), 1)
            self.assertIn("旧条目prior", leaf)
            self.assertIn("新条目fresh", leaf)

    def test_no_leaf_still_only_evolution(self):
        with tempfile.TemporaryDirectory() as cap:
            with open(os.path.join(cap, "spec.md"), "w", encoding="utf-8") as f:
                f.write("spec")
            r = run_retire("--cap", cap, "--slug", "feat", "--date", "2026-06-16",
                           "--evolution-entry", "- 无叶entry")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIsNone(json.loads(r.stdout)["leaf_evolution"])
            self.assertIn("无叶entry", _read(os.path.join(cap, "EVOLUTION.md")))

    def test_evolution_window_only_prunes_entries_with_durable_task_indexes(self):
        with tempfile.TemporaryDirectory() as cap:
            index_root = os.path.join(cap, "history", "index")
            os.makedirs(index_root)
            for number in range(51):
                task_id = f"task_{number:02d}"
                with open(os.path.join(index_root, f"{task_id}.json"), "w", encoding="utf-8") as f:
                    json.dump(_valid_history_index(task_id), f)
                intake._append_evolution(cap, f"- 2026-09-18 · [task:{task_id}] · lesson {number}")
            lines = [line for line in _read(os.path.join(cap, "EVOLUTION.md")).splitlines()
                     if line.startswith("-")]
            self.assertEqual(len(lines), 50)
            self.assertNotIn("task_00", "\n".join(lines))

            os.remove(os.path.join(index_root, "task_01.json"))
            intake._append_evolution(cap, "- 2026-09-18 · [task:task_51] · lesson 51")
            lines = [line for line in _read(os.path.join(cap, "EVOLUTION.md")).splitlines()
                     if line.startswith("-")]
            self.assertGreaterEqual(len(lines), 51)
            self.assertIn("task_01", "\n".join(lines))

    def test_evolution_durability_rejects_empty_malformed_symlink_and_task_mismatch_indexes(self):
        with tempfile.TemporaryDirectory() as cap:
            index_root = os.path.join(cap, "history", "index")
            os.makedirs(index_root)
            path = os.path.join(index_root, "task_bad.json")

            with open(path, "w", encoding="utf-8") as f:
                f.write("")
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] empty"))

            with open(path, "w", encoding="utf-8") as f:
                f.write("{bad json")
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] malformed"))

            with open(path, "w", encoding="utf-8") as f:
                json.dump(_valid_history_index("task_other"), f)
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] mismatch"))

            os.remove(path)
            outside = os.path.join(cap, "outside.json")
            with open(outside, "w", encoding="utf-8") as f:
                json.dump(_valid_history_index("task_bad"), f)
            os.symlink(outside, path)
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] symlink"))

    def test_evolution_and_audit_reject_symlinked_history_index_parent(self):
        with tempfile.TemporaryDirectory() as cap, tempfile.TemporaryDirectory() as outside:
            outside_history = os.path.join(outside, "history")
            outside_index = os.path.join(outside_history, "index")
            os.makedirs(outside_index)
            with open(os.path.join(outside_index, "task_external.json"), "w", encoding="utf-8") as f:
                json.dump(_valid_history_index("task_external"), f)
            os.symlink(outside_history, os.path.join(cap, "history"))

            self.assertFalse(intake._evolution_entry_is_durable(
                cap, "- [task:task_external] external index must not authorize pruning"))
            audit = run_knowledge_audit(cap)
            self.assertEqual(audit.returncode, 0, audit.stderr)
            result = json.loads(audit.stdout)
            self.assertEqual(result["indexes"]["count"], 0)
            self.assertTrue(result["indexes"]["invalidRoot"])

    def test_evolution_durability_rejects_unknown_and_sensitive_index_fields(self):
        with tempfile.TemporaryDirectory() as cap:
            index_root = os.path.join(cap, "history", "index")
            os.makedirs(index_root)
            path = os.path.join(index_root, "task_bad.json")

            unknown = _valid_history_index("task_bad")
            unknown["unreviewedMetadata"] = "must not authorize pruning"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(unknown, f)
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] unknown"))

            sensitive = _valid_history_index("task_bad")
            sensitive["title"] = "Authorization: Bearer dummy-secret-value"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(sensitive, f)
            self.assertFalse(intake._evolution_entry_is_durable(cap, "- [task:task_bad] sensitive"))

    def test_knowledge_audit_is_read_only_and_reports_legacy_pending_and_capacity(self):
        with tempfile.TemporaryDirectory() as repo:
            cap = os.path.join(repo, ".cap")
            index_root = os.path.join(cap, "history", "index")
            os.makedirs(index_root)
            with open(os.path.join(index_root, "legacy.json"), "w", encoding="utf-8") as f:
                legacy = _valid_history_index("legacy")
                legacy.pop("knowledgeDisposition")
                json.dump(legacy, f)
            with open(os.path.join(index_root, "pending.json"), "w", encoding="utf-8") as f:
                pending = _valid_history_index("pending")
                pending["knowledgeDisposition"] = "pending-sync"
                json.dump(pending, f)
            with open(os.path.join(index_root, "invalid-shape.json"), "w", encoding="utf-8") as f:
                invalid = _valid_history_index("invalid-shape")
                invalid["knowledgeDisposition"] = {"forged": "pending-sync"}
                json.dump(invalid, f)
            with open(os.path.join(cap, "EVOLUTION.md"), "w", encoding="utf-8") as f:
                f.write("# Evolution log\n\n" + "\n".join(f"- line {n}" for n in range(51)) + "\n")
            before = {path: _read(os.path.join(index_root, path)) for path in os.listdir(index_root)}
            result = run_knowledge_audit(cap)
            self.assertEqual(result.returncode, 0, result.stderr)
            audit = json.loads(result.stdout)
            self.assertEqual(audit["indexes"]["count"], 3)
            self.assertEqual(audit["indexes"]["legacyUnknown"], 1)
            self.assertEqual(audit["indexes"]["pendingSync"], 1)
            self.assertEqual(audit["indexes"]["invalid"], 1)
            self.assertEqual(audit["evolution"]["entries"], 51)
            self.assertTrue(audit["evolution"]["overBudget"])
            after = {path: _read(os.path.join(index_root, path)) for path in os.listdir(index_root)}
            self.assertEqual(before, after)

    def test_gitignore_tracks_only_history_indexes(self):
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as source:
                rules = source.read()
            with open(os.path.join(repo, ".gitignore"), "w", encoding="utf-8") as target:
                target.write(rules)
            os.makedirs(os.path.join(repo, ".cap", "history", "index"), exist_ok=True)
            os.makedirs(os.path.join(repo, ".cap", "history", "task_1"), exist_ok=True)
            index_path = os.path.join(repo, ".cap", "history", "index", "task_1.json")
            raw_path = os.path.join(repo, ".cap", "history", "task_1", "experience.md")
            with open(index_path, "w", encoding="utf-8") as f:
                f.write("{}\n")
            with open(raw_path, "w", encoding="utf-8") as f:
                f.write("raw\n")
            index_check = subprocess.run(["git", "check-ignore", "-q", index_path], cwd=repo)
            raw_check = subprocess.run(["git", "check-ignore", "-q", raw_path], cwd=repo)
            self.assertNotEqual(index_check.returncode, 0)
            self.assertEqual(raw_check.returncode, 0)


class TreeTest(unittest.TestCase):
    def test_nests_and_counts(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="shipped", priority="P1")
            write_leaf(root, "order.checkout.b", depends_on="[order.checkout.a]")
            write_leaf(root, "user.auth.c", status="built")
            r = run("tree", root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            t = json.loads(r.stdout)
            doms = {d["domain"]: d for d in t["domains"]}
            self.assertEqual(set(doms), {"order", "user"})
            subs = doms["order"]["subdomains"]
            ids = [lf["id"] for s in subs for lf in s["leaves"]]
            self.assertIn("order.checkout.a", ids)
            self.assertEqual(t["summary"]["total"], 3)
            self.assertEqual(t["summary"]["by_status"]["shipped"], 1)
            self.assertEqual(t["summary"]["ready_count"], 2)  # a shipped→不入; b解锁; c无dep

    def test_empty_tree_ok(self):
        with tempfile.TemporaryDirectory() as root:
            r = run("tree", root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["summary"]["total"], 0)


class MoveTest(unittest.TestCase):
    def test_relocates_and_rewrites_deps(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a")
            write_leaf(root, "user.auth.b", depends_on="[order.checkout.a]")
            r = run("move", "--leaf", "order.checkout.a", "--to", "billing/pay", root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            new = os.path.join(root, "billing", "pay", "billing.pay.a.md")
            self.assertTrue(os.path.exists(new))
            self.assertFalse(os.path.exists(
                os.path.join(root, "order", "checkout", "order.checkout.a.md")))
            txt = _read(new)
            self.assertIn("id: billing.pay.a", txt)
            self.assertIn("domain_path: billing/pay", txt)
            dep = _read(os.path.join(root, "user", "auth", "user.auth.b.md"))
            self.assertIn("billing.pay.a", dep)          # dep 改写
            self.assertNotIn("order.checkout.a", dep)

    def test_refuses_existing_target(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a")
            write_leaf(root, "billing.pay.a")            # 目标已占用
            r = run("move", "--leaf", "order.checkout.a", "--to", "billing/pay", root=root)
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(os.path.exists(
                os.path.join(root, "order", "checkout", "order.checkout.a.md")))  # 未动

    def test_missing_source_nonzero(self):
        with tempfile.TemporaryDirectory() as root:
            r = run("move", "--leaf", "ghost.x.y", "--to", "a/b", root=root)
            self.assertNotEqual(r.returncode, 0)

    def test_rejects_path_traversal_to(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a")
            for bad in ("../evil", "a/../../etc", "a/./b", ".."):
                r = run("move", "--leaf", "order.checkout.a", "--to", bad, root=root)
                self.assertNotEqual(r.returncode, 0, f"应拒绝非法 --to: {bad}")
            # 源叶未被移动
            self.assertTrue(os.path.exists(
                os.path.join(root, "order", "checkout", "order.checkout.a.md")))


class BoardTest(unittest.TestCase):
    def test_renders_tree_with_chat_panel(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="shipped", title="结算下单")
            write_leaf(root, "user.auth.b", status="captured")
            out = os.path.join(root, "_board.html")
            r = run("board", "--out", out, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            html = _read(out)
            self.assertIn("order.checkout.a", html)
            self.assertIn("结算下单", html)
            self.assertIn("<details", html)              # 折叠树结构
            self.assertIn("status-shipped", html)         # 状态徽章类
            self.assertIn("--green:", html)               # DESIGN token
            # 叶卡可选中(点击 → 聊天)
            self.assertIn('data-leaf="order.checkout.a"', html)
            # 右侧聊天面板(替代批注层)
            self.assertIn("chat-panel", html)
            self.assertIn("chat-input", html)
            # 实时回路:发送 POST /feedback、轮询 /replies.json 与 /rev
            self.assertIn("/feedback", html)
            self.assertIn("/replies.json", html)
            self.assertIn("/rev", html)
            # 不再注入 annotate 批注层(改用自建聊天)
            self.assertNotIn("annotate.js", html)
            # 叶详情数据嵌入(选叶后面板顶部显示字段+正文)
            self.assertIn("leaf-data", html)
            self.assertIn("test leaf order.checkout.a", html)   # 正文进了详情数据

    def test_board_escapes_html_in_leaf_content(self):
        # 信任边界:叶内容里的 HTML 不得原样进页面(防注入)
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", title="<script>alert(1)</script>")
            out = os.path.join(root, "_board.html")
            r = run("board", "--out", out, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            html = _read(out)
            self.assertNotIn("<script>alert(1)</script>", html)   # 未原样出现
            self.assertIn("&lt;script&gt;", html)                 # 已转义

    def test_board_leafdata_has_cross_fields(self):
        with tempfile.TemporaryDirectory() as root:
            _write_leaf_extra(root, "order.checkout.a", "actor: 采购\nfailure_class: funds\n")
            out = os.path.join(root, "_b.html")
            r = run("board", "--out", out, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            html = _read(out)
            self.assertIn('"actor"', html)     # leaf-data JSON 含交叉字段
            self.assertIn("ld-cross", html)     # 详情渲染交叉行(JS/CSS 容器)

    def test_board_embeds_leaf_body_and_fields(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", old_system_ref="legacy/CartServlet",
                       depends_on="[order.checkout.x]")
            write_leaf(root, "order.checkout.x")
            out = os.path.join(root, "_board.html")
            r = run("board", "--out", out, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            html = _read(out)
            self.assertIn("legacy/CartServlet", html)            # old_system_ref 入详情
            self.assertIn("order.checkout.x", html)              # depends_on 入详情

    def test_empty_tree_placeholder(self):
        with tempfile.TemporaryDirectory() as root:
            out = os.path.join(root, "_board.html")
            r = run("board", "--out", out, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("暂无需求", _read(out))


def _write_leaf_extra(root, id, extra_lines):
    """写一片叶,frontmatter 末尾插入 extra_lines(用于测可选交叉字段)。"""
    domain_path = "/".join(id.split(".")[:2])
    d = os.path.join(root, *domain_path.split("/"))
    os.makedirs(d, exist_ok=True)
    fm = (f"---\nid: {id}\ntitle: t\ndomain_path: {domain_path}\ncross_link: []\n"
          f"old_system_ref: r-{id}\nnew_domain_path: {domain_path}\nstatus: captured\n"
          f"priority: P2\ndepends_on: []\nrisk_level: medium\nupdated: 2026-06-16\n"
          + extra_lines + "---\n\n## 需求描述\nx\n")
    with open(os.path.join(d, id + ".md"), "w", encoding="utf-8") as f:
        f.write(fm)


class LintCrossFieldTest(unittest.TestCase):
    def test_valid_cross_fields_clean(self):
        with tempfile.TemporaryDirectory() as root:
            _write_leaf_extra(root, "order.checkout.a",
                "actor: 运营\nfailure_class: funds\n"
                "contract_refs: [contracts/provided/bff]\ndata_owner: order-svc\n")
            r = run("lint", root=root)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_no_cross_fields_still_clean(self):  # 存量树不受影响
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a")
            self.assertEqual(run("lint", root=root).returncode, 0)

    def test_bad_failure_class_flagged(self):
        with tempfile.TemporaryDirectory() as root:
            _write_leaf_extra(root, "order.checkout.a", "failure_class: 乱写\n")
            r = run("lint", root=root)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("bad-failure-class", r.stdout + r.stderr)


class WriteTreeTest(unittest.TestCase):
    def test_writes_leaves_with_optional_fields(self):
        with tempfile.TemporaryDirectory() as root:
            tree = {"leaves": [
                {"id": "order.checkout.place", "title": "作为采购我要下单以便采货",
                 "domain_path": "order/checkout", "cross_link": [],
                 "old_system_ref": "apps/api/modules/order", "new_domain_path": "order/checkout",
                 "status": "captured", "priority": "P1", "depends_on": [], "risk_level": "high",
                 "actor": "采购", "failure_class": "consistency",
                 "contract_refs": ["contracts/provided/bff"], "data_owner": "order-svc"}]}
            fp = os.path.join(root, "tree.json")
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(tree, f, ensure_ascii=False)
            r = run("write-tree", "--from", fp, root=root)
            self.assertEqual(r.returncode, 0, r.stderr)
            leaf = _read(os.path.join(root, "order", "checkout", "order.checkout.place.md"))
            self.assertIn("id: order.checkout.place", leaf)
            self.assertIn("failure_class: consistency", leaf)
            self.assertIn("actor: 采购", leaf)
            self.assertIn("作为采购我要下单", leaf)
            self.assertEqual(run("lint", root=root).returncode, 0, "写出的树应 lint clean")
            self.assertEqual(json.loads(r.stdout)["written"], 1)

    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            tree = {"leaves": [
                {"id": "x.y.a", "title": "t", "domain_path": "../../etc", "cross_link": [],
                 "old_system_ref": "r", "new_domain_path": "x/y", "status": "captured",
                 "priority": "P2", "depends_on": [], "risk_level": "low"},
                {"id": "../../evil", "title": "t", "domain_path": "x/y", "cross_link": [],
                 "old_system_ref": "r", "new_domain_path": "x/y", "status": "captured",
                 "priority": "P2", "depends_on": [], "risk_level": "low"}]}
            fp = os.path.join(root, "t.json")
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(tree, f, ensure_ascii=False)
            r = run("write-tree", "--from", fp, root=root)
            self.assertEqual(json.loads(r.stdout)["written"], 0)   # 两条都被拒
            self.assertEqual(json.loads(r.stdout)["skipped"], 2)
            self.assertFalse(os.path.exists(os.path.join(root, "..", "etc")))  # 未逃出 root

    def test_skips_existing_leaf(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", title="原有")
            tree = {"leaves": [{"id": "order.checkout.a", "title": "新的",
                "domain_path": "order/checkout", "cross_link": [], "old_system_ref": "r",
                "new_domain_path": "order/checkout", "status": "captured", "priority": "P2",
                "depends_on": [], "risk_level": "low"}]}
            fp = os.path.join(root, "t.json")
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(tree, f, ensure_ascii=False)
            r = run("write-tree", "--from", fp, root=root)
            self.assertEqual(json.loads(r.stdout)["skipped"], 1)
            self.assertIn("原有", _read(os.path.join(root, "order", "checkout", "order.checkout.a.md")))


class BoardRenoTest(unittest.TestCase):
    """看板 4 痛点重构:①进度/图例/过滤 ②搜索/折叠记忆/面包屑 ③字段分组/dep可点/tooltip ④聊天状态提示。"""
    def _render(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="shipped", title="下单")
            write_leaf(root, "order.checkout.b", status="captured",
                       depends_on="[order.checkout.a]")
            out = os.path.join(root, "b.html")
            run("board", "--out", out, root=root)
            return _read(out)

    def test_pain1_legend_and_distribution(self):
        h = self._render()
        self.assertIn('class="legend"', h)      # 图例
        self.assertIn('class="dist"', h)         # 进度分布条(分段)

    def test_pain2_search_and_breadcrumb(self):
        h = self._render()
        self.assertIn('id="tree-search"', h)     # 搜索框
        self.assertIn('crumb', h)                # 面包屑容器
        self.assertIn('localStorage', h)         # 折叠记忆

    def test_pain3_field_grouping_and_dep_link(self):
        h = self._render()
        self.assertIn('dep-link', h)             # depends_on 可点
        self.assertIn('身份', h)                  # 字段分组小标题
        self.assertIn('交叉', h)

    def test_pain4_chat_live_status(self):
        h = self._render()
        self.assertIn('id="live-status"', h)     # 监听状态指示


class BoardLiveBadgeTest(unittest.TestCase):
    def _setup(self, with_state=True, stage="implement"):
        self.tmp = tempfile.mkdtemp()
        req = os.path.join(self.tmp, "requirements")
        write_leaf(req, "user.auth.login", status="captured", title="登录")
        if with_state:
            with open(os.path.join(self.tmp, "STATE.md"), "w", encoding="utf-8") as f:
                f.write(f"# Cap State: x\nstage: {stage}\nsource-leaf: user.auth.login\n")
        return req

    def test_overlay_when_state_present(self):
        req = self._setup(stage="implement")
        out = os.path.join(self.tmp, "b.html")
        r = run("board", "--out", out, root=req)
        self.assertEqual(r.returncode, 0)
        html_txt = _read(out)
        self.assertIn('class="live-badge', html_txt)  # 真元素(非 CSS 规则)
        self.assertIn("implement中", html_txt)        # 在飞 stage 显示

    def test_no_overlay_without_state(self):
        req = self._setup(with_state=False)
        out = os.path.join(self.tmp, "b.html")
        run("board", "--out", out, root=req)
        self.assertNotIn('class="live-badge', _read(out))  # 无在飞元素(CSS 规则不算)


def _leaf_status(root, leaf_id):
    dp = "/".join(leaf_id.split(".")[:2])
    txt = _read(os.path.join(root, *dp.split("/"), leaf_id + ".md"))
    for line in txt.splitlines():
        if line.startswith("status:"):
            return line.split(":", 1)[1].strip()
    return None


class SetStatusTest(unittest.TestCase):
    def test_success(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "user.auth.login", status="captured")
            r = run("set-status", "--leaf", "user.auth.login", "--to", "built", root=root)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(_leaf_status(root, "user.auth.login"), "built")

    def test_allow_any_backward(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "user.auth.login", status="verified")
            r = run("set-status", "--leaf", "user.auth.login", "--to", "shaped", root=root)
            self.assertEqual(r.returncode, 0)  # allow-any:回退也允许
            self.assertEqual(_leaf_status(root, "user.auth.login"), "shaped")

    def test_bad_value(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "user.auth.login", status="captured")
            r = run("set-status", "--leaf", "user.auth.login", "--to", "banana", root=root)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(_leaf_status(root, "user.auth.login"), "captured")  # 未写

    def test_missing_leaf(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "user.auth.login", status="captured")
            r = run("set-status", "--leaf", "nope.x.y", "--to", "built", root=root)
            self.assertEqual(r.returncode, 2)


class LintBadStatusTest(unittest.TestCase):
    def test_rejects_unknown_status(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="banana")
            r = run("lint", root=root)
            self.assertEqual(r.returncode, 1)
            self.assertIn("bad-status", r.stderr)

    def test_accepts_valid_status(self):
        with tempfile.TemporaryDirectory() as root:
            write_leaf(root, "order.checkout.a", status="built")
            r = run("lint", root=root)
            self.assertEqual(r.returncode, 0)


class StatusEnumTest(unittest.TestCase):
    def test_order_endpoints(self):
        self.assertEqual(intake.STATUS_ORDER[0], "captured")
        self.assertEqual(intake.STATUS_ORDER[-1], "shipped")

    def test_set_matches_order(self):
        self.assertEqual(intake.STATUS_SET, set(intake.STATUS_ORDER))

    def test_stage_map(self):
        self.assertEqual(intake.STAGE_TO_STATUS["define"], "shaped")
        self.assertEqual(intake.STAGE_TO_STATUS["implement"], "built")
        self.assertEqual(intake.STAGE_TO_STATUS["test"], "verified")
        self.assertEqual(intake.normalize_stage("shape"), "define")
        self.assertEqual(intake.normalize_stage("build"), "implement")
        self.assertEqual(intake.normalize_stage("verify"), "test")


if __name__ == "__main__":
    unittest.main()
