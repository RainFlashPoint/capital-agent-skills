import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acknowledgeOutboxEvent, buildReplayPlan, enqueueOutboxEvent, inspectOutbox, markOutboxAttempt } from './cap-outbox.mjs'

test('outbox enqueue is idempotent by stable key', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-'))
  const input = { type: 'delivery.record', idempotencyKey: 'delivery:task-1:abc', payload: { task_id: 'task-1', commit_sha: 'abc' } }
  const first = await enqueueOutboxEvent(repo, input)
  const second = await enqueueOutboxEvent(repo, input)
  assert.equal(first.idempotent, false)
  assert.equal(second.idempotent, true)
  assert.equal((await inspectOutbox(repo)).pending, 1)
})

test('replay plan respects dependencies and exposes blocked cycles', () => {
  const plan = buildReplayPlan([{ id: 'artifact', dependsOn: ['task'], type: 'artifact.record' }, { id: 'task', dependsOn: [], type: 'task.attach' }, { id: 'cycle-a', dependsOn: ['cycle-b'], type: 'skill.event' }, { id: 'cycle-b', dependsOn: ['cycle-a'], type: 'skill.event' }])
  assert.deepEqual(plan.slice(0, 2).map(item => item.id), ['task', 'artifact'])
  assert.equal(plan.filter(item => item.replayStatus === 'blocked').length, 2)
})

test('failed attempt remains pending and ack removes only completed event', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-'))
  const { event } = await enqueueOutboxEvent(repo, { type: 'experience.record', idempotencyKey: 'experience:1', payload: { changed_files: ['a.js'] } })
  const failed = await markOutboxAttempt(repo, event.id, 'server unavailable', '2026-07-27T00:00:00.000Z')
  assert.equal(failed.event.attempt, 1)
  assert.equal(failed.event.lastError, 'server unavailable')
  assert.equal((await acknowledgeOutboxEvent(repo, event.id)).acknowledged, true)
  assert.equal((await inspectOutbox(repo)).pending, 0)
  assert.equal(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), '')
})
