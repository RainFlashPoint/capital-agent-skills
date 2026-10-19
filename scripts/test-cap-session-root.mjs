import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectSessionRoot, prepareHandoff, switchSessionRoot } from './cap-session-root.mjs'
import { handoffRepositoryIdentity, inspectHistory, parseIncomingHandoff } from './cap-history-recon.mjs'
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

async function independentReposFixture({ sameRemote = false } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'cap-session-project-switch-'))
  const repoA = join(parent, 'project-a')
  const repoB = join(parent, 'project-b')
  for (const [index, repo] of [repoA, repoB].entries()) {
    await mkdir(repo)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo })
    await writeFile(join(repo, 'README.md'), `fixture-${index}\n`)
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo })
    const remote = sameRemote
      ? (index === 0 ? 'git@git.example.com:team/shared.git' : 'https://git.example.com/team/shared.git')
      : `https://git.example.com/team/project-${index}.git`
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo })
  }
  return { parent, repoA, repoB, registryRoot: join(parent, 'session-locks') }
}

async function handoffFixture(repo, targetRepo, name = 'project-a-to-b.md', overrides = {}) {
  const root = join(repo, '.cap', 'handoff', 'outgoing')
  await mkdir(root, { recursive: true })
  const path = join(root, name)
  const fields = {
    source: `${handoffRepositoryIdentity(repo)} @ ${execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()} / ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}`,
    target: handoffRepositoryIdentity(targetRepo),
    intent: 'continue work',
    confirmed: 'source fact in README.md',
    'to-verify': 'target contract',
    scope: 'README.md',
    'target-work': 'implement target change',
    'invalidates-on': 'source commit, contract or scope changes',
    'non-transferable': 'Task / Session / Gate / Delivery / Outbox / PASS',
    ...overrides,
  }
  const body = `${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`
  const hash = createHash('sha256').update(body).digest('hex')
  await writeFile(path, `${body}summary-sha256: ${hash}\n`)
  return path
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

test('an explicit switch moves the single writable root between independent projects', async () => {
  const { repoA, repoB, registryRoot } = await independentReposFixture()
  const environment = { CODEX_THREAD_ID: 'thread-explicit-project-switch' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const handoff = await handoffFixture(repoA, repoB)

  const switched = await switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, handoffSourcePath: handoff, environment, registryRoot })
  assert.equal(switched.switched, true)
  assert.equal(switched.previousRoot, await realpath(repoA))
  assert.equal(switched.currentRoot, await realpath(repoB))
  assert.equal(await readFile(switched.handoff.destination, 'utf8'), await readFile(handoff, 'utf8'))
  const history = inspectHistory({ repo: repoB, intent: 'unrelated target work', limit: 1 })
  assert.equal(history.matches.length, 1)
  assert.equal(history.matches[0].source_type, 'cap_handoff')
  assert.equal(history.matches[0].targetProject, handoffRepositoryIdentity(repoB))

  const oldRoot = await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const newRoot = await inspectSessionRoot({ repoRoot: repoB, environment, registryRoot })
  assert.equal(oldRoot.blocked, true)
  assert.equal(newRoot.blocked, false)
})

test('handoff copy uses the exact bytes from the validated safe read when the source path is replaced', async () => {
  const { repoA, repoB } = await independentReposFixture()
  const canonicalA = await realpath(repoA)
  const canonicalB = await realpath(repoB)
  const handoff = await handoffFixture(repoA, repoB, 'stable-snapshot.md')
  const original = await readFile(handoff, 'utf8')
  const replacementPath = await handoffFixture(repoA, repoB, 'replacement.md', { intent: 'replacement content must not be copied' })
  const replacement = await readFile(replacementPath, 'utf8')

  const prepared = await prepareHandoff({
    fromRoot: canonicalA,
    targetRoot: canonicalB,
    sourcePath: handoff,
    parseHandoff: (...args) => {
      const parsed = parseIncomingHandoff(...args)
      writeFileSync(handoff, replacement)
      return parsed
    },
  })
  await prepared.commit()

  assert.equal(await readFile(handoff, 'utf8'), replacement)
  assert.equal(await readFile(prepared.destination, 'utf8'), original)
  assert.equal(prepared.hash, createHash('sha256').update(original).digest('hex'))
})

test('handoff commit never overwrites a destination created after preparation', async () => {
  const { repoA, repoB } = await independentReposFixture()
  const sourcePath = await handoffFixture(repoA, repoB)
  const prepared = await prepareHandoff({ fromRoot: await realpath(repoA), targetRoot: await realpath(repoB), sourcePath })
  try {
    await writeFile(prepared.destination, 'concurrent handoff\n', { flag: 'wx' })
    await assert.rejects(prepared.commit(), /project_handoff_destination_conflict/)
    await prepared.rollback()
    assert.equal(await readFile(prepared.destination, 'utf8'), 'concurrent handoff\n')
  } finally {
    await prepared.cleanup()
  }
})

