import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSanitizedTaskRetry, isSensitiveRiskRejection, sanitizeTaskText } from './cap-task-request.mjs'
import { switchTaskState } from './cap-task-state-switch.mjs'

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'cap-task-boundary-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo })
  execFileSync('git', ['switch', '-qc', 'feature/new-task'], { cwd: repo })
  return repo
}

test('sensitive Task rejection is classified and retried with local-only configuration placeholders', () => {
  assert.equal(isSensitiveRiskRejection('rejected due to unacceptable risk'), true)
  assert.equal(isSensitiveRiskRejection('repository not found'), false)
  const retry = buildSanitizedTaskRetry({ title: '接入支付', requirementText: '接入快捷支付，测试商户号 2560799，公司名 测试公司，token=abc123' })
  assert.equal(retry.retryLimit, 1)
  assert.match(retry.requirementText, /商户号 \[仅本地配置\]/)
  assert.match(retry.requirementText, /公司名 \[仅本地配置\]/)
  assert.match(retry.requirementText, /token=\[仅本地配置\]/)
  assert.equal(retry.requirementText.includes('2560799'), false)
  assert.equal(retry.requirementText.includes('测试公司'), false)
  assert.equal(retry.requirementText.includes('abc123'), false)
})

test('embedded repository credentials are removed before Task text leaves the client', () => {
  const sanitized = sanitizeTaskText('仓库 https://deploy-user:super-secret@git.example.com/team/service.git，按 dev 分支开发')
  assert.equal(sanitized, '仓库 https://git.example.com/team/service.git，按 dev 分支开发')
  assert.equal(sanitized.includes('deploy-user'), false)
  assert.equal(sanitized.includes('super-secret'), false)
})

test('stale Task state is moved aside before a fresh Task boundary is initialized', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/review'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nsession-id: session_old\nbranch: feature/old-task\nworktree: /tmp/old-worktree\nstage: test\nstatus: in-progress\n')
  await writeFile(join(repo, '.cap/task-context.md'), 'old context\n')
  await writeFile(join(repo, '.cap/experience.md'), 'old experience\n')
  await writeFile(join(repo, '.cap/review/old.md'), 'old review\n')
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', title: 'new payment task', intentSummary: 'integrate payment' })
  const state = await readFile(join(repo, '.cap/STATE.md'), 'utf8')
  const context = await readFile(join(repo, '.cap/task-context.md'), 'utf8')
  const oldContext = await readFile(join(result.snapshotRoot, 'task-context.md'), 'utf8')
  const oldExperience = await readFile(join(result.snapshotRoot, 'experience.md'), 'utf8')
  assert.match(state, /task-id: task_new/)
  assert.match(state, /branch: feature\/new-task/)
  assert.match(context, /pending-reconnaissance/)
  assert.equal(oldContext, 'old context\n')
  assert.equal(oldExperience, 'old experience\n')
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'README.md'], { cwd: repo, encoding: 'utf8' }), '')
})

test('Task switch refuses a concurrent operation lock without moving active state', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/spec.md'), 'must remain active\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), 'other writer\n')

  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /task_switch_in_progress/,
  )

  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
  assert.equal(await readFile(join(repo, '.cap/spec.md'), 'utf8'), 'must remain active\n')
})

test('Task switch reclaims a lock owned by a dead process', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), JSON.stringify({ pid: 999999, taskId: 'dead' }) + '\n')
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' })
  assert.equal(result.switched, true)
  await assert.rejects(readFile(join(repo, '.cap/local-state/locks/task-switch.lock'), 'utf8'))
})

test('Task switch recovers a pending boundary journal before retrying', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/spec.md'), 'old spec\n')
  const snapshotRoot = join(repo, '.cap/local-state/stale/task_old/recovery')
  await mkdir(snapshotRoot, { recursive: true })
  await writeFile(join(snapshotRoot, 'spec.md'), 'old spec\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.pending.json'), JSON.stringify({
    schemaVersion: 1, taskId: 'task_interrupted', oldTaskId: 'task_old', fingerprint: 'recovery', oldState: await readFile(join(repo, '.cap/STATE.md'), 'utf8'),
    oldContext: '', snapshotRoot, createdAt: new Date().toISOString(),
  }) + '\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), JSON.stringify({ pid: 999999, taskId: 'task_interrupted' }) + '\n')
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' })
  assert.equal(result.switched, true)
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_new/)
})

test('Task switch rejects a pending journal whose snapshot escapes the repository', async () => {
  const repo = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'cap-pending-outside-'))
  const outsideSpec = join(outside, 'spec.md')
  await writeFile(outsideSpec, 'outside secret\n')
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.pending.json'), JSON.stringify({
    schemaVersion: 1, taskId: 'task_interrupted', oldTaskId: 'task_old', fingerprint: 'outside', snapshotRoot: outside,
  }) + '\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), JSON.stringify({ pid: 999999 }) + '\n')
  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /unsafe_cap_state_path/,
  )
  assert.equal(await readFile(outsideSpec, 'utf8'), 'outside secret\n')
})

