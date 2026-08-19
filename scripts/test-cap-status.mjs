import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectCapStatus, reconcileRepositoryState, resolveNextAction } from './cap-status.mjs'

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'cap-status-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo })
  return repo
}

test('missing state starts with repository understanding', () => {
  assert.equal(resolveNextAction({ artifacts: {} }).stage, 'understand')
  assert.equal(resolveNextAction({ artifacts: { profile: true } }).stage, 'define')
})

test('approved plan drives implementation instead of stopping at artifact upload', () => {
  const stateText = 'stage: plan\nstatus: in-progress\n- [x] plan：plan.md 已拆分\n'
  assert.deepEqual(resolveNextAction({ stateText, artifacts: { plan: true } }), { stage: 'implement', action: '编码实现', reason: '计划已就绪' })
})

test('gated workflow never skips directly to the declared next stage', () => {
  const result = resolveNextAction({ stateText: 'stage: test\nstatus: gated\n## Next action\n-> cap-review\n' })
  assert.equal(result.stage, 'test'); assert.equal(result.gated, true)
})

test('deferred-only acceptance advances core task instead of leaving it permanently gated', () => {
  const result = resolveNextAction({ stateText: 'stage: test\nstatus: gated\ndeferred-only: true\n## Next action\n-> cap-review\n' })
  assert.equal(result.stage, 'review')
  assert.equal(result.deferredOnly, true)
})

test('legacy verify state normalizes to test and follows explicit next action', () => {
  const result = resolveNextAction({ stateText: 'stage: verify\nstatus: in-progress\n## Next action\n-> cap-review\n' })
  assert.equal(result.stage, 'review')
})

