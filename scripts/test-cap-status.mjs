import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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

test('offline handshake exposes missing platform and task instead of silently succeeding', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, offline: true })
  assert.equal(result.mode, 'local_degraded')
  assert.ok(result.reasons.includes('missing_server_url'))
  assert.ok(result.reasons.includes('task_not_attached'))
})

test('configured client without task reports platform ready after capability handshake', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-ready-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { protocolVersion: 1, capabilities: { taskWrite: true, commitReconcile: true } } }) }) })
  assert.equal(result.mode, 'platform_ready')
  assert.equal(result.platform.connected, true)
})

test('failed direct probe waits for MCP confirmation instead of falsely claiming local-only mode', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-probe-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl: async () => ({ ok: false }) })
  assert.equal(result.mode, 'platform_unverified')
  assert.ok(result.reasons.includes('platform_probe_failed_needs_mcp_confirmation'))
})

test('completed platform task overrides stale local test stage', async () => {
  const repo = await fixture(); const home = await mkdtemp(join(tmpdir(), 'cap-home-done-'))
  await mkdir(join(home, '.config/capital-agent'), { recursive: true }); await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_1\nsession-id: session_1\nstage: test\nstatus: in-progress\n')
  const fetchImpl = async url => url.endsWith('/api/auth/handshake')
    ? { ok: true, status: 200, json: async () => ({ data: { capabilities: { taskWrite: true, commitReconcile: true } } }) }
    : { ok: true, status: 200, json: async () => ({ data: { id: 'task_1', status: 'done', currentStage: 'done', gates: { ready: true }, nextAction: { kind: 'complete' } } }) }
  const result = await inspectCapStatus({ repoRoot: repo, homeDir: home, fetchImpl })
  assert.equal(result.task.remoteStatus, 'done')
  assert.equal(result.workflow.stage, 'done')
})

test('IDEA or manual commit after the last delivery is detected for platform reconciliation', () => {
  const result = reconcileRepositoryState({
    head: 'bbbbbbbb', upstreamHead: 'bbbbbbbb', deliveredHead: 'aaaaaaaa',
    commits: ['bbbbbbbb\tIDEA commit'],
  })
  assert.equal(result.needsDeliveryReconciliation, true)
  assert.equal(result.localUnrecorded, true)
  assert.equal(result.remoteUnrecorded, true)
  assert.deepEqual(result.unrecordedCommits, ['bbbbbbbb\tIDEA commit'])
})

test('matching local remote and delivered heads require no reconciliation', () => {
  const result = reconcileRepositoryState({ head: 'aaaaaaaa', upstreamHead: 'aaaaaaaa', deliveredHead: 'aaaaaaaa' })
  assert.equal(result.needsDeliveryReconciliation, false)
})
