import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommitDelivery, flushPendingDeliveries, queueCommitDelivery } from './client-delivery.mjs'

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

test('post-commit payload carries task, commit and changed paths without code content', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-delivery-'))
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'test']); git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap')); await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_demo\nsession-id: skill_demo\n')
  await writeFile(join(repo, 'a.txt'), 'secret body\n'); git(repo, ['add', 'a.txt']); git(repo, ['commit', '-m', 'change'])
  const item = await buildCommitDelivery(repo)
  assert.equal(item.taskId, 'task_demo')
  assert.deepEqual(item.payload.changed_files, ['a.txt'])
  assert.equal(item.payload.delivery_candidate, undefined)
  assert.doesNotMatch(JSON.stringify(item), /secret body/)
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