test('team mode cannot advance from editable STATE gate text while platform is unverified', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-self-gate-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=server\nCAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_fake\nbranch: ${branch}\nworktree: ${root}\nstage: review\nstatus: in-progress\ncap-gate: PASS reviewed-head=${'a'.repeat(40)}\n`)
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true, environment: {}, mcpRuntime: 'loaded' })
  assert.equal(result.mode, 'platform_attached_unverified')
  assert.equal(result.workflow.stage, 'review')
  assert.equal(result.workflow.gated, true)
  assert.match(result.workflow.reason, /Server Action/)
})

test('repository identity removes credentials before status output', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-redact-'))
  execFileSync('git', ['remote', 'add', 'origin', 'https://audit-user:audit-secret@example.test/org/repo.git'], { cwd: repo })
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true, environment: { CAPITAL_AGENT_MODE: 'local' } })
  assert.equal(result.repository.remote, 'https://example.test/org/repo.git')
})

test('offline handshake exposes missing platform and task instead of silently succeeding', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.mode, 'local_degraded')
  assert.ok(result.reasons.includes('missing_server_url'))
  assert.ok(result.reasons.includes('task_not_attached'))
})

test('explicit local mode skips all platform and outbox work even with stale server credentials', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-local-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=local\nCAPITAL_AGENT_SERVER_URL=https://stale.example.test\nCAPITAL_AGENT_USER_KEY=stale-key\n')
  await writeFile(join(repo, '.cap/outbox.jsonl'), `${JSON.stringify({ id: 'old', type: 'task.attach', payload: {} })}\n`)
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, environment: {}, mcpRuntime: 'missing', fetchImpl: async () => { throw new Error('fetch must not run') } })
  assert.equal(result.mode, 'local_explicit')
  assert.equal(result.platform.configured, false)
  assert.equal(result.platform.connected, null)
  assert.equal(result.platform.outbox.pending, 0)
  assert.deepEqual(result.reasons, [])
})

test('configured team mode offers a choice gate when the current session has not loaded MCP', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-restart-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=server\nCAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing', fetchImpl: async () => { throw new Error('restart gate must not probe or send') } })
  assert.equal(result.mode, 'restart_required')
  assert.equal(result.platform.configured, true)
  assert.equal(result.platform.mcpRuntime, 'missing')
  assert.equal(result.platform.connected, null)
  assert.equal(result.workflow.status, 'gated')
  assert.equal(result.workflow.gated, true)
  assert.equal(result.workflow.action, '选择：重启恢复团队模式，或本次明确改用本地模式继续')
  assert.deepEqual(result.workflow.options, [
    { id: 'restart', label: '重启后使用团队模式' },
    { id: 'local_once', label: '本次明确改用本地模式继续' },
  ])
  assert.equal(result.task.blocker.code, 'mcp_runtime_missing_restart_required')
  assert.deepEqual(result.reasons, ['mcp_runtime_missing_restart_required'])
})

test('an explicit one-task local fallback keeps development available without changing team configuration', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-local-once-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=server\nCAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing', allowLocalFallback: true, fetchImpl: async () => { throw new Error('explicit local fallback must not probe or send') } })
  assert.equal(result.mode, 'local_fallback_explicit')
  assert.equal(result.platform.configured, true)
  assert.equal(result.platform.connected, null)
  assert.equal(result.platform.outbox.pending, 0)
  assert.equal(result.workflow.gated, undefined)
  assert.equal(result.task.blocker, null)
  assert.deepEqual(result.reasons, [])
  const resumed = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing', fetchImpl: async () => { throw new Error('persisted local fallback must not probe or send') } })
  assert.equal(resumed.mode, 'local_fallback_explicit')
})

test('one-task local fallback expires when the active task identity changes', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-local-once-task-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=server\nCAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_one\nstage: implement\nstatus: in-progress\n')
  const selected = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing', allowLocalFallback: true })
  assert.equal(selected.mode, 'local_fallback_explicit')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_two\nstage: implement\nstatus: in-progress\n')
  const nextTask = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing' })
  assert.equal(nextTask.mode, 'restart_required')
})

test('restart gate takes priority over stale task state without mutating the old task', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-restart-boundary-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nsession-id: session_old\nbranch: feature/old\nworktree: /tmp/old-worktree\nstage: implement\nstatus: in-progress\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'missing', fetchImpl: async () => { throw new Error('restart gate must not probe or send') } })
  assert.equal(result.mode, 'restart_required')
  assert.equal(result.boundary.blocked, true)
  assert.equal(result.task.blocker.code, 'mcp_runtime_missing_restart_required')
})

test('repository profile exposes local-only Harness eligibility without disabling Task metadata', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-harness-local-'))
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/PROFILE.md'), 'harness-mode: local-only\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_tools\nstage: test\nstatus: in-progress\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.repository.harnessMode, 'local-only')
  assert.equal(result.repository.harnessEligible, false)
  assert.equal(result.task.id, 'task_tools')
})

test('offline handshake exposes queued outbox work without claiming platform completion', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-outbox-'))
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/outbox.jsonl'), `${JSON.stringify({ id: 'evt_task', idempotencyKey: 'task:local-1', type: 'task.attach', localTaskRef: 'local-1', dependsOn: [], payload: {}, createdAt: '2026-07-27T00:00:00.000Z' })}\n`)
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.platform.outbox.pending, 1)
  assert.equal(result.platform.outbox.ready, 1)
  assert.equal(result.platform.outbox.next.type, 'task.attach')
})

test('status isolates historical Outbox rows from the active Task summary', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-outbox-task-scope-'))
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_current\nstage: implement\nstatus: in-progress\n')
  await writeFile(join(repo, '.cap/outbox.jsonl'), [
    JSON.stringify({ id: 'evt_old', idempotencyKey: 'old:1', type: 'skill.event', localTaskRef: 'task_old', dependsOn: [], payload: {}, createdAt: '2026-08-17T00:00:00.000Z' }),
    JSON.stringify({ id: 'evt_current', idempotencyKey: 'current:1', type: 'skill.event', localTaskRef: 'task_current', dependsOn: [], payload: {}, createdAt: '2026-08-18T00:00:00.000Z' }),
    JSON.stringify({ id: 'evt_unscoped', idempotencyKey: 'unscoped:1', type: 'skill.event', dependsOn: [], payload: {}, createdAt: '2026-08-18T01:00:00.000Z' }),
  ].join('\n') + '\n')

  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.platform.outbox.totalPending, 3)
  assert.equal(result.platform.outbox.pending, 1)
  assert.equal(result.platform.outbox.historicalPending, 1)
  assert.equal(result.platform.outbox.unscopedPending, 1)
  assert.equal(result.platform.outbox.next.idempotencyKey, 'current:1')
})

test('configured client without task reports platform ready after capability handshake', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-ready-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/outbox.jsonl'), `${JSON.stringify({ id: 'evt_old', idempotencyKey: 'old:delivery', type: 'delivery.record', localTaskRef: 'task_old', dependsOn: [], payload: { taskId: 'task_old', payload: { commit_sha: 'old' } }, createdAt: '2026-08-17T00:00:00.000Z' })}\n`)
  const requests = []
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async url => {
    requests.push(String(url))
    return { ok: true, status: 200, json: async () => ({ data: { protocolVersion: 1, capabilities: { taskWrite: true, commitReconcile: true } } }) }
  } })
  assert.equal(result.mode, 'platform_ready')
  assert.equal(result.platform.connected, true)
  assert.equal(requests.some(url => url.includes('/commit-reconcile')), false)
  assert.match(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), /old:delivery/)
})

test('rejected HTTP handshake waits for MCP confirmation instead of falsely claiming local-only mode', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-probe-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ msg: 'unavailable' }) }) })
  assert.equal(result.mode, 'platform_unverified')
  assert.equal(result.platform.connected, false)
  assert.ok(result.reasons.includes('platform_handshake_rejected_needs_mcp_confirmation'))
})

test('unavailable direct probe remains unknown until MCP confirmation', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-direct-probe-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async () => { throw new Error('fetch unavailable', { cause: { code: 'ENOTFOUND' } }) } })
  assert.equal(result.mode, 'platform_unverified')
  assert.equal(result.platform.connected, null)
  assert.equal(result.platform.handshake.reason, 'direct_probe_unavailable')
  assert.ok(result.reasons.includes('direct_probe_unavailable_needs_mcp_confirmation'))
})

test('loaded MCP keeps direct probe failure pending MCP confirmation instead of requesting restart', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-loaded-probe-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'loaded', fetchImpl: async () => { throw new Error('fetch unavailable', { cause: { code: 'ENOTFOUND' } }) } })
  assert.equal(result.mode, 'platform_unverified')
  assert.equal(result.platform.mcpRuntime, 'loaded')
  assert.ok(result.reasons.includes('direct_probe_unavailable_needs_mcp_confirmation'))
})

test('unverified platform does not repeat a stale local test stage as platform truth', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-unverified-test-'))
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_1\nbranch: ${branch}\nworktree: ${root}\nstage: test\nstatus: in-progress\n`)
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, mcpRuntime: 'loaded', fetchImpl: async () => { throw new Error('fetch unavailable', { cause: { code: 'ENOTFOUND' } }) } })
  assert.equal(result.mode, 'platform_attached_unverified')
  assert.equal(result.workflow.currentStage, 'implement')
  assert.equal(result.workflow.stage, 'implement')
  assert.equal(result.workflow.action, '通过 MCP 确认最终候选与 Test Action')
  assert.match(result.workflow.reason, /不能称为正在测试验证/)
})

