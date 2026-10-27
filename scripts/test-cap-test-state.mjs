import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTestImpact,
  freezeTestCandidate,
  inspectTestState,
} from '../runtime/execution/test-state.mjs'
import { executionNextActions, inspectLocalExecution, recoverLocalExecution, runLocalAction } from '../runtime/execution/local-flow.mjs'
import { executionFailurePayload } from './cap-execute.mjs'
import { switchTaskState } from './cap-task-state-switch.mjs'
import { parseArguments as parseTestStateArguments } from './cap-test-state.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { captureTaskBaseline } from './cap-worktree-baseline.mjs'

const git = (root, ...args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

async function fixture(t, stage = 'test', changed = true) {
  const root = await mkdtemp(join(tmpdir(), 'cap-test-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'Fixture')
  await writeFile(join(root, '.gitignore'), '.cap/\n')
  await writeFile(join(root, 'source.txt'), 'base\n')
  await writeFile(join(root, 'hidden.txt'), 'base hidden\n')
  await writeFile(join(root, 'rename-source.txt'), 'rename me\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'fixture')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  await captureTaskBaseline(root, 'task-test-state')
  if (changed) {
    await writeFile(join(root, 'source.txt'), 'feature\n')
    git(root, 'add', 'source.txt')
    git(root, 'commit', '-qm', 'feature')
  }
  await mkdir(join(root, '.cap'), { recursive: true })
  await writeFile(join(root, '.cap/STATE.md'), [
    `stage: ${stage}`,
    'status: in-progress',
    'task-id: task-test-state',
    'session-id: session-test-state',
    `branch: ${git(root, 'branch', '--show-current')}`,
    `base-commit: ${baseCommit}`,
    `worktree: ${root}`,
    '',
  ].join('\n'))
  return root
}

const passing = [process.execPath, '-e', 'process.exit(0)']
const fullPassing = [process.execPath, '-e', 'process.stdout.write("full-pass")']
const failing = [process.execPath, '-e', 'process.exit(7)']
const impact = root => createTestImpact(root, {
  changedFiles: ['source.txt'],
  activeChecks: ['logic'],
  targetedCommands: [passing],
  fullCommand: fullPassing,
})

test('impact CLI preserves explicit baseline-audit scope', () => {
  const options = parseTestStateArguments([
    'impact',
    '--repo', '/tmp/example',
    '--plan-mode', 'baseline-audit',
    '--audit-scope', 'full-chain',
    '--changed-files', '[]',
    '--active-checks', '["journey"]',
    '--targeted-command', '["node","focused.mjs"]',
    '--full-command', '["node","full.mjs"]',
  ])
  assert.equal(options.planMode, 'baseline-audit')
  assert.equal(options.auditScope, 'full-chain')
  assert.deepEqual(options.changedFiles, [])
})

test('targeted test is blocked before impact analysis and command is not executed', async t => {
  const root = await fixture(t)
  const marker = `${root}-targeted-marker`
  t.after(() => rm(marker, { force: true }))
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'targeted', command }),
    /test_impact_missing/,
  )
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
})

test('authoritative test stage rejects stage and action overrides before command launch', async t => {
  for (const override of [{ stage: 'implement' }, { action: 'build' }]) {
    const root = await fixture(t)
    const marker = `${root}-override-marker`
    t.after(() => rm(marker, { force: true }))
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
    await assert.rejects(
      runLocalAction(root, { environment: {}, ...override, command }),
      /execution_test_stage_override_forbidden/,
    )
    await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
  }
})

test('impact analysis must cover the complete base-to-source change set', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'second.txt'), 'second\n')
  await assert.rejects(impact(root), /test_impact_changed_files_mismatch/)
  const state = await createTestImpact(root, {
    changedFiles: ['second.txt', 'source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: fullPassing,
  })
  assert.deepEqual(state.plan.changedFiles, ['second.txt', 'source.txt'])
})

