import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCandidateDelivery, buildCommitDelivery, buildPushAuthorizationFingerprint, flushPendingDeliveries, queueCommitDelivery } from './client-delivery.mjs'

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