test('stale branch and worktree STATE hard-blocks workflow before old Task delivery replay', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-boundary-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nsession-id: session_old\nbranch: feature/old\nworktree: /tmp/old-worktree\nstage: implement\nstatus: in-progress\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true } } }) }
    : { ok: true, status: 200, json: async () => ({}) } })
  assert.equal(result.mode, 'boundary_blocked')
  assert.equal(result.boundary.blocked, true)
  assert.deepEqual(result.boundary.mismatches, ['branch', 'worktree'])
  assert.equal(result.task.blocker.code, 'task_state_branch_and_worktree_mismatch')
  assert.equal(result.workflow.status, 'blocked')
  assert.equal(result.workflow.action, '安全切换本次 Task 状态')
  assert.equal(result.platform.pendingDeliveries.total, 0)
})

test('completed platform task overrides stale local test stage', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-done-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nsession-id: session_1\nstage: test\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : url.endsWith('/api/health')
      ? { ok: true, status: 200, json: async () => ({ build: { commit: 'server123' }, schemaRevision: '006_product_truth_convergence', taskStoreMode: 'postgres_authoritative', database: 'available' }) }
    : { ok: true, status: 200, json: async () => ({ data: { id: 'task_1', status: 'done', currentStage: 'done', gates: { ready: true }, nextAction: { kind: 'complete' } } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.task.remoteStatus, 'done')
  assert.equal(result.workflow.stage, 'done')
  assert.equal(result.task.retirementStatus, 'pending')
  assert.equal(result.correction.required, true)
  assert.equal(result.platform.runtime.taskStoreMode, 'postgres_authoritative')
})

test('canonical blocker and current commit override generic local waiting copy', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-blocker-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nstage: test\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : url.endsWith('/api/health')
      ? { ok: true, status: 200, json: async () => ({ schemaRevision: '006_product_truth_convergence', taskStoreMode: 'postgres_authoritative' }) }
      : { ok: true, status: 200, json: async () => ({ data: { id: 'task_1', status: 'active', currentStage: 'test', currentCommit: 'a'.repeat(40), currentGate: 'quality', currentAction: { id: 'action_1', type: 'test', status: 'waiting' }, blocker: { code: 'source_commit_not_remote', detail: 'Commit 尚未推送', remediation: '推送当前分支后重试' }, gates: { ready: false }, nextAction: { kind: 'blocker', label: '推送当前分支后重试' } } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.task.currentCommit, 'a'.repeat(40))
  assert.equal(result.task.blocker.code, 'source_commit_not_remote')
  assert.equal(result.workflow.action, '推送当前分支后重试')
})

test('canonical implement stage replaces a stale local test cursor and persists the correction', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-canonical-implement-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nstage: test\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : url.endsWith('/api/health')
      ? { ok: true, status: 200, json: async () => ({ schemaRevision: '006_product_truth_convergence', taskStoreMode: 'postgres_authoritative' }) }
      : { ok: true, status: 200, json: async () => ({ data: {
          id: 'task_1', status: 'active', currentStage: 'implement', currentCommit: '', currentGate: 'commit',
          candidateExplicit: false, currentAction: null, gates: { ready: false },
          nextAction: { kind: 'gate', gate: 'commit', label: '形成最终候选 Commit' },
        } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.workflow.currentStage, 'implement')
  assert.equal(result.workflow.stage, 'implement')
  assert.equal(result.workflow.status, 'active')
  assert.equal(result.workflow.action, '形成最终候选 Commit')
  assert.equal(result.correction.reason, 'server_canonical_state_overrides_local_state')
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /^stage: implement$/m)
})

test('platform cannot claim test verification before both a delivery candidate and Test Action exist', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-premature-test-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nstage: test\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : url.endsWith('/api/health')
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ data: {
          id: 'task_1', status: 'active', currentStage: 'test', currentCommit: 'b'.repeat(40), currentGate: 'quality',
          candidateExplicit: true, currentAction: { id: 'action_old', type: 'test', status: 'succeeded', sourceCommit: 'a'.repeat(40) },
          gates: { ready: false, candidateExplicit: true }, nextAction: null,
        } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.workflow.currentStage, 'implement')
  assert.equal(result.workflow.stage, 'implement')
  assert.equal(result.workflow.action, '形成最终候选 Commit')
  assert.match(result.workflow.reason, /delivery_candidate=true.*Test Action/)
})

