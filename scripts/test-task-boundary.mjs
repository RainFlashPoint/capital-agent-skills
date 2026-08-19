import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  await writeFile(join(repo, '.cap/review/old.md'), 'old review\n')
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', title: 'new payment task', intentSummary: 'integrate payment' })
  const state = await readFile(join(repo, '.cap/STATE.md'), 'utf8')
  const context = await readFile(join(repo, '.cap/task-context.md'), 'utf8')
  const oldContext = await readFile(join(result.snapshotRoot, 'task-context.md'), 'utf8')
  assert.match(state, /task-id: task_new/)
  assert.match(state, /branch: feature\/new-task/)
  assert.match(context, /pending-reconnaissance/)
  assert.equal(oldContext, 'old context\n')
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'README.md'], { cwd: repo, encoding: 'utf8' }), '')
})

test('matching active boundary refuses implicit replacement', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_old\nbranch: feature/new-task\nworktree: ${repo}\n`)
  await assert.rejects(() => switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new' }), /refusing implicit Task replacement/)
  const result = await switchTaskState({ repoRoot: repo, taskId: 'task_new', sessionId: 'session_new', expectedOldTaskId: 'task_old' })
  assert.equal(result.oldTaskId, 'task_old')
})

test('Task switch archives old Outbox metadata and leaves only the new Task active', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), `task-id: task_old\nsession-id: session_old\nbranch: feature/new-task\nworktree: ${repo}\nstage: done\nstatus: in-progress\n`)
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
