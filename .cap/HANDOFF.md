{
  "schema": "cap-team-handoff/v1",
  "repository": "remote:github.com/RainFlashPoint/capital-agent-skills",
  "branch": "codex/cap-test-state-machine",
  "baseCommit": "18996d6d3654570c64ed2661f88955b7ca5ca581",
  "sourceCommit": "7894709aaf9f34dbb0d0c928c663d52b2a9aa6c6",
  "sourceTree": "752c91a9805d469f953e1a829d71dd46f63f7c24",
  "changedFiles": [
    "CHANGELOG.md",
    "CLAUDE.md",
    "scripts/cap-context-gc.mjs",
    "scripts/test-cap-context-gc.mjs",
    "scripts/test-cap-history-recon.mjs",
    "skills/cap-flow/references/collaboration-discipline.md",
    "skills/cap-flow/references/context-compaction.md",
    "skills/cap-flow/references/task-reconnaissance.md",
    "skills/cap-flow/references/team-git-handoff.md"
  ],
  "intent": "Converge Capital Agent context runtime artifacts by reference reachability and make reviewed retained records available for Git sharing",
  "decisions": "Preserve current and historical referenced chains; quarantine unreferenced files; prune only an exact reviewed quarantine inventory under writer locks; list retained artifacts and task documents with hashes for separate privacy and ownership review",
  "nextActions": "Receiving clone verifies this summary and the referenced Commit, reviews retained records before Git tracking, and rebuilds its own Task, Session, authorization and tests",
  "verification": "Local release-check passed on source Commit 7894709aaf9f34dbb0d0c928c663d52b2a9aa6c6; remote CI and receiving-clone verification are pending",
  "invalidatesOn": "Source Commit, Git tree, branch, changed paths, runtime retention policy, repository identity or user authorization changes",
  "verificationStatus": "pending-verification",
  "nonTransferable": "Task / Session / authorization / Gate / Delivery / Outbox / PASS",
  "summarySha256": "7b19c33cb3a128d0556bc441075c2ee812c63cc8b6257e9a58036a08c7aa1b5e"
}