test('impact analysis preserves NUL-delimited paths verbatim', async t => {
  const root = await fixture(t)
  const paths = [' leading.txt', 'line\nbreak.txt']
  for (const path of paths) await writeFile(join(root, path), 'changed\n')
  const changedFiles = [...paths, 'source.txt'].sort()
  const state = await createTestImpact(root, {
    changedFiles,
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: fullPassing,
  })
  assert.deepEqual(state.plan.changedFiles, changedFiles)
})

test('hidden tracked changes fail closed before impact analysis', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const root = await fixture(t)
    git(root, 'update-index', flag, 'hidden.txt')
    if (flag === '--assume-unchanged') await writeFile(join(root, 'hidden.txt'), 'hidden mutation\n')
    await assert.rejects(impact(root), /context_fingerprint_hidden_index_flags/)
  }
})

test('hidden index flags also fail closed during freshness checks', async t => {
  const root = await fixture(t)
  await impact(root)
  git(root, 'update-index', '--assume-unchanged', 'hidden.txt')
  await writeFile(join(root, 'hidden.txt'), 'hidden after impact\n')
  await assert.rejects(inspectTestState(root), /context_fingerprint_hidden_index_flags/)
})

test('rename fingerprints are independent of ambient Git rename configuration', async t => {
  const root = await fixture(t)
  git(root, 'mv', 'rename-source.txt', 'rename-destination.txt')
  git(root, 'config', 'diff.renames', 'true')
  const enabled = await inspectContextFingerprint(root)
  git(root, 'config', 'diff.renames', 'false')
  const disabled = await inspectContextFingerprint(root)
  assert.deepEqual(enabled, disabled)
})

for (const mode of ['committed', 'staged', 'unstaged']) {
  for (const renameSetting of ['true', 'false']) {
    test(`${mode} rename records both paths when diff.renames=${renameSetting}`, async t => {
      const root = await fixture(t)
      git(root, 'config', 'diff.renames', renameSetting)
      if (mode === 'unstaged') {
        await rename(join(root, 'rename-source.txt'), join(root, 'rename-destination.txt'))
      } else {
        git(root, 'mv', 'rename-source.txt', 'rename-destination.txt')
        if (mode === 'committed') git(root, 'commit', '-qm', 'rename fixture')
      }
      const state = await createTestImpact(root, {
        changedFiles: ['rename-destination.txt', 'rename-source.txt', 'source.txt'],
        activeChecks: ['logic'],
        targetedCommands: [passing],
        fullCommand: fullPassing,
      })
      assert.deepEqual(state.plan.changedFiles, ['rename-destination.txt', 'rename-source.txt', 'source.txt'])
    })
  }
}

test('changing the declared base cannot shrink an already registered impact plan', async t => {
  const root = await fixture(t)
  await impact(root)
  const statePath = join(root, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state.replace(/^base-commit: .+$/m, `base-commit: ${git(root, 'rev-parse', 'HEAD')}`))
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'targeted', command: passing }),
    /test_base_commit_mismatch/,
  )
})

test('first impact registration rejects a STATE base that differs from the immutable Task baseline', async t => {
  const root = await fixture(t)
  const statePath = join(root, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state.replace(/^base-commit: .+$/m, `base-commit: ${git(root, 'rev-parse', 'HEAD')}`))
  await assert.rejects(
    createTestImpact(root, {
      planMode: 'baseline-audit',
      auditScope: 'full-chain',
      changedFiles: [],
      activeChecks: ['journey'],
      targetedCommands: [passing],
      fullCommand: fullPassing,
    }),
    /test_base_commit_mismatch/,
  )
})

test('legitimate sparse checkout remains compatible with non-test local execution', async t => {
  const root = await fixture(t, 'implement', false)
  git(root, 'sparse-checkout', 'init', '--no-cone')
  git(root, 'sparse-checkout', 'set', '/.gitignore', '/source.txt')
  assert.match(git(root, 'ls-files', '-v'), /^S /m)
  const run = await runLocalAction(root, {
    environment: {}, stage: 'implement', command: passing,
  })
  assert.equal(run.gate.passed, true)
})