test('Task switch rejects a pending journal targeting the cap root', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.pending.json'), JSON.stringify({
    schemaVersion: 1, taskId: 'task_interrupted', oldTaskId: 'task_old', fingerprint: 'cap', snapshotRoot: join(repo, '.cap'),
  }) + '\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), JSON.stringify({ pid: 999999 }) + '\n')
  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /snapshot root must stay under/,
  )
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('Task switch fails closed on a corrupt pending journal without creating a snapshot', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/locks'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.pending.json'), '{broken\n')
  await writeFile(join(repo, '.cap/local-state/locks/task-switch.lock'), JSON.stringify({ pid: 999999 }) + '\n')
  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /task_switch_pending_invalid/,
  )
  await assert.rejects(access(join(repo, '.cap/local-state/stale/task_old')), error => error?.code === 'ENOENT')
})

test('Task switch reclaims an empty orphan snapshot left before journal publication', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/local-state/stale/task_old/orphan'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' })
  assert.equal(result.switched, true)
})

test('Task switch revalidates the observed STATE after acquiring its operation lock', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  const statePath = join(repo, '.cap/STATE.md')
  await writeFile(statePath, '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')

  await assert.rejects(
    switchTaskState({
      repoRoot: repo,
      taskId: 'task_new',
      sessionId: 'session_new',
      afterTaskSwitchLock: async () => writeFile(statePath, '# Cap State: concurrent\ntask-id: task_concurrent\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n'),
    }),
    /task_switch_state_changed/,
  )

  assert.match(await readFile(statePath, 'utf8'), /task-id: task_concurrent/)
})

test('Task switch publishes the new STATE and context only after both temporary files are ready', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/task-context.md'), 'old context\n')

  await assert.rejects(
    switchTaskState({
      repoRoot: repo,
      taskId: 'task_new',
      sessionId: 'session_new',
      beforeTaskBoundaryPublish: async () => { throw new Error('injected boundary publish failure') },
    }),
    /injected boundary publish failure/,
  )

  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
  assert.equal(await readFile(join(repo, '.cap/task-context.md'), 'utf8'), 'old context\n')
})

test('Task switch rejects a symlinked local-state parent before moving active files', async () => {
  const repo = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'cap-task-boundary-outside-'))
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/spec.md'), 'must remain active\n')
  await symlink(outside, join(repo, '.cap/local-state'))

  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /unsafe_cap_state_path/,
  )

  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
  assert.equal(await readFile(join(repo, '.cap/spec.md'), 'utf8'), 'must remain active\n')
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), [])
})

test('Task switch isolates execution evidence with the old Task', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/execution/run-old'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), '# Cap State: old\ntask-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/execution/run-old/gate.json'), '{"taskId":"task_old"}\n')

  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' })

  assert.equal(await readFile(join(result.snapshotRoot, 'execution/run-old/gate.json'), 'utf8'), '{"taskId":"task_old"}\n')
  await assert.rejects(readFile(join(repo, '.cap/execution/run-old/gate.json'), 'utf8'), error => error?.code === 'ENOENT')
})