test('platform reports test verification after candidate and matching Test Action are canonical', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-canonical-test-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nstage: implement\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : url.endsWith('/api/health')
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ data: {
          id: 'task_1', status: 'active', currentStage: 'test', currentCommit: 'a'.repeat(40), currentGate: 'quality',
          currentAction: { id: 'action_1', type: 'test', status: 'running', sourceCommit: 'a'.repeat(40) },
          gates: { ready: false, candidateExplicit: true },
          nextAction: { kind: 'action', actionId: 'action_1', actionType: 'verify', actionStatus: 'running', label: '等待独立测试' },
        } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.workflow.currentStage, 'test')
  assert.equal(result.workflow.stage, 'test')
  assert.equal(result.workflow.action, '等待独立测试')
})

test('history manifest marks task snapshot as completed without scanning history', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-history-'))
  await mkdir(join(repo, '.cap/history/task_1'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nparent-task-id: task_parent\nstage: done\nstatus: in-progress\n')
  await writeFile(join(repo, '.cap/history/task_1/manifest.json'), '{"taskId":"task_1"}\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.task.parentTaskId, 'task_parent')
  assert.equal(result.task.retirementStatus, 'snapshotted')
  assert.equal(result.task.historyArtifactRoot, '.cap/history/task_1')
})

test('completed parent task hands a new session to its active follow-up task', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-follow-up-'))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_parent\nsession-id: session_parent\nstage: test\nstatus: gated\n')
  const fetchImpl = async url => {
    if (url.endsWith('/api/auth/handshake')) return { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    if (url.endsWith('/api/tasks/task_parent')) return { ok: true, status: 200, json: async () => ({ data: {
      id: 'task_parent', status: 'done', currentStage: 'done', gates: { ready: true },
      nextAction: { kind: 'follow_up', taskId: 'task_bill' },
      relatedTasks: [{ id: 'task_bill', status: 'active', relationType: 'follow_up' }],
    } }) }
    if (url.endsWith('/api/tasks/task_bill')) return { ok: true, status: 200, json: async () => ({ data: {
      id: 'task_bill', status: 'active', currentStage: 'define', gates: { ready: false }, baseCommit: head,
      nextAction: { kind: 'gate', gate: 'quality', label: '完成质量验证' },
      executionMode: 'verify_only', verificationCommands: ['verify bill'],
    } }) }
    throw new Error(`unexpected url: ${url}`)
  }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.task.id, 'task_bill')
  assert.equal(result.task.previousId, 'task_parent')
  assert.equal(result.task.sessionId, '')
  assert.equal(result.task.requiresNewSession, true)
  assert.equal(result.task.remoteStatus, 'active')
  assert.equal(result.workflow.stage, 'test')
  assert.equal(result.workflow.action, '完成质量验证')
  assert.equal(result.reconciliation.needsDeliveryReconciliation, false)
})

