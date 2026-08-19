import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { acknowledgeOutboxEvent, archiveHistoricalOutboxEvents, buildReplayPlan, enqueueOutboxEvent, inspectOutbox, markOutboxAttempt } from './cap-outbox.mjs'

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

test('experience replay payload carries the same stable idempotency key as the outbox envelope', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-'))
  const key = 'experience:task-1:commit-1'
  const { event } = await enqueueOutboxEvent(repo, { type: 'experience.record', idempotencyKey: key, payload: { intent: '沉淀经验', changed_files: ['a.js'] } })
  assert.equal(event.idempotencyKey, key)
  assert.equal(event.payload.idempotency_key, key)
  const replay = (await inspectOutbox(repo)).events[0]
  assert.equal(replay.payload.idempotency_key, key)
})

test('experience replay replaces a mismatched payload key with the envelope key', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-'))
  const { event } = await enqueueOutboxEvent(repo, {
    type: 'experience.record',
    idempotencyKey: 'experience:authoritative',
    payload: { intent: '沉淀经验', changed_files: ['a.js'], idempotency_key: 'experience:stale' },
  })
  assert.equal(event.payload.idempotency_key, 'experience:authoritative')
})

test('outbox preserves every event under multi-process contention', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-race-'))
  const cli = new URL('./cap-outbox.mjs', import.meta.url).pathname
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => new Promise(resolvePromise => {
    const input = JSON.stringify({ type: 'skill.event', idempotencyKey: `race:${index}`, payload: { index } })
    const child = spawn(process.execPath, [cli, 'enqueue', repo, input], { env: { ...process.env, CAPITAL_AGENT_MODE: 'local' }, stdio: 'ignore' })
    child.on('close', status => resolvePromise(status))
  })))
  assert.deepEqual(new Set(results), new Set([0]))
  const outbox = await inspectOutbox(repo)
  assert.equal(outbox.pending, 40)
  assert.equal(new Set(outbox.events.map(item => item.idempotencyKey)).size, 40)
})

test('outbox refuses a symlinked .cap directory outside the repository', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cap-outbox-link-'))
  const repo = join(base, 'repo'); const outside = join(base, 'outside')
  await mkdir(repo); await mkdir(outside); await symlink(outside, join(repo, '.cap'))
  await assert.rejects(
    enqueueOutboxEvent(repo, { type: 'skill.event', idempotencyKey: 'escape', payload: {} }),
    /outbox_path_not_contained|outbox_symlink_not_allowed/,
  )
})

test('outbox corruption blocks mutation instead of silently deleting evidence', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-corrupt-'))
  await mkdir(join(repo, '.cap'))
  const valid = JSON.stringify({ id: 'evt_good', type: 'skill.event', idempotencyKey: 'good', payload: {}, createdAt: '2026-08-17T00:00:00.000Z' })
  await writeFile(join(repo, '.cap/outbox.jsonl'), `${valid}\n{"id":"partial"`)
  await assert.rejects(
    enqueueOutboxEvent(repo, { type: 'skill.event', idempotencyKey: 'new', payload: {} }),
    /outbox_corrupt_line:2/,
  )
  assert.match(await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8'), /partial/)
})

test('scoped outbox inspection keeps historical Task metadata out of the active replay plan', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-scope-'))
  await enqueueOutboxEvent(repo, { type: 'skill.event', idempotencyKey: 'old:1', localTaskRef: 'task_old', payload: {} })
  await enqueueOutboxEvent(repo, { type: 'skill.event', idempotencyKey: 'current:1', localTaskRef: 'task_current', payload: {} })
  await enqueueOutboxEvent(repo, { type: 'task.attach', idempotencyKey: 'unscoped:1', payload: {} })

  const outbox = await inspectOutbox(repo, { activeTaskRef: 'task_current' })
  assert.equal(outbox.totalPending, 3)
  assert.equal(outbox.pending, 1)
  assert.equal(outbox.historicalPending, 1)
  assert.equal(outbox.unscopedPending, 1)
  assert.deepEqual(outbox.events.map(item => item.idempotencyKey), ['current:1'])
})