test('targeted command must be declared by the current impact analysis', async t => {
  const root = await fixture(t)
  await impact(root)
  await assert.rejects(
    runLocalAction(root, {
      environment: {},
      stage: 'test',
      testScope: 'targeted',
      command: [process.execPath, '-e', 'console.log("different")'],
    }),
    /test_targeted_command_unplanned/,
  )
})

test('test-stage execution requires an explicit targeted or full scope', async t => {
  const root = await fixture(t)
  await impact(root)
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', command: passing }),
    /test_scope_required/,
  )
})

test('every planned targeted command must pass before candidate freeze', async t => {
  const root = await fixture(t)
  const second = [process.execPath, '-e', 'process.stdout.write("second")']
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing, second],
    fullCommand: fullPassing,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  assert.equal((await inspectTestState(root)).phase, 'impact_ready')
  await assert.rejects(freezeTestCandidate(root), /test_targeted_not_passed/)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: second,
  })
  assert.equal((await inspectTestState(root)).phase, 'targeted_passed')
})

test('candidate freeze requires every planned targeted command to pass', async t => {
  const root = await fixture(t)
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [failing],
    fullCommand: fullPassing,
  })
  await assert.rejects(freezeTestCandidate(root), /test_targeted_not_passed/)
  const run = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: failing,
  })
  assert.equal(run.gate.gate, 'BLOCKED')
  await assert.rejects(freezeTestCandidate(root), /test_targeted_not_passed/)
  assert.equal((await inspectTestState(root)).phase, 'impact_ready')
})

test('full suite is blocked before freeze and the command is not executed', async t => {
  const root = await fixture(t)
  const marker = `${root}-full-before-freeze`
  t.after(() => rm(marker, { force: true }))
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: command,
  })
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'full', command }),
    /test_candidate_not_frozen/,
  )
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
})

test('impact, targeted pass, freeze and one full attempt form the only happy path', async t => {
  const root = await fixture(t)
  await impact(root)
  let state = await inspectTestState(root)
  assert.equal(state.phase, 'impact_ready')
  assert.deepEqual(state.plan.changedFiles, ['source.txt'])
  assert.deepEqual(state.plan.activeChecks, ['logic'])

  const targeted = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  assert.equal(targeted.gate.gate, 'PASS')
  assert.equal((await inspectTestState(root)).phase, 'targeted_passed')

  await freezeTestCandidate(root)
  assert.equal((await inspectTestState(root)).phase, 'candidate_frozen')
  const full = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  assert.equal(full.gate.gate, 'PASS')
  state = await inspectTestState(root)
  assert.equal(state.phase, 'full_passed')
  assert.equal(state.fullAttempt.status, 'passed')
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'full', command: fullPassing }),
    /test_full_already_attempted/,
  )
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('a failed full attempt is also consumed and cannot be repeated', async t => {
  const root = await fixture(t)
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: failing,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  const full = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: failing,
  })
  assert.equal(full.gate.gate, 'BLOCKED')
  assert.equal((await inspectTestState(root)).phase, 'full_failed')
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'full', command: failing }),
    /test_full_already_attempted/,
  )
  const status = await inspectLocalExecution(root)
  assert.equal(status.reason, 'test_full_failed')
  assert.equal(status.nextActions[0].kind, 'change_source_then_refresh_test_impact')
  assert.equal(status.nextActions[0].requiresSourceChange, true)
})

