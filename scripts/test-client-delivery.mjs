import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCandidateDelivery, buildCommitDelivery, buildPushAuthorizationFingerprint, flushPendingDeliveries, queueCommitDelivery, readHarnessMode } from './client-delivery.mjs'
import { activateLocalFallback, isLocalFallbackActive } from './local-fallback.mjs'
import { enqueueOutboxEvent } from './cap-outbox.mjs'

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

test('post-commit payload carries task, commit and changed paths without code content', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-'))
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_demo\nsession-id: skill_demo\n')
  await writeFile(join(repo, 'a.txt'), 'secret body\n'); git(repo, ['add', 'a.txt']); git(repo, ['commit', '-m', 'change'])
  const item = await buildCommitDelivery(repo)
  assert.equal(item.taskId, 'task_demo')
  assert.deepEqual(item.payload.changed_files, ['a.txt'])
  assert.equal(item.payload.delivery_candidate, false)
  assert.doesNotMatch(JSON.stringify(item), /secret body/)
})

test('task-scoped local fallback is visible to post-commit and does not leak to another task', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-local-fallback-'))
  await activateLocalFallback(repo, { branch: 'feature/test', taskId: 'task_local' })
  assert.equal(await isLocalFallbackActive(repo, { branch: 'feature/test', taskId: 'task_local' }), true)
  assert.equal(await isLocalFallbackActive(repo, { branch: 'feature/test', taskId: 'task_next' }), false)
  assert.equal(await isLocalFallbackActive(repo, { branch: 'feature/other', taskId: 'task_local' }), false)
})

test('persistent explicit local mode makes post-commit a hard no-op', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-post-local-')); const home = await mkdtemp(join(tmpdir(), 'cap-post-home-'))
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_local\nsession-id: session_local\n')
  await writeFile(join(repo, 'a.txt'), 'body\n'); git(repo, ['add', 'a.txt']); git(repo, ['commit', '-m', 'local commit'])
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_MODE=local\nCAPITAL_AGENT_SERVER_URL=http://127.0.0.1:9\nCAPITAL_AGENT_USER_KEY=must-not-be-used\n')
  const result = spawnSync(process.execPath, [new URL('./post-commit.mjs', import.meta.url).pathname], {
    cwd: repo, env: { ...process.env, HOME: home, CAPITAL_AGENT_MODE: 'local' }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  await assert.rejects(readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), /ENOENT/)
})

test('candidate delivery is bound to exact task repo branch HEAD and passed local verification', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-candidate-'))
  const remote = await mkdtemp(join(tmpdir(), 'cap-candidate-remote-'))
  git(remote, ['init', '--bare'])
  git(repo, ['init', '-b', 'feature/test']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_candidate\nsession-id: skill_candidate\n')
  await writeFile(join(repo, 'a.txt'), 'body\n'); git(repo, ['add', 'a.txt']); git(repo, ['commit', '-m', 'candidate'])
  git(repo, ['remote', 'add', 'origin', remote]); git(repo, ['push', '-u', 'origin', 'feature/test'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const fingerprint = buildPushAuthorizationFingerprint({ repoUrl: remote, taskId: 'task_candidate', branch: 'feature/test', commitSha: head })
  const candidate = await buildCandidateDelivery(repo, { authorizedFingerprint: fingerprint, verification: { passed: true, status: 'PASS', outcome: 'PASS' } })
  assert.equal(candidate.ok, true)
  assert.equal(candidate.item.payload.delivery_candidate, true)
  assert.equal(candidate.item.payload.commit_sha, head)
  const stale = await buildCandidateDelivery(repo, { authorizedFingerprint: 'stale', verification: { passed: true, status: 'PASS' } })
  assert.equal(stale.reason, 'push_authorization_required')
  await assert.rejects(queueCommitDelivery(repo, candidate.item), /candidate_delivery_requires_live_authorization/)
})

test('local-only maintenance repository cannot become a Server Harness candidate', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-local-only-candidate-'))
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await writeFile(join(repo, '.cap/PROFILE.md'), '# Profile\nharness-mode: local-only\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_tools\nsession-id: skill_tools\n')
  await writeFile(join(repo, 'tool.txt'), 'body\n'); git(repo, ['add', 'tool.txt']); git(repo, ['commit', '-m', 'tool change'])
  assert.equal(await readHarnessMode(repo), 'local-only')
  const candidate = await buildCandidateDelivery(repo, { authorizedFingerprint: 'irrelevant', verification: { passed: true, status: 'PASS' } })
  assert.deepEqual(candidate, { ok: false, reason: 'repository_harness_local_only', harnessMode: 'local-only' })
})

test('local-only maintenance repository still records an ordinary evidence-only delivery', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-local-only-delivery-'))
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await writeFile(join(repo, '.cap/PROFILE.md'), 'harness-mode: local-only\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_tools\nsession-id: skill_tools\n')
  await writeFile(join(repo, 'tool.txt'), 'body\n'); git(repo, ['add', 'tool.txt']); git(repo, ['commit', '-m', 'tool change'])
  const item = await buildCommitDelivery(repo)
  assert.equal(item.payload.delivery_candidate, false)
  assert.equal(await readHarnessMode(repo), 'local-only')
})

