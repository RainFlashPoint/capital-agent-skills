import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compactCapStatus, statusDecisionSignature } from './cap-status.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function mockStatus(overrides = {}) {
  const base = {
    mode: 'local_explicit',
    installation: { status: 'current', upgradeRecommended: false, bootstrapRecommended: false, reason: '', changedFiles: [], sourceRoot: '/mock/package', nextActions: [] },
    platform: {
      configured: false, connected: null, serverUrl: '', handshake: null, mcpRuntime: 'missing', localFallback: false,
      runtime: null, pendingDeliveries: { total: 0, sent: 0, pending: 0, confirmed: 0 },
      outbox: { totalPending: 0, pending: 0, historicalPending: 0, retainedHistoricalPending: 0, unscopedPending: 0, retainedUnscopedPending: 0, ready: 0, blocked: 0, oldestCreatedAt: '', next: null, events: [] },
    },
    repository: {
      root: '/mock/repo', remote: 'git@example.test:org/repo.git', branch: 'feature/mock', head: 'a'.repeat(40),
      upstream: 'origin/feature/mock', upstreamHead: 'a'.repeat(40), dirty: false, harnessMode: 'local-only', harnessEligible: false,
      sessionRoot: { enforced: true, blocked: false, code: '', reason: 'match', expectedRoot: '/mock/repo', currentRoot: '/mock/repo' },
    },
    task: {
      id: 'local-mock', previousId: '', sessionId: 'session-mock', previousSessionId: '', requiresNewSession: false,
      remoteStatus: '', remoteStage: '', gatesReady: false, currentCommit: '', currentGate: '', currentAction: null, blocker: null,
      nextAction: null, executionMode: 'skills', verificationCommands: ['node --test scripts/test-cap-status-compact.mjs'],
      parentTaskId: '', retirementStatus: 'active', historyArtifactRoot: '',
      localExecution: { source: 'local_state', stage: 'implement', status: 'in-progress', nextAction: '编码实现', gated: false, executionRequired: false, executionAction: null, executionGate: 'not-required', executionArtifact: '', executionReason: '', nextActions: [], remediation: '' },
      serverDelivery: { source: 'server_unobserved', taskId: '', stage: '', status: '', currentCommit: '', currentGate: '', action: null, gatesReady: false },
    },
    reconciliation: { recordedHead: 'a'.repeat(40), headPushed: true, pushRequired: false, initialDeliveryNeeded: false, localUnrecorded: false, remoteUnrecorded: false, needsDeliveryReconciliation: false, unrecordedCommits: [] },
    boundary: { blocked: false, code: '', mismatches: [], state: { taskId: 'local-mock', sessionId: 'session-mock', branch: 'feature/mock', worktree: '/mock/repo' }, current: { branch: 'feature/mock', worktree: '/mock/repo' }, detail: '', remediation: '' },
    correction: { required: false, reason: '' },
    nextActions: [], remediation: '',
    workflow: { currentStage: 'implement', status: 'in-progress', stage: 'implement', action: '编码实现', reason: '计划已就绪', gated: false },
    reasons: [],
  }
  return { ...base, ...overrides }
}

