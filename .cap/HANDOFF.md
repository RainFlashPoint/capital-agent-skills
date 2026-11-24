{
  "schema": "cap-team-handoff/v1",
  "repository": "remote:github.com/RainFlashPoint/capital-agent-skills",
  "branch": "codex/macos-runner-sandbox-fix",
  "baseCommit": "9fcb36174bb864da76eec45f593a678d8260729d",
  "sourceCommit": "2efb988e5ae536053d112bfb2d8ea5caa3afcf52",
  "sourceTree": "4118e22686a86e9a6842ee0b88595ee178b29204",
  "changedFiles": [
    "CHANGELOG.md",
    "runtime/local-test-provider.mjs",
    "scripts/test-local-test-provider.mjs"
  ],
  "intent": "Restore system Python startup for the macOS Test Runner and cover credential-lock recovery.",
  "decisions": "Allow the required system toolchain selector and Command Line Tools reads while keeping the existing host file, signal, and IPC restrictions.",
  "nextActions": "Observe GitHub CI for the development branch and track automatic Runner pickup and Review on a separately eligible Server candidate.",
  "verification": "The source commit passed 60 tests on macOS with zero failures or skips, including Python startup, credential-lock recovery, and isolation regressions. Skill validation and git diff --check passed locally. Remote verification is pending.",
  "invalidatesOn": "Changes to the source tree, sandbox policy, or supported OS toolchain require re-verification.",
  "verificationStatus": "pending-verification",
  "nonTransferable": "Task / Session / authorization / Gate / Delivery / Outbox / PASS",
  "summarySha256": "e7694588669465f7281001fdb9fac41bbba1591de90e0e28a8726e275b5c8e75"
}