test('push authorization fingerprint ignores credentials embedded in an HTTPS remote', () => {
  const plain = buildPushAuthorizationFingerprint({ repoUrl: 'https://git.example/team/app.git', taskId: 'task_1', branch: 'feature/x', commitSha: 'a'.repeat(40) })
  const credentialed = buildPushAuthorizationFingerprint({ repoUrl: 'https://user:secret@git.example/team/app.git', taskId: 'task_1', branch: 'feature/x', commitSha: 'a'.repeat(40) })
  assert.equal(credentialed, plain)
})

test('pending delivery queue flushes successfully and keeps failed rows', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-queue-')); const home = await mkdtemp(join(tmpdir(), 'cap-home-'))
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-key\n')
  await queueCommitDelivery(repo, { taskId: 'task_ok', payload: { commit_sha: 'a' } })
  const result = await flushPendingDeliveries(repo, { homeDir: home, fetchImpl: async () => ({ ok: true }) })
  assert.deepEqual(result, { total: 1, migrated: 0, sent: 1, pending: 0 })
  assert.equal(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), '')
})

test('delivery already present in canonical Task evidence is acknowledged without another POST', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-confirmed-')); const home = await mkdtemp(join(tmpdir(), 'cap-delivery-confirmed-home-'))
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-key\n')
  await queueCommitDelivery(repo, { taskId: 'task_ok', payload: { commit_sha: 'a'.repeat(40), idempotency_key: 'client-commit:task_ok:aaaaaaaa' } })
  const requests = []
  const result = await flushPendingDeliveries(repo, {
    activeTaskRef: 'task_ok', homeDir: home,
    canonicalTask: { id: 'task_ok', evidence: [{ type: 'local_delivery', commitSha: 'a'.repeat(40), idempotencyKey: 'client-commit:task_ok:aaaaaaaa', deliveryCandidate: false }] },
    fetchImpl: async url => { requests.push(String(url)); return { ok: true } },
  })
  assert.deepEqual(result, { total: 1, migrated: 0, sent: 0, confirmed: 1, pending: 0 })
  assert.deepEqual(requests, [])
  assert.equal(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), '')
})