test('handoff rollback preserves a destination replaced after commit even with identical bytes', async () => {
  const { repoA, repoB } = await independentReposFixture()
  const sourcePath = await handoffFixture(repoA, repoB)
  const prepared = await prepareHandoff({ fromRoot: await realpath(repoA), targetRoot: await realpath(repoB), sourcePath })
  try {
    await prepared.commit()
    const content = await readFile(prepared.destination, 'utf8')
    const replacement = `${prepared.destination}.replacement`
    await writeFile(replacement, content, { flag: 'wx' })
    await rename(replacement, prepared.destination)
    await prepared.rollback()
    assert.equal(await readFile(prepared.destination, 'utf8'), content)
  } finally {
    await prepared.cleanup()
  }
})

test('handoff rollback removes its own published file', async () => {
  const { repoA, repoB } = await independentReposFixture()
  const sourcePath = await handoffFixture(repoA, repoB)
  const prepared = await prepareHandoff({ fromRoot: await realpath(repoA), targetRoot: await realpath(repoB), sourcePath })
  try {
    await prepared.commit()
    await prepared.rollback()
    await assert.rejects(readFile(prepared.destination), { code: 'ENOENT' })
  } finally {
    await prepared.cleanup()
  }
})

test('a missing reviewed handoff leaves the original repository root unchanged', async () => {
  const { repoA, repoB, registryRoot } = await independentReposFixture()
  const environment = { CODEX_THREAD_ID: 'thread-handoff-required' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })

  await assert.rejects(
    switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, environment, registryRoot }),
    /project_handoff_required/,
  )
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
  assert.equal((await inspectSessionRoot({ repoRoot: repoB, environment, registryRoot })).blocked, true)
})

test('a symlinked target handoff directory cannot escape the target repository', async () => {
  const { parent, repoA, repoB, registryRoot } = await independentReposFixture()
  const environment = { CODEX_THREAD_ID: 'thread-handoff-target-symlink' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const handoff = await handoffFixture(repoA, repoB)
  const outside = join(parent, 'outside-handoff')
  await mkdir(outside)
  await mkdir(join(repoB, '.cap', 'handoff'), { recursive: true })
  await symlink(outside, join(repoB, '.cap', 'handoff', 'incoming'))

  await assert.rejects(
    switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, handoffSourcePath: handoff, environment, registryRoot }),
    /project_handoff_target_escape/,
  )
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
})

test('an outgoing handoff for another target repository is rejected before switching', async () => {
  const { repoA, repoB, registryRoot } = await independentReposFixture()
  const environment = { CODEX_THREAD_ID: 'thread-wrong-handoff-target' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const handoff = await handoffFixture(repoA, repoB, 'wrong-target.md', { target: 'remote:git.example.com/team/project-other' })

  await assert.rejects(
    switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, handoffSourcePath: handoff, environment, registryRoot }),
    /project_handoff_invalid_target_mismatch/,
  )
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
})

test('same-project sibling worktrees cannot use the explicit project switch', async () => {
  const { repoA, repoB, registryRoot } = await worktreeFixture()
  const environment = { CODEX_THREAD_ID: 'thread-reject-worktree-switch' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })

  await assert.rejects(
    switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, environment, registryRoot }),
    /session_root_same_project/,
  )
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
})

test('legacy persisted project identities cannot permit a same-project worktree switch', async () => {
  const { repoA, repoB, registryRoot } = await worktreeFixture()
  const environment = { CODEX_THREAD_ID: 'legacy-project-lock' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })
  const key = createHash('sha256').update(`codex-thread:${environment.CODEX_THREAD_ID}`).digest('hex')
  await writeFile(join(registryRoot, `${key}.json`), JSON.stringify({
    schema: 2, kind: 'codex-thread', root: await realpath(repoA), project: `git-dir:${join(await realpath(repoA), '.git')}`,
  }))
  await assert.rejects(switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, environment, registryRoot }), /session_root_same_project/)
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
})

test('separate clones with the same sanitized origin remain the same project', async () => {
  const { repoA, repoB, registryRoot } = await independentReposFixture({ sameRemote: true })
  const environment = { CODEX_THREAD_ID: 'thread-reject-same-origin' }
  await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })

  await assert.rejects(
    switchSessionRoot({ fromRepoRoot: repoA, targetRepoRoot: repoB, environment, registryRoot }),
    /session_root_same_project/,
  )
  assert.equal((await inspectSessionRoot({ repoRoot: repoA, environment, registryRoot })).blocked, false)
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