test('historical Task events are archived without replay or loss and repeated archiving is idempotent', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-archive-'))
  await enqueueOutboxEvent(repo, { type: 'experience.record', idempotencyKey: 'old:1', localTaskRef: 'task_old', payload: { changed_files: ['a.js'] } })
  await enqueueOutboxEvent(repo, { type: 'delivery.record', idempotencyKey: 'old:2', localTaskRef: 'task_old', payload: { task_id: 'task_old' } })
  await enqueueOutboxEvent(repo, { type: 'skill.event', idempotencyKey: 'current:1', localTaskRef: 'task_current', payload: {} })
  await enqueueOutboxEvent(repo, { type: 'task.attach', idempotencyKey: 'unscoped:1', payload: {} })

  const first = await archiveHistoricalOutboxEvents(repo, { activeTaskRef: 'task_current', archiveLabel: 'task_old' })
  assert.equal(first.archived, 2)
  assert.equal(first.pending, 1)
  assert.equal(first.unscopedPending, 1)
  assert.match(first.archivePath, /\.cap\/local-state\/outbox-archive\/task_old\//)
  const archiveRows = (await readFile(first.archivePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(archiveRows.map(item => item.idempotencyKey).sort(), ['old:1', 'old:2'])
  assert.deepEqual((await inspectOutbox(repo)).events.map(item => item.idempotencyKey).sort(), ['current:1', 'unscoped:1'])

  const second = await archiveHistoricalOutboxEvents(repo, { activeTaskRef: 'task_current', archiveLabel: 'task_old' })
  assert.equal(second.archived, 0)
  assert.equal(second.pending, 1)
  assert.equal(second.unscopedPending, 1)
})

test('a cross-Task dependency is retained in the active Outbox instead of being orphaned', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-cross-task-dependency-'))
  const old = await enqueueOutboxEvent(repo, { type: 'task.attach', idempotencyKey: 'old:attach', localTaskRef: 'task_old', payload: {} })
  await enqueueOutboxEvent(repo, { type: 'artifact.record', idempotencyKey: 'current:artifact', localTaskRef: 'task_current', dependsOn: [old.event.id], payload: {} })

  const scoped = await inspectOutbox(repo, { activeTaskRef: 'task_current' })
  assert.equal(scoped.pending, 2)
  assert.equal(scoped.historicalPending, 0)
  assert.equal(scoped.retainedHistoricalPending, 1)

  const archived = await archiveHistoricalOutboxEvents(repo, { activeTaskRef: 'task_current', archiveLabel: 'task_old' })
  assert.equal(archived.archived, 0)
  assert.equal(archived.retainedHistoricalPending, 1)
  assert.equal((await inspectOutbox(repo)).pending, 2)
})

test('a historical dependent of the active Task is retained so the archive stays dependency-complete', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-cross-task-dependent-'))
  const current = await enqueueOutboxEvent(repo, { type: 'task.attach', idempotencyKey: 'current:attach', localTaskRef: 'task_current', payload: {} })
  await enqueueOutboxEvent(repo, { type: 'artifact.record', idempotencyKey: 'old:artifact', localTaskRef: 'task_old', dependsOn: [current.event.id], payload: {} })

  const scoped = await inspectOutbox(repo, { activeTaskRef: 'task_current' })
  assert.equal(scoped.pending, 2)
  assert.equal(scoped.historicalPending, 0)
  assert.equal(scoped.retainedHistoricalPending, 1)

  const archived = await archiveHistoricalOutboxEvents(repo, { activeTaskRef: 'task_current', archiveLabel: 'task_old' })
  assert.equal(archived.archived, 0)
  assert.equal((await inspectOutbox(repo)).pending, 2)
})