test('delivery flush sends only the active Task and leaves historical Task metadata untouched', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-task-scope-')); const home = await mkdtemp(join(tmpdir(), 'cap-delivery-task-scope-home-'))
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-key\n')
  await queueCommitDelivery(repo, { taskId: 'task_old', payload: { commit_sha: 'old' } })
  await queueCommitDelivery(repo, { taskId: 'task_current', payload: { commit_sha: 'current' } })
  await queueCommitDelivery(repo, { taskId: '', payload: { commit_sha: 'unscoped' } })
  const requests = []

  const result = await flushPendingDeliveries(repo, {
    activeTaskRef: 'task_current',
    homeDir: home,
    fetchImpl: async url => { requests.push(String(url)); return { ok: true } },
  })

  assert.deepEqual(result, { total: 1, migrated: 0, sent: 1, pending: 0 })
  assert.equal(requests.length, 1)
  assert.match(requests[0], /\/api\/tasks\/task_current\/commit-reconcile$/)
  assert.doesNotMatch(requests[0], /task_old/)
  const remaining = await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8')
  assert.match(remaining, /task_old/)
  assert.match(remaining, /unscoped/)
  assert.doesNotMatch(remaining, /task_current/)
})

test('delivery flush does not bypass an unresolved dependency from another Task', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-cross-task-dependency-')); const home = await mkdtemp(join(tmpdir(), 'cap-delivery-cross-task-dependency-home-'))
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-key\n')
  const old = await enqueueOutboxEvent(repo, { type: 'task.attach', idempotencyKey: 'old:attach', localTaskRef: 'task_old', payload: {} })
  await enqueueOutboxEvent(repo, {
    type: 'delivery.record', idempotencyKey: 'current:delivery', localTaskRef: 'task_current', dependsOn: [old.event.id],
    payload: { taskId: 'task_current', payload: { commit_sha: 'current' } },
  })
  const requests = []

  const result = await flushPendingDeliveries(repo, {
    activeTaskRef: 'task_current', homeDir: home,
    fetchImpl: async url => { requests.push(String(url)); return { ok: true } },
  })

  assert.deepEqual(result, { total: 0, migrated: 0, sent: 0, pending: 1 })
  assert.deepEqual(requests, [])
  assert.match(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), /current:delivery/)
})

test('delivery flush proceeds when a recorded dependency has already left the pending Outbox', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-resolved-dependency-')); const home = await mkdtemp(join(tmpdir(), 'cap-delivery-resolved-dependency-home-'))
  await mkdir(join(repo, '.cap')); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-key\n')
  await enqueueOutboxEvent(repo, {
    type: 'delivery.record', idempotencyKey: 'current:delivery:resolved', localTaskRef: 'task_current', dependsOn: ['evt_already_acked'],
    payload: { taskId: 'task_current', payload: { commit_sha: 'current' } },
  })
  const requests = []

  const result = await flushPendingDeliveries(repo, {
    activeTaskRef: 'task_current', homeDir: home,
    fetchImpl: async url => { requests.push(String(url)); return { ok: true } },
  })

  assert.deepEqual(result, { total: 1, migrated: 0, sent: 1, pending: 0 })
  assert.equal(requests.length, 1)
})

test('legacy pending delivery file migrates into the unified outbox before replay', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-legacy-')); const home = await mkdtemp(join(tmpdir(), 'delivery-home-'))
  await mkdir(join(repo, '.cap'), { recursive: true }); await mkdir(join(home, '.config/capital-agent'), { recursive: true })
  await writeFile(join(repo, '.cap/pending-deliveries.jsonl'), `${JSON.stringify({ taskId: 'task_legacy', payload: { commit_sha: 'legacy', idempotency_key: 'legacy:1' } })}\n`)
  await writeFile(join(home, '.config/capital-agent/env'), 'CAPITAL_AGENT_SERVER_URL=https://example.test\nCAPITAL_AGENT_USER_KEY=user-1\n')
  const result = await flushPendingDeliveries(repo, { homeDir: home, fetchImpl: async () => ({ ok: false }) })
  assert.equal(result.migrated, 1); assert.equal(result.pending, 1)
  assert.equal(await readFile(join(repo, '.cap/pending-deliveries.jsonl'), 'utf8'), '')
  assert.match(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), /delivery\.record/)
})
