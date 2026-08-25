import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { inspectCapStatus } from './cap-status.mjs'

async function worktreeFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'cap-session-root-'))
  const repoA = join(parent, 'project-a')
  const repoB = join(parent, 'project-b')
  await mkdir(repoA)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoA })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repoA })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repoA })
  await writeFile(join(repoA, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoA })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoA })
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/b', repoB], { cwd: repoA })
  return { parent, repoA, repoB, registryRoot: join(parent, 'session-locks') }
}

test('first repository becomes the immutable root for one Codex thread', async () => {
  const { repoA, repoB, registryRoot } = await worktreeFixture()
  const environment = { CODEX_THREAD_ID: 'thread-a-b-regression' }
  const first = await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const second = await inspectSessionRoot({ repoRoot: repoB, environment, registryRoot })
  const canonicalA = await realpath(repoA)
  const canonicalB = await realpath(repoB)

  assert.equal(first.enforced, true)
  assert.equal(first.blocked, false)
  assert.equal(first.created, true)
  assert.equal(second.enforced, true)
  assert.equal(second.blocked, true)
  assert.equal(second.code, 'session_root_mismatch')
  assert.equal(second.expectedRoot, canonicalA)
  assert.equal(second.currentRoot, canonicalB)
})

test('a sibling worktree cannot override the session root with self-consistent cap metadata', async () => {
  const { repoA, repoB, registryRoot } = await worktreeFixture()
  const environment = { CODEX_SESSION_ID: 'session-self-consistent-b' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  await mkdir(join(repoB, '.cap'), { recursive: true })
  await writeFile(join(repoB, '.cap/STATE.md'), `branch: feature/b\nworktree: ${repoB}\nstage: implement\nstatus: in-progress\n`)

  const result = await inspectSessionRoot({ repoRoot: repoB, environment, registryRoot })
  assert.equal(result.blocked, true)
  assert.equal(result.expectedRoot, await realpath(repoA))
})

test('cap-status blocks before reading a sibling worktree cap state', async () => {
  const { parent, repoA, repoB, registryRoot } = await worktreeFixture()
  const homeDir = join(parent, 'home')
  const environment = { CAPITAL_AGENT_MODE: 'local', CODEX_THREAD_ID: 'thread-cap-status-a-b' }
  await mkdir(join(repoA, '.cap'), { recursive: true })
  await mkdir(join(repoB, '.cap'), { recursive: true })
  await writeFile(join(repoB, '.cap/STATE.md'), `task-id: task_from_wrong_b\nbranch: feature/b\nworktree: ${repoB}\nstage: release\nstatus: in-progress\n`)

  const first = await inspectCapStatus({ repoRoot: repoA, homeDir, environment, sessionRootRegistry: registryRoot, offline: true })
  const second = await inspectCapStatus({ repoRoot: repoB, homeDir, environment, sessionRootRegistry: registryRoot, offline: true })

  assert.equal(first.mode, 'local_explicit')
  assert.equal(second.mode, 'session_root_blocked')
  assert.equal(second.boundary.code, 'session_root_mismatch')
  assert.equal(second.task.id, '')
  assert.equal(JSON.stringify(second).includes('task_from_wrong_b'), false)
})

test('hosts without a stable session identity retain the existing portable boundary behavior', async () => {
  const { repoA, registryRoot } = await worktreeFixture()
  const result = await inspectSessionRoot({ repoRoot: repoA, environment: {}, registryRoot })
  assert.deepEqual(result, {
    enforced: false,
    blocked: false,
    code: '',
    reason: 'session_identity_unavailable',
    currentRoot: await realpath(repoA),
  })
})

test('a symlinked registry directory fails closed instead of writing outside the lock boundary', async () => {
  const { parent, repoA } = await worktreeFixture()
  const realRegistry = join(parent, 'real-registry')
  const linkedRegistry = join(parent, 'linked-registry')
  await mkdir(realRegistry)
  await symlink(realRegistry, linkedRegistry)

  await assert.rejects(
    inspectSessionRoot({ repoRoot: repoA, environment: { CODEX_THREAD_ID: 'thread-symlink' }, registryRoot: linkedRegistry }),
    /session_root_registry_symlink/,
  )
  assert.equal(dirname(linkedRegistry), parent)
})