test('full-attempt ledger survives state deletion and A-to-B-to-A source changes', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  await rm(join(root, '.cap/execution/test-state.json'))
  await assert.rejects(impact(root), /test_full_already_attempted/)

  await writeFile(join(root, 'source.txt'), 'source-b\n')
  await impact(root)
  await writeFile(join(root, 'source.txt'), 'feature\n')
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('Task and Session rotation cannot reset a consumed source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  await captureTaskBaseline(root, 'task-rotated')
  const statePath = join(root, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state
    .replace('task-id: task-test-state', 'task-id: task-rotated')
    .replace('session-id: session-test-state', 'session-id: session-rotated')
    .replace(/^base-commit: .+$/m, `base-commit: ${git(root, 'rev-parse', 'HEAD')}`))
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('the real Task switch preserves the consumed full-attempt ledger', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  await switchTaskState({
    repoRoot: root,
    taskId: 'task-after-switch',
    sessionId: 'session-after-switch',
    expectedOldTaskId: 'task-test-state',
    stage: 'test',
    title: 'same source after task switch',
  })
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('branch relabelling cannot reset a consumed source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  git(root, 'switch', '-qc', 'same-tree-new-label')
  const statePath = join(root, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state.replace(/^branch: .*$/m, 'branch: same-tree-new-label'))
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('moving the same worktree fails closed before a consumed source can be replayed', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  const moved = `${root}-moved`
  t.after(() => rm(moved, { recursive: true, force: true }))
  await rename(root, moved)
  const statePath = join(moved, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state.replace(/^worktree: .*$/m, `worktree: ${moved}`))
  await assert.rejects(impact(moved), /test_task_baseline_invalid/)
})

test('a sibling worktree cannot reset a consumed source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })

  const sibling = `${root}-sibling`
  t.after(() => rm(sibling, { recursive: true, force: true }))
  const siblingBranch = `sibling-${Date.now()}-${process.pid}`
  git(root, 'worktree', 'add', '-qb', siblingBranch, sibling, 'HEAD')
  await captureTaskBaseline(sibling, 'task-sibling')
  await mkdir(join(sibling, '.cap'), { recursive: true })
  await writeFile(join(sibling, '.cap/STATE.md'), [
    'stage: test',
    'status: in-progress',
    'task-id: task-sibling',
    'session-id: session-sibling',
    `branch: ${siblingBranch}`,
    `base-commit: ${git(sibling, 'rev-parse', 'HEAD')}`,
    `worktree: ${sibling}`,
    '',
  ].join('\n'))

  await assert.rejects(impact(sibling), /test_full_already_attempted/)
})

test('source changes invalidate impact analysis before another command runs', async t => {
  const root = await fixture(t)
  await impact(root)
  await writeFile(join(root, 'source.txt'), 'changed\n')
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'targeted', command: passing }),
    /test_source_changed/,
  )
  const state = await inspectTestState(root)
  assert.equal(state.valid, false)
  assert.equal(state.reason, 'test_source_changed')
})

