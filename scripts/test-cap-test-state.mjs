import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTestImpact,
  freezeTestCandidate,
  inspectTestState,
} from '../runtime/execution/test-state.mjs'
import { inspectLocalExecution, runLocalAction } from '../runtime/execution/local-flow.mjs'
import { switchTaskState } from './cap-task-state-switch.mjs'

const git = (root, ...args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

async function fixture(t, stage = 'test') {
  const root = await mkdtemp(join(tmpdir(), 'cap-test-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'Fixture')
  await writeFile(join(root, '.gitignore'), '.cap/\n')
  await writeFile(join(root, 'source.txt'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'fixture')
  await mkdir(join(root, '.cap'))
  await writeFile(join(root, '.cap/STATE.md'), [
    `stage: ${stage}`,
    'status: in-progress',
    'task-id: task-test-state',
    'session-id: session-test-state',
    `branch: ${git(root, 'branch', '--show-current')}`,
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
  await writeFile(join(root, 'source.txt'), 'base\n')
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
  const statePath = join(root, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8')
  await writeFile(statePath, state
    .replace('task-id: task-test-state', 'task-id: task-rotated')
    .replace('session-id: session-test-state', 'session-id: session-rotated'))
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

test('moving the same worktree cannot reset a consumed source snapshot', async t => {
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
  await assert.rejects(impact(moved), /test_full_already_attempted/)
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
  await rm(join(root, '.cap/local-state/test-full-attempts', `${terminal.consumptionFingerprint}.json`))
  const inspected = await inspectTestState(root)
  assert.equal(inspected.valid, false)
  assert.equal(inspected.reason, 'test_full_attempt_incomplete')
  await assert.rejects(impact(root), /test_full_already_attempted/)
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