const normalCases = [
  ['local implementation', mockStatus()],
  ['skill version drift', mockStatus({
    installation: { status: 'drifted', upgradeRecommended: true, bootstrapRecommended: false, reason: 'source_commit_changed', changedFiles: Array.from({ length: 24 }, (_, index) => `skills/mock-${index}/SKILL.md`), sourceRoot: '/mock/package', nextActions: [{ kind: 'upgrade_local_skills', label: '升级本地 Skills 并重新检查', reason: 'source_commit_changed', requiresUser: false }] },
    nextActions: [{ kind: 'upgrade_local_skills', label: '升级本地 Skills 并重新检查', reason: 'source_commit_changed', requiresUser: false }],
    workflow: { currentStage: 'implement', status: 'in-progress', stage: 'implement', action: '升级本地 Skills', reason: '检测到 Skills 漂移', gated: false, upgradeRecommended: true, upgradeReason: 'source_commit_changed' },
    reasons: ['skill_upgrade_source_commit_changed'],
  })],
  ['restart required', mockStatus({
    mode: 'restart_required',
    task: { ...mockStatus().task, blocker: { code: 'mcp_runtime_missing_restart_required', detail: '当前会话没有加载 MCP', remediation: '重启或明确本次本地继续' } },
    workflow: { currentStage: 'implement', status: 'gated', stage: 'implement', action: '选择运行方式', reason: 'MCP 未加载', gated: true, options: [{ id: 'restart', label: '重启' }, { id: 'local_once', label: '本地继续' }] },
    reasons: ['mcp_runtime_missing_restart_required'],
  })],
  ['platform probe rejected', mockStatus({
    mode: 'platform_unverified',
    platform: { ...mockStatus().platform, configured: true, connected: false, mcpRuntime: 'loaded', handshake: { ok: false, reason: 'rejected', status: 401 } },
    reasons: ['platform_handshake_rejected_needs_mcp_confirmation'],
  })],
  ['platform action', mockStatus({
    mode: 'platform_attached',
    platform: { ...mockStatus().platform, configured: true, connected: true, serverUrl: 'https://platform.example.test', mcpRuntime: 'loaded', runtime: { buildCommit: 'server123', schemaRevision: '17', taskStoreMode: 'mysql', database: 'ready' } },
    repository: { ...mockStatus().repository, harnessMode: 'server', harnessEligible: true },
    task: { ...mockStatus().task, id: 'task-1', sessionId: 'session-1', remoteStatus: 'in_progress', remoteStage: 'test', currentCommit: 'b'.repeat(40), currentGate: 'test', currentAction: { actionId: 'action-1', actionType: 'test', actionStatus: 'running', commitSha: 'b'.repeat(40), provider: { verbose: 'not needed in compact' } }, nextAction: { kind: 'action', actionId: 'action-1', actionType: 'test', actionStatus: 'running', commitSha: 'b'.repeat(40), label: '等待测试' }, serverDelivery: { source: 'server_task', taskId: 'task-1', stage: 'test', status: 'in_progress', currentCommit: 'b'.repeat(40), currentGate: 'test', action: { actionId: 'action-1', actionType: 'test', actionStatus: 'running', commitSha: 'b'.repeat(40) }, gatesReady: false } },
    workflow: { currentStage: 'test', status: 'in_progress', stage: 'test', action: '等待测试 Action', reason: '候选已登记', gated: true, platformAction: { actionId: 'action-1', actionType: 'test', actionStatus: 'running', commitSha: 'b'.repeat(40), provider: { verbose: 'excluded' } } },
  })],
  ['known provider blocker', mockStatus({
    task: { ...mockStatus().task, blocker: { code: 'provider_unavailable', reason: 'provider_not_healthy', category: 'provider', classification: 'capacity', stage: 'preflight', detail: 'runner offline', remediation: 'restore runner', preflight: { code: 'provider_not_healthy', reason: 'health_rejected', detail: 'health probe failed', remediation: 'restart provider', status: 'failed' } } },
    workflow: { currentStage: 'test', status: 'gated', stage: 'test', action: '恢复 Provider', reason: 'provider unavailable', gated: true },
  })],
  ['push required', mockStatus({ reconciliation: { ...mockStatus().reconciliation, headPushed: false, pushRequired: true, remoteUnrecorded: true, needsDeliveryReconciliation: true, unrecordedCommits: Array.from({ length: 12 }, (_, index) => `${String(index).padStart(40, 'c')}\tcommit ${index}`) }, reasons: ['git_delivery_reconciliation_needed'] })],
  ['current outbox pending', mockStatus({
    platform: { ...mockStatus().platform, configured: true, mcpRuntime: 'loaded', outbox: { totalPending: 9, pending: 3, historicalPending: 6, retainedHistoricalPending: 6, unscopedPending: 0, retainedUnscopedPending: 0, ready: 3, blocked: 0, oldestCreatedAt: '2026-09-17T00:00:00Z', next: { id: 'event-1', type: 'record_task_delivery', localTaskRef: 'local-mock', payload: { verbose: 'excluded' } }, events: Array.from({ length: 9 }, (_, index) => ({ id: `event-${index}`, payload: { large: 'x'.repeat(100) } })) } },
  })],
]

test('compact projection preserves the decision signature for normal mock tasks', () => {
  for (const [name, full] of normalCases) {
    const compact = compactCapStatus(full)
    assert.equal(compact.outputMode, 'compact', name)
    assert.deepEqual(statusDecisionSignature(compact), statusDecisionSignature(full), name)
  }
})

test('real Server aliases and provider preflight remain explicit in compact output', () => {
  const actionStatus = compactCapStatus(normalCases.find(([name]) => name === 'platform action')[1])
  assert.equal(actionStatus.task.currentAction.id, 'action-1')
  assert.equal(actionStatus.task.currentAction.type, 'test')
  assert.equal(actionStatus.task.currentAction.status, 'running')
  assert.equal(actionStatus.task.currentAction.commit, 'b'.repeat(40))
  assert.equal(actionStatus.task.nextAction.kind, 'action')
  assert.equal(actionStatus.task.nextAction.id, 'action-1')
  assert.equal(actionStatus.task.nextAction.type, 'test')
  assert.equal(actionStatus.task.nextAction.status, 'running')
  assert.equal(actionStatus.task.nextAction.commit, 'b'.repeat(40))
  assert.equal(actionStatus.task.nextAction.label, '等待测试')
  assert.equal(actionStatus.workflow.platformAction.id, 'action-1')
  assert.equal(actionStatus.workflow.platformAction.status, 'running')
  assert.equal(actionStatus.task.serverDelivery.action.id, 'action-1')
  assert.equal(actionStatus.task.serverDelivery.action.commit, 'b'.repeat(40))

  const blockerStatus = compactCapStatus(normalCases.find(([name]) => name === 'known provider blocker')[1])
  assert.equal(blockerStatus.task.blocker.code, 'provider_unavailable')
  assert.equal(blockerStatus.task.blocker.reason, 'provider_not_healthy')
  assert.equal(blockerStatus.task.blocker.category, 'provider')
  assert.equal(blockerStatus.task.blocker.classification, 'capacity')
  assert.equal(blockerStatus.task.blocker.stage, 'preflight')
  assert.equal(blockerStatus.task.blocker.detail, 'runner offline')
  assert.equal(blockerStatus.task.blocker.remediation, 'restore runner')
  assert.equal(blockerStatus.task.blocker.preflight.code, 'provider_not_healthy')
  assert.equal(blockerStatus.task.blocker.preflight.reason, 'health_rejected')
  assert.equal(blockerStatus.task.blocker.preflight.status, 'failed')
  assert.equal(blockerStatus.task.blocker.preflight.detail, 'health probe failed')
  assert.equal(blockerStatus.task.blocker.preflight.remediation, 'restart provider')
})