test('test-stage source drift recovery refreshes impact instead of recommending a direct retry', async t => {
  const root = await fixture(t)
  const mutating = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(root, 'source.txt'))}, 'mutated\\n')`]
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [mutating],
    fullCommand: fullPassing,
  })
  const run = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: mutating,
  })
  assert.equal(run.gate.passed, false)
  assert.equal(run.gate.blockers[0], 'source_changed_during_execution')
  const status = await inspectLocalExecution(root)
  assert.equal(status.reason, 'execution_source_changed')
  assert.deepEqual(status.nextActions.map(action => action.kind), ['refresh_test_impact'])
})

test('tampered state cannot self-certify the final full-suite gate', async t => {
  const root = await fixture(t)
  await impact(root)
  const path = join(root, '.cap/execution/test-state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  state.phase = 'full_passed'
  state.frozenAt = new Date().toISOString()
  state.fullAttempt = {
    actionId: 'forged',
    commandHash: state.plan.fullCommandHash,
    status: 'passed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  }
  await writeFile(path, JSON.stringify(state))
  await assert.rejects(inspectTestState(root), /test_state_invalid/)
})

test('forged targeted PASS cannot freeze without verified canonical execution evidence', async t => {
  const root = await fixture(t)
  await impact(root)
  const path = join(root, '.cap/execution/test-state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  const commandHash = state.plan.targetedCommandHashes[0]
  state.phase = 'targeted_passed'
  state.targetedResults[commandHash] = {
    status: 'passed',
    actionId: 'forged-targeted',
    requestHash: '0'.repeat(64),
    receiptHash: '1'.repeat(64),
    finishedAt: new Date().toISOString(),
    resultStatus: 'passed',
  }
  await writeFile(path, JSON.stringify(state))
  await assert.rejects(freezeTestCandidate(root), /test_targeted_evidence_invalid/)
})

test('full command does not start after frozen targeted evidence is removed', async t => {
  const root = await fixture(t)
  const marker = `${root}-full-without-targeted-evidence`
  t.after(() => rm(marker, { force: true }))
  const full = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: full,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  const state = await inspectTestState(root)
  const actionId = state.targetedResults[state.plan.targetedCommandHashes[0]].actionId
  await rm(join(root, '.cap/execution', actionId, 'gate.json'))
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'full', command: full }),
    /test_targeted_evidence_invalid/,
  )
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
})

test('frozen targeted evidence loss requires a new source snapshot', () => {
  const actions = executionNextActions('test_targeted_evidence_invalid', {
    stage: 'test',
    action: 'test',
    testPhase: 'candidate_frozen',
  })
  assert.deepEqual(actions.map(action => [action.kind, action.requiresSourceChange]), [
    ['change_source_then_refresh_test_impact', true],
  ])
})

test('cap-execute catch path preserves frozen phase for targeted evidence loss', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  const state = await inspectTestState(root)
  const actionId = state.targetedResults[state.plan.targetedCommandHashes[0]].actionId
  await rm(join(root, '.cap/execution', actionId, 'gate.json'))
  const payload = await executionFailurePayload(root, { stage: 'test', action: 'test' }, new Error('test_targeted_evidence_invalid'))
  assert.deepEqual(payload.nextActions.map(action => [action.kind, action.requiresSourceChange]), [
    ['change_source_then_refresh_test_impact', true],
  ])
})

test('untracked executable mode is normalized independently of other permission bits', async t => {
  const root = await fixture(t)
  const script = join(root, 'mode-probe.sh')
  await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  const nonExecutable = (await inspectContextFingerprint(root)).untracked
  await chmod(script, 0o644)
  assert.equal((await inspectContextFingerprint(root)).untracked, nonExecutable)
  await chmod(script, 0o700)
  const executable = (await inspectContextFingerprint(root)).untracked
  assert.notEqual(executable, nonExecutable)
  await chmod(script, 0o755)
  assert.equal((await inspectContextFingerprint(root)).untracked, executable)
})

test('post-freeze chmod of an untracked command invalidates the source snapshot', async t => {
  const root = await fixture(t)
  const script = join(root, 'probe.sh')
  await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  const full = ['./probe.sh']
  await createTestImpact(root, {
    changedFiles: ['probe.sh', 'source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: full,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await chmod(script, 0o755)
  await assert.rejects(
    runLocalAction(root, { environment: {}, stage: 'test', testScope: 'full', command: full }),
    /test_source_changed/,
  )
})

test('tracked executable mode drift is visible when core.fileMode is false', async t => {
  const root = await fixture(t)
  git(root, 'config', 'core.fileMode', 'false')
  await impact(root)
  const before = await inspectContextFingerprint(root)
  await chmod(join(root, 'source.txt'), 0o755)
  const after = await inspectContextFingerprint(root)
  assert.notEqual(after.worktree, before.worktree)
  const state = await inspectTestState(root)
  assert.equal(state.valid, false)
  assert.equal(state.reason, 'test_source_changed')
})

test('submodule dirt remains visible under ignore-all configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-test-submodule-parent-'))
  const child = await mkdtemp(join(tmpdir(), 'cap-test-submodule-child-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(child, { recursive: true, force: true }))
  git(child, 'init', '-q')
  git(child, 'config', 'user.email', 'fixture@example.invalid')
  git(child, 'config', 'user.name', 'Fixture')
  await writeFile(join(child, 'dep.txt'), 'base\n')
  git(child, 'add', 'dep.txt')
  git(child, 'commit', '-qm', 'child base')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'Fixture')
  await writeFile(join(root, '.gitignore'), '.cap/\n')
  await writeFile(join(root, 'source.txt'), 'base\n')
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/dep')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'parent base')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  await captureTaskBaseline(root, 'task-test-state')
  await writeFile(join(root, 'source.txt'), 'feature\n')
  git(root, 'add', 'source.txt')
  git(root, 'commit', '-qm', 'feature')
  await mkdir(join(root, '.cap'), { recursive: true })
  await writeFile(join(root, '.cap/STATE.md'), [
    'stage: test',
    'status: in-progress',
    'task-id: task-test-state',
    'session-id: session-test-state',
    `branch: ${git(root, 'branch', '--show-current')}`,
    `base-commit: ${baseCommit}`,
    `worktree: ${root}`,
    '',
  ].join('\n'))
  await createTestImpact(root, {
    changedFiles: ['source.txt'], activeChecks: ['logic'], targetedCommands: [passing], fullCommand: fullPassing,
  })
  const before = await inspectContextFingerprint(root)
  git(root, 'config', 'submodule.vendor/dep.ignore', 'all')
  git(root, 'config', 'diff.ignoreSubmodules', 'all')
  await writeFile(join(root, 'vendor/dep/dep.txt'), 'dirty\n')
  await writeFile(join(root, 'vendor/dep/untracked.txt'), 'dirty\n')
  const after = await inspectContextFingerprint(root)
  assert.notEqual(after.worktree, before.worktree)
  const state = await inspectTestState(root)
  assert.equal(state.valid, false)
  assert.equal(state.reason, 'test_source_changed')
  await assert.rejects(createTestImpact(root, {
    changedFiles: ['source.txt'], activeChecks: ['logic'], targetedCommands: [passing], fullCommand: fullPassing,
  }), /test_impact_changed_files_mismatch/)
})

test('a targeted result locks the same-snapshot impact plan', async t => {
  const root = await fixture(t)
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [failing],
    fullCommand: fullPassing,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: failing,
  })
  const failed = await inspectTestState(root)
  assert.equal(failed.targetedResults[failed.plan.targetedCommandHashes[0]].status, 'failed')
  await assert.rejects(impact(root), /test_impact_plan_locked/)
  const repeated = await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [failing],
    fullCommand: fullPassing,
  })
  assert.deepEqual(repeated.plan, failed.plan)
  assert.deepEqual(repeated.targetedResults, failed.targetedResults)
  assert.equal(repeated.updatedAt, failed.updatedAt)
})

test('candidate freeze is immutable on the same source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await assert.rejects(impact(root), /test_candidate_frozen/)
})

test('the final full command cannot also be registered as a targeted command', async t => {
  const root = await fixture(t)
  await assert.rejects(
    createTestImpact(root, {
      changedFiles: ['source.txt'],
      activeChecks: ['logic'],
      targetedCommands: [passing],
      fullCommand: passing,
    }),
    /test_full_command_overlaps_targeted/,
  )
})

test('deleting only the full-attempt ledger cannot reset a terminal source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  const terminal = await inspectTestState(root)
  const commonRoot = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  await rm(join(commonRoot, 'capital-agent/test-full-attempts', `${terminal.consumptionFingerprint}.json`))
  const inspected = await inspectTestState(root)
  assert.equal(inspected.valid, false)
  assert.equal(inspected.reason, 'test_full_attempt_incomplete')
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('terminal full evidence reconciles a crash before state completion', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })

  const statePath = join(root, '.cap/execution/test-state.json')
  const completed = JSON.parse(await readFile(statePath, 'utf8'))
  const crashed = {
    ...completed,
    phase: 'candidate_frozen',
    fullAttempt: {
      actionId: completed.fullAttempt.actionId,
      commandHash: completed.fullAttempt.commandHash,
      status: 'running',
      startedAt: completed.fullAttempt.startedAt,
      finishedAt: null,
    },
  }
  await writeFile(statePath, `${JSON.stringify(crashed, null, 2)}\n`)

  const stopped = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  const lock = join(root, '.cap/execution/.lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 2,
    pid: stopped.pid,
    id: completed.fullAttempt.actionId,
    startedAt: completed.fullAttempt.startedAt,
  })}\n`)
  assert.equal((await inspectLocalExecution(root)).reason, 'execution_in_progress_or_interrupted')
  await recoverLocalExecution(root)

  const status = await inspectLocalExecution(root)
  assert.equal(status.passed, true)
  assert.equal(status.reason, 'verified_local_evidence')
  const reconciled = await inspectTestState(root)
  assert.equal(reconciled.phase, 'full_passed')
  assert.equal(reconciled.fullAttempt.status, 'passed')
})