test('matching active boundary refuses implicit replacement', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_old\nbranch: feature/new-task\nworktree: ${repo}\n`)
  await assert.rejects(() => switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }), /refusing implicit Task replacement/)
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', expectedOldTaskId: 'task_old' })
  assert.equal(result.oldTaskId, 'task_old')
})

test('repeated new Tasks without an active STATE keep independent stale snapshots', async () => {
  const repo = await fixture()
  const first = await switchTaskState({ repoRoot: repo, taskId: 'task_new_a', sessionId: 'session_a' })
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /execution-required: true/)
  await rm(join(repo, '.cap/STATE.md'))
  await rm(join(repo, '.cap/task-context.md'))
  const second = await switchTaskState({ repoRoot: repo, taskId: 'task_new_b', sessionId: 'session_b' })
  assert.notEqual(first.snapshotRoot, second.snapshotRoot)
  assert.match(first.snapshotRoot, /unknown-task/)
  assert.match(second.snapshotRoot, /unknown-task/)
})

test('tracked active cap state blocks before any file is moved into ignored local-state', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/verify'), { recursive: true })
  await writeFile(join(repo, '.cap/.gitignore'), 'local-state/\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\n')
  await writeFile(join(repo, '.cap/verify/old.md'), 'tracked evidence\n')
  execFileSync('git', ['add', '.cap'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })

  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }),
    /tracked_cap_active_state/,
  )
  assert.equal(await readFile(join(repo, '.cap/verify/old.md'), 'utf8'), 'tracked evidence\n')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '')
})

test('explicit tracked active migration preserves unrelated staged entries and records harvest debt', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap/verify'), { recursive: true })
  await writeFile(join(repo, '.gitignore'), '.cap/*\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  await writeFile(join(repo, '.cap/verify/old.md'), 'tracked evidence\n')
  execFileSync('git', ['add', '-f', '.cap/STATE.md', '.cap/verify/old.md'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'fixture\nstaged unrelated change\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  const stagedBefore = execFileSync('git', ['diff', '--cached', '--', 'README.md'], { cwd: repo, encoding: 'utf8' })

  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', migrateTrackedActive: true })
  const stagedAfter = execFileSync('git', ['diff', '--cached', '--', 'README.md'], { cwd: repo, encoding: 'utf8' })
  const trackedAfter = execFileSync('git', ['ls-files', '--', '.cap/STATE.md', '.cap/verify/old.md'], { cwd: repo, encoding: 'utf8' })
  const manifest = JSON.parse(await readFile(join(result.snapshotRoot, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(stagedAfter, stagedBefore)
  assert.equal(trackedAfter, '')
  assert.equal(manifest.knowledgeDisposition, 'needs-harvest')
  assert.deepEqual(result.migratedTrackedActive, ['.cap/STATE.md', '.cap/verify/old.md'])
})

test('tracked active migration requires ignore coverage and leaves index and files unchanged on rejection', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  execFileSync('git', ['add', '.cap/STATE.md'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })
  const indexBefore = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' })
  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', migrateTrackedActive: true }),
    /tracked_cap_ignore_policy_missing/,
  )
  assert.equal(execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' }), indexBefore)
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('tracked active migration detects concurrent Git index changes and preserves both states', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.gitignore'), '.cap/*\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  execFileSync('git', ['add', '-f', '.cap/STATE.md'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })
  await writeFile(join(repo, 'CONCURRENT.md'), 'concurrent staged change\n')

  await assert.rejects(
    switchTaskState({
      repoRoot: repo,
      taskId: 'task_new',
      sessionId: 'session_new',
      migrateTrackedActive: true,
      beforeTrackedIndexReplace: async () => execFileSync('git', ['add', 'CONCURRENT.md'], { cwd: repo }),
    }),
    /tracked_cap_index_changed/,
  )

  assert.match(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }), /CONCURRENT\.md/)
  assert.match(execFileSync('git', ['ls-files', '--', '.cap/STATE.md'], { cwd: repo, encoding: 'utf8' }), /.cap\/STATE\.md/)
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('tracked active migration never removes a Git index lock owned by another process', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.gitignore'), '.cap/*\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  execFileSync('git', ['add', '-f', '.cap/STATE.md'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })
  const lockPath = join(repo, execFileSync('git', ['rev-parse', '--git-path', 'index.lock'], { cwd: repo, encoding: 'utf8' }).trim())
  await writeFile(lockPath, 'foreign git writer\n')

  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', migrateTrackedActive: true }),
    error => error?.code === 'EEXIST',
  )

  assert.equal(await readFile(lockPath, 'utf8'), 'foreign git writer\n')
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('tracked active migration rolls files back when index replacement fails', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.gitignore'), '.cap/*\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_old\nbranch: feature/old\nworktree: /tmp/old\nstage: test\n')
  execFileSync('git', ['add', '-f', '.cap/STATE.md'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'track legacy cap state'], { cwd: repo })
  const indexBefore = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' })

  await assert.rejects(
    switchTaskState({
      repoRoot: repo,
      taskId: 'task_new',
      sessionId: 'session_new',
      migrateTrackedActive: true,
      replaceTrackedIndex: async () => { throw new Error('injected index replacement failure') },
    }),
    /injected index replacement failure/,
  )

  assert.equal(execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' }), indexBefore)
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('completed Task requires strict Retire before switch', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_old\nbranch: feature/new-task\nworktree: ${repo}\nstage: done\n`)
  await assert.rejects(
    switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', expectedOldTaskId: 'task_old' }),
    /completed_task_requires_retire/,
  )
  assert.match(await readFile(join(repo, '.cap/STATE.md'), 'utf8'), /task-id: task_old/)
})

test('Task switch archives old Outbox metadata and leaves only the new Task active', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_old\nsession-id: session_old\nbranch: feature/new-task\nworktree: ${repo}\nstage: test\nstatus: in-progress\n`)
  await writeFile(join(repo, '.cap/outbox.jsonl'), [
    JSON.stringify({ id: 'evt_old', idempotencyKey: 'old:1', type: 'skill.event', localTaskRef: 'task_old', dependsOn: [], payload: {}, createdAt: '2026-08-18T00:00:00.000Z' }),
    JSON.stringify({ id: 'evt_new', idempotencyKey: 'new:1', type: 'skill.event', localTaskRef: 'task_new', dependsOn: [], payload: {}, createdAt: '2026-08-18T00:00:01.000Z' }),
    JSON.stringify({ id: 'evt_unscoped', idempotencyKey: 'unscoped:1', type: 'skill.event', dependsOn: [], payload: {}, createdAt: '2026-08-18T00:00:02.000Z' }),
  ].join('\n') + '\n')

  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', expectedOldTaskId: 'task_old' })
  assert.equal(result.outboxArchive.archived, 1)
  assert.equal(result.outboxArchive.pending, 1)
  assert.equal(result.outboxArchive.unscopedPending, 1)
  assert.match(await readFile(result.outboxArchive.archivePath, 'utf8'), /old:1/)
  const remaining = await readFile(join(repo, '.cap/outbox.jsonl'), 'utf8')
  assert.doesNotMatch(remaining, /old:1/)
  assert.match(remaining, /new:1/)
  assert.match(remaining, /unscoped:1/)
})