test('IDEA or manual commit after the last delivery is detected for platform reconciliation', () => {
  const result = reconcileRepositoryState({
    head: 'bbbbbbbb', upstreamHead: 'bbbbbbbb', deliveredHead: 'aaaaaaaa',
    commits: ['bbbbbbbb\tIDEA commit'],
  })
  assert.equal(result.needsDeliveryReconciliation, true)
  assert.equal(result.localUnrecorded, true)
  assert.equal(result.remoteUnrecorded, true)
  assert.equal(result.headPushed, true)
  assert.equal(result.pushRequired, false)
  assert.deepEqual(result.unrecordedCommits, ['bbbbbbbb\tIDEA commit'])
})

test('local head ahead of upstream is exposed as an explicit push gate', () => {
  const result = reconcileRepositoryState({ head: 'bbbbbbbb', upstreamHead: 'aaaaaaaa', deliveredHead: 'aaaaaaaa' })
  assert.equal(result.headPushed, false)
  assert.equal(result.pushRequired, true)
})

test('matching local remote and delivered heads require no reconciliation', () => {
  const result = reconcileRepositoryState({ head: 'aaaaaaaa', upstreamHead: 'aaaaaaaa', deliveredHead: 'aaaaaaaa' })
  assert.equal(result.needsDeliveryReconciliation, false)
  assert.equal(result.headPushed, true)
  assert.equal(result.pushRequired, false)
})