test('tampered terminal full evidence cannot reconcile a crash window', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })

  const statePath = join(root, '.cap/execution/test-state.json')
  const completed = JSON.parse(await readFile(statePath, 'utf8'))
  const crashed = {
    ...completed,
    phase: 'candidate_frozen',
    fullAttempt: {
      actionId: completed.fullAttempt.actionId,
      commandHash: completed.fullAttempt.commandHash,
      status: 'running',
      startedAt: completed.fullAttempt.startedAt,
      finishedAt: null,
    },
  }
  await writeFile(statePath, `${JSON.stringify(crashed, null, 2)}\n`)
  const evidencePath = join(root, '.cap/execution', completed.fullAttempt.actionId, 'gate.json')
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  evidence.receipt.exitCode = 9
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  const status = await inspectLocalExecution(root)
  assert.equal(status.passed, false)
  assert.match(status.reason, /test_full_evidence_invalid|execution_artifact_invalid/)
  const unreconciled = await inspectTestState(root)
  assert.equal(unreconciled.phase, 'candidate_frozen')
  assert.equal(unreconciled.fullAttempt.status, 'running')
})

test('clean-tree baseline audit requires an explicit full-chain journey plan', async t => {
  const root = await fixture(t, 'test', false)
  await assert.rejects(
    createTestImpact(root, {
      changedFiles: [],
      activeChecks: ['journey'],
      targetedCommands: [passing],
      fullCommand: fullPassing,
    }),
    /test_impact_changed_files_invalid/,
  )
  await assert.rejects(
    createTestImpact(root, {
      planMode: 'baseline-audit',
      auditScope: 'full-chain',
      changedFiles: [],
      activeChecks: ['logic'],
      targetedCommands: [passing],
      fullCommand: fullPassing,
    }),
    /test_baseline_audit_checks_invalid/,
  )

  const state = await createTestImpact(root, {
    planMode: 'baseline-audit',
    auditScope: 'full-chain',
    changedFiles: [],
    activeChecks: ['journey'],
    targetedCommands: [passing],
    fullCommand: fullPassing,
  })
  assert.equal(state.plan.mode, 'baseline-audit')
  assert.equal(state.plan.auditScope, 'full-chain')
  assert.deepEqual(state.plan.changedFiles, [])
})