test('compact projection falls back to complete evidence for risky states', () => {
  const riskyCases = [
    mockStatus({ mode: 'boundary_blocked', boundary: { ...mockStatus().boundary, blocked: true, code: 'task_mismatch', detail: 'wrong task', remediation: 'switch task' }, workflow: { currentStage: 'implement', status: 'blocked', stage: 'implement', action: '切换 Task', reason: 'wrong task', gated: true } }),
    mockStatus({ correction: { required: true, reason: 'server_canonical_state_overrides_local_state', localStage: 'test', remoteStage: 'implement', remoteStatus: 'in_progress' } }),
    mockStatus({ platform: { ...mockStatus().platform, outbox: { ...mockStatus().platform.outbox, totalPending: 1, pending: 1, blocked: 1, next: { id: 'event-risk', type: 'record_experience', localTaskRef: '' }, events: [{ id: 'event-risk', error: 'ambiguous owner' }] } } }),
    mockStatus({ platform: { ...mockStatus().platform, outbox: { ...mockStatus().platform.outbox, totalPending: 1, retainedUnscopedPending: 1, next: { id: 'event-retained', type: 'record_experience', localTaskRef: '' }, events: [{ id: 'event-retained' }] } } }),
    mockStatus({ task: { ...mockStatus().task, blocker: { code: 'future_unknown_blocker', detail: 'new server contract', remediation: 'inspect full status' } } }),
    mockStatus({ task: { ...mockStatus().task, blocker: { detail: 'blocker without a recognized code', remediation: 'inspect full status' } } }),
    mockStatus({ workflow: { ...mockStatus().workflow, blocker: { code: 'future_workflow_blocker', detail: 'new workflow contract', remediation: 'inspect full status' } } }),
  ]
  for (const full of riskyCases) {
    const projected = compactCapStatus(full)
    assert.equal(projected.outputMode, 'full-fallback')
    assert.deepEqual({ ...projected, outputMode: undefined }, { ...full, outputMode: undefined })
  }
})

test('mock A/B cuts normal status JSON by at least 50 percent on average', t => {
  const totals = normalCases.reduce((sum, [, full]) => {
    sum.full += Buffer.byteLength(JSON.stringify(full))
    sum.compact += Buffer.byteLength(JSON.stringify(compactCapStatus(full)))
    return sum
  }, { full: 0, compact: 0 })
  const ratio = totals.compact / totals.full
  t.diagnostic(`A/B bytes: full=${totals.full}, compact=${totals.compact}, ratio=${ratio.toFixed(3)}, reduction=${((1 - ratio) * 100).toFixed(1)}%`)
  assert.ok(ratio <= 0.5, `compact ratio ${ratio.toFixed(3)} exceeds 0.5`)
})

test('public Skill entry stays lightweight and keeps the compact and fallback contract', async () => {
  const skill = await readFile(join(root, 'skills/cap/SKILL.md'), 'utf8')
  assert.ok(Buffer.byteLength(skill) <= 9000, `cap/SKILL.md is ${Buffer.byteLength(skill)} bytes`)
  assert.match(skill, /cap-status\.mjs.*--compact/)
  assert.match(skill, /full-fallback/)
  assert.match(skill, /complexity-routing\.md/)
  assert.match(skill, /未知.*完整|完整.*未知/)
  assert.match(skill, /platform_ready[\s\S]{0,500}create_or_attach_task[\s\S]{0,300}重跑/)
  assert.match(skill, /create_or_attach_task[\s\S]{0,500}不适用于[\s\S]{0,300}restart_required[\s\S]{0,300}local_explicit[\s\S]{0,300}local_fallback_explicit/)
})

test('CLI --compact emits the compact JSON contract without requiring --json', () => {
  const output = execFileSync(process.execPath, [join(root, 'scripts/cap-status.mjs'), root, '--compact', '--mcp-runtime', 'missing', '--allow-local-once'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  })
  const status = JSON.parse(output)
  assert.equal(status.outputMode, 'compact')
  assert.equal(status.repository.root, root)
  assert.ok(status.workflow?.action)
})