test('baseline audit rejects dirty tracked, staged, and untracked snapshots', async t => {
  const options = {
    planMode: 'baseline-audit',
    auditScope: 'full-chain',
    changedFiles: [],
    activeChecks: ['journey'],
    targetedCommands: [passing],
    fullCommand: fullPassing,
  }

  const tracked = await fixture(t, 'test', false)
  await writeFile(join(tracked, 'source.txt'), 'dirty tracked\n')
  await assert.rejects(createTestImpact(tracked, options), /test_baseline_audit_source_dirty/)

  const staged = await fixture(t, 'test', false)
  await writeFile(join(staged, 'source.txt'), 'dirty staged\n')
  git(staged, 'add', 'source.txt')
  await assert.rejects(createTestImpact(staged, options), /test_baseline_audit_source_dirty/)

  const untracked = await fixture(t, 'test', false)
  await writeFile(join(untracked, 'untracked.txt'), 'dirty untracked\n')
  await assert.rejects(createTestImpact(untracked, options), /test_baseline_audit_source_dirty/)
})

test('an interrupted full attempt reports source change instead of an impossible retry', async t => {
  const root = await fixture(t)
  const slowFull = [process.execPath, '-e', 'setTimeout(() => process.exit(0), 5000)']
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [passing],
    fullCommand: slowFull,
  })
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  const pending = join(root, '.cap/execution/latest-test.json')
  const previousPointer = JSON.parse(await readFile(pending, 'utf8'))

  const moduleUrl = new URL('../runtime/execution/local-flow.mjs', import.meta.url).href
  const runner = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { runLocalAction } from ${JSON.stringify(moduleUrl)}; await runLocalAction(process.argv[1], { environment: {}, stage: 'test', testScope: 'full', command: JSON.parse(process.argv[2]), timeoutMs: 60000 })`,
    root,
    JSON.stringify(slowFull),
  ], { stdio: 'ignore' })
  t.after(() => { if (runner.exitCode === null) runner.kill('SIGKILL') })

  let interruptedPointer = null
  for (let attempts = 0; attempts < 200; attempts += 1) {
    const lockOwner = await lstat(join(root, '.cap/execution/.lock/owner.json')).catch(() => null)
    const pointer = await readFile(pending, 'utf8').then(JSON.parse).catch(() => null)
    const gate = pointer?.id
      ? await readFile(join(root, '.cap/execution', pointer.id, 'gate.json'), 'utf8').then(JSON.parse).catch(() => null)
      : null
    if (lockOwner && pointer?.id !== previousPointer.id && gate?.status === 'pending') {
      interruptedPointer = pointer
      break
    }
    if (runner.exitCode !== null) assert.fail(`full runner exited before publishing pending evidence: ${runner.exitCode}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(interruptedPointer, 'full runner did not publish pending evidence')

  runner.kill('SIGKILL')
  await new Promise(resolve => runner.once('exit', resolve))
  await recoverLocalExecution(root)

  const status = await inspectLocalExecution(root)
  assert.equal(status.reason, 'test_full_attempt_incomplete')
  assert.deepEqual(status.nextActions.map(action => action.kind), [
    'recover_interrupted_execution',
    'change_source_then_refresh_test_impact',
  ])
  assert.equal(status.nextActions[1].requiresSourceChange, true)
  await assert.rejects(
    runLocalAction(root, {
      environment: {}, stage: 'test', testScope: 'full', command: slowFull,
    }),
    /test_full_already_attempted/,
  )
})

test('obsolete secondary state-lock debris cannot permanently block transitions', async t => {
  const root = await fixture(t)
  await mkdir(join(root, '.cap/execution'), { recursive: true })
  await mkdir(join(root, '.cap/execution/.test-state.lock'))
  await impact(root)
  assert.equal((await inspectTestState(root)).phase, 'impact_ready')
})

test('impact analysis cannot replace the plan while a targeted command is running', async t => {
  const root = await fixture(t)
  const slow = [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)']
  await createTestImpact(root, {
    changedFiles: ['source.txt'],
    activeChecks: ['logic'],
    targetedCommands: [slow],
    fullCommand: passing,
  })
  const running = runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: slow,
  })
  const lock = join(root, '.cap/execution/.lock')
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (await lstat(lock).catch(() => null)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await assert.rejects(impact(root), /execution_in_progress_or_interrupted/)
  const result = await running
  assert.equal(result.gate.gate, 'PASS')
  assert.equal((await inspectTestState(root)).phase, 'targeted_passed')
})

test('duplicate JSON keys cannot redefine a persisted test transition', async t => {
  const root = await fixture(t)
  await impact(root)
  const path = join(root, '.cap/execution/test-state.json')
  const state = await readFile(path, 'utf8')
  await writeFile(path, state.replace(
    '"phase": "impact_ready",',
    '"phase": "impact_ready",\n  "phase": "targeted_passed",',
  ))
  await assert.rejects(inspectTestState(root), /json_duplicate_key/)
})

test('implement and release execution do not require test state or test scope', async t => {
  for (const stage of ['implement', 'release']) {
    const root = await fixture(t, stage)
    const run = await runLocalAction(root, { environment: {}, stage, command: passing })
    assert.equal(run.gate.gate, 'PASS')
    assert.equal(run.envelope.stage, stage)
  }
})
