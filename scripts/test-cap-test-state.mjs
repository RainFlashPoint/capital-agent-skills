import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from '../runtime/ontology/schema.mjs'
import {
  createTestImpact,
  authorizeEnvironmentRetry,
  freezeTestCandidate,
  inspectTestState,
} from '../runtime/execution/test-state.mjs'
import { compactExecutionResult, executionNextActions, inspectLocalExecution, recoverLocalExecution, runLocalAction } from '../runtime/execution/local-flow.mjs'
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

const sourceRepo = fileURLToPath(new URL('../', import.meta.url))

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

test('retry CLI exposes an explicit authorization operation', () => {
  assert.equal(parseTestStateArguments(['retry-environment', '--repo', '/tmp/example']).operation, 'retry-environment')
  assert.equal(parseTestStateArguments(['retry-environment', '--repo', '/tmp/example', '--migrate-recorder']).migrateRecorder, true)
  assert.throws(() => parseTestStateArguments(['status', '--migrate-recorder']), /test_state_cli_option_invalid/)
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

async function environmentFixture(t, { script = "require('react')", dependency = 'react', beforeFull = null } = {}) {
  const root = await fixture(t)
  await writeFile(join(root, '.gitignore'), '.cap/\nnode_modules/\nweb/runtime-ready\n')
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web/package.json'), JSON.stringify({ dependencies: { [dependency]: '1.0.0' } }))
  await writeFile(join(root, 'web/check.cjs'), script)
  git(root, 'add', '.gitignore', 'web')
  git(root, 'commit', '-qm', 'declare fixture dependency')
  const command = [process.execPath, 'web/check.cjs']
  await createTestImpact(root, {
    changedFiles: ['.gitignore', 'source.txt', 'web/check.cjs', 'web/package.json'],
    activeChecks: ['logic'], targetedCommands: [passing], fullCommand: command,
  })
  await runLocalAction(root, { environment: {}, testScope: 'targeted', command: passing })
  await freezeTestCandidate(root)
  if (beforeFull) await beforeFull(root)
  const first = await runLocalAction(root, { environment: {}, testScope: 'full', command })
  return { root, command, first }
}

test('declared missing dependency permits exactly one explicit environment retry and preserves both actions', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function', 'environment retry authorization is implemented')
  const { root, command, first } = await environmentFixture(t)
  const initialState = JSON.parse(await readFile(join(root, '.cap/execution/test-state.json'), 'utf8'))
  const original = initialState.fullAttempt
  const firstEvidence = await readFile(join(first.artifactDir, 'gate.json'), 'utf8')
  const firstGate = JSON.parse(firstEvidence)
  const terminal = JSON.parse(await readFile(join(root, '.git/capital-agent/test-full-attempts', `${initialState.consumptionFingerprint}.terminal.json`), 'utf8'))
  assert.equal(terminal.recorderVersion, firstGate.envelope.versions.recorder)
  assert.equal(terminal.requestHash, firstGate.envelopeHash)
  assert.equal(terminal.receiptHash, firstGate.receiptHash)
  assert.equal(terminal.diagnosticHash, firstGate.diagnosticHash)
  assert.equal(first.gate.nextActions[0].kind, 'authorize_environment_retry')
  assert.equal(first.gate.nextActions[0].requiresSourceChange, false)
  assert.equal(compactExecutionResult(first).gate.nextActions[0].kind, 'authorize_environment_retry')
  assert.equal((await inspectLocalExecution(root)).reason, 'test_environment_retry_available')
  const authorized = await authorizeEnvironmentRetry(root)
  assert.equal(authorized.phase, 'environment_retry_ready')
  await assert.rejects(authorizeEnvironmentRetry(root), /test_environment_retry_already_authorized/)
  await mkdir(join(root, 'web/node_modules/react'), { recursive: true })
  await writeFile(join(root, 'web/node_modules/react/index.js'), 'module.exports = {}\n')
  const retry = await runLocalAction(root, { environment: {}, testScope: 'full', command })
  assert.equal(retry.gate.passed, true)
  const state = await inspectTestState(root)
  assert.equal(state.phase, 'full_passed')
  assert.deepEqual(state.fullAttempt, original)
  assert.equal(state.environmentRetry.attempt.actionId, retry.envelope.id)
  assert.notEqual(retry.envelope.id, first.envelope.id)
  assert.equal(await readFile(join(first.artifactDir, 'gate.json'), 'utf8'), firstEvidence)
  assert.equal((await inspectLocalExecution(root)).passed, true)
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command }), /test_full_already_attempted/)
})

test('environment retry restores a valid authorization sidecar after projection write interruption', async t => {
  const { root } = await environmentFixture(t)
  const statePath = join(root, '.cap/execution/test-state.json')
  const failed = JSON.parse(await readFile(statePath, 'utf8'))
  const authorized = await authorizeEnvironmentRetry(root)
  await writeFile(statePath, JSON.stringify(failed))

  const restored = await authorizeEnvironmentRetry(root)
  assert.equal(restored.phase, 'environment_retry_ready')
  assert.deepEqual(restored.environmentRetry, authorized.environmentRetry)
  assert.equal((await inspectTestState(root)).valid, true)
})

test('terminal reconciliation recreates the current recorder anchor before environment authorization', async t => {
  const { root } = await environmentFixture(t)
  const statePath = join(root, '.cap/execution/test-state.json')
  const completed = JSON.parse(await readFile(statePath, 'utf8'))
  const terminalPath = join(root, '.git/capital-agent/test-full-attempts', `${completed.consumptionFingerprint}.terminal.json`)
  await rm(terminalPath)
  await writeFile(statePath, JSON.stringify({
    ...completed,
    phase: 'candidate_frozen',
    fullAttempt: {
      actionId: completed.fullAttempt.actionId,
      commandHash: completed.fullAttempt.commandHash,
      status: 'running',
      startedAt: completed.fullAttempt.startedAt,
      finishedAt: null,
    },
  }))
  const lock = join(root, '.cap/execution/.lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), JSON.stringify({
    schemaVersion: 2,
    pid: 2147483647,
    id: completed.fullAttempt.actionId,
    startedAt: completed.fullAttempt.startedAt,
  }))

  await recoverLocalExecution(root)
  assert.equal((await inspectLocalExecution(root)).reason, 'test_environment_retry_available')
  const authorized = await authorizeEnvironmentRetry(root)
  assert.equal(authorized.phase, 'environment_retry_ready')
  assert.equal((await inspectTestState(root)).valid, true)
  assert.equal(JSON.parse(await readFile(terminalPath, 'utf8')).targetedEvidenceRoot, authorized.environmentRetry.authorization.targetedEvidenceRoot)
})

const legacyRecorder = '7cae17ccd075cf322c03b3c8c5c5ffadcf43f618f329deccd8a131159e78c611'
const legacyRecorderCommit = '41a839af98dba01edb20902256f0a153f83451e6'
const stableLegacyEnvironmentScript = "const fs = require('fs'); if (!fs.existsSync('web/runtime-ready')) { console.error('bwrap: creating new namespace failed: Operation not permitted'); process.exit(1) }"

async function legacyEnvironmentFixture(t) {
  return environmentFixture(t, { script: stableLegacyEnvironmentScript })
}

test('legacy recorder allowlist digest is derived from its archived implementation', t => {
  let sources
  try {
    sources = ['local-flow.mjs', 'local-support.mjs', 'test-state.mjs'].map(name => (
      execFileSync('git', ['show', `${legacyRecorderCommit}:runtime/execution/${name}`], {
        cwd: sourceRepo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ))
  } catch {
    t.skip('archived implementation is unavailable in this shallow checkout; the fail-closed anchor limitation remains documented')
    return
  }
  assert.equal(digest(sources), legacyRecorder)
})

async function targetedEvidenceRoot(root, state) {
  const records = []
  for (const commandHash of [...state.plan.targetedCommandHashes].sort()) {
    const result = state.targetedResults[commandHash]
    const evidence = JSON.parse(await readFile(join(root, '.cap/execution', result.actionId, 'gate.json'), 'utf8'))
    records.push({
      commandHash,
      actionHash: digest(result.actionId),
      requestHash: evidence.envelopeHash,
      receiptHash: evidence.receiptHash,
      diagnosticHash: evidence.diagnosticHash,
    })
  }
  return digest(records)
}

// Construct a historical recorder fixture, including all canonical hashes.
async function historicalRecorder(root, recorder = legacyRecorder, mutate = () => {}) {
  const path = join(root, '.cap/execution/test-state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  for (const result of [...Object.values(state.targetedResults), state.fullAttempt]) {
    const gatePath = join(root, '.cap/execution', result.actionId, 'gate.json')
    const evidence = JSON.parse(await readFile(gatePath, 'utf8'))
    evidence.envelope.versions.recorder = recorder
    mutate(evidence)
    evidence.envelopeHash = digest(evidence.envelope)
    evidence.receipt.envelopeHash = evidence.envelopeHash
    evidence.receiptHash = digest(evidence.receipt)
    evidence.diagnosticHash = digest(evidence.diagnostic)
    result.requestHash = evidence.envelopeHash
    result.receiptHash = evidence.receiptHash
    await writeFile(gatePath, JSON.stringify(evidence))
  }
  state.recorderVersion = recorder
  await writeFile(path, JSON.stringify(state))
  await writeFile(join(root, '.cap/execution/latest-test.json'), JSON.stringify({ schemaVersion: 2, id: state.fullAttempt.actionId, requestHash: state.fullAttempt.requestHash }))
  const targetedRoot = await targetedEvidenceRoot(root, state)
  const reservationPath = join(root, '.git/capital-agent/test-full-attempts', `${state.consumptionFingerprint}.json`)
  const reservation = JSON.parse(await readFile(reservationPath, 'utf8'))
  await writeFile(reservationPath, JSON.stringify({ ...reservation, schemaVersion: 2, targetedEvidenceRoot: targetedRoot }))
  const fullGate = JSON.parse(await readFile(join(root, '.cap/execution', state.fullAttempt.actionId, 'gate.json'), 'utf8'))
  const terminalPath = join(root, '.git/capital-agent/test-full-attempts', `${state.consumptionFingerprint}.terminal.json`)
  await writeFile(terminalPath, JSON.stringify({
    schemaVersion: 2,
    identityHash: digest(state.identity),
    sourceFingerprint: state.sourceFingerprint,
    consumptionFingerprint: state.consumptionFingerprint,
    actionId: state.fullAttempt.actionId,
    commandHash: state.plan.fullCommandHash,
    recorderVersion: recorder,
    protocolVersion: fullGate.envelope.versions.protocol,
    ontologyVersion: fullGate.envelope.versions.ontology,
    requestHash: fullGate.envelopeHash,
    receiptHash: fullGate.receiptHash,
    diagnosticHash: fullGate.diagnosticHash,
    targetedEvidenceRoot: targetedRoot,
    resultStatus: fullGate.receipt.status,
    finishedAt: fullGate.receipt.finishedAt,
  }))
  return state
}

test('historical recorder migration rejects coherently rewritten targeted evidence when the full anchor is unchanged', async t => {
  const { root } = await legacyEnvironmentFixture(t)
  const original = await historicalRecorder(root)
  const commandHash = original.plan.targetedCommandHashes[0]
  const result = original.targetedResults[commandHash]
  const gatePath = join(root, '.cap/execution', result.actionId, 'gate.json')
  const evidence = JSON.parse(await readFile(gatePath, 'utf8'))
  evidence.envelope.startedAt = new Date(Date.parse(evidence.envelope.startedAt) - 1000).toISOString()
  evidence.envelopeHash = digest(evidence.envelope)
  evidence.receipt.envelopeHash = evidence.envelopeHash
  evidence.receiptHash = digest(evidence.receipt)
  evidence.diagnostic = { ...evidence.diagnostic, stdout: 'rewritten targeted output\n' }
  evidence.diagnosticHash = digest(evidence.diagnostic)
  await writeFile(gatePath, JSON.stringify(evidence))
  await writeFile(join(root, '.cap/execution/test-state.json'), JSON.stringify({
    ...original,
    targetedResults: {
      ...original.targetedResults,
      [commandHash]: { ...result, requestHash: evidence.envelopeHash, receiptHash: evidence.receiptHash },
    },
  }))

  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_invalid/)
})

test('historical recorder migration rejects coherently rewritten editable evidence when the shared terminal anchor is unchanged', async t => {
  const { root } = await environmentFixture(t, { script: "require('node:assert').equal(1, 2)" })
  const original = await historicalRecorder(root)
  const gatePath = join(root, '.cap/execution', original.fullAttempt.actionId, 'gate.json')
  const evidence = JSON.parse(await readFile(gatePath, 'utf8'))
  evidence.envelope.startedAt = new Date(Date.parse(evidence.envelope.startedAt) - 1000).toISOString()
  evidence.diagnostic = { ...evidence.diagnostic, stdout: '', stderr: 'npm ERR! request failed ENOTFOUND registry.invalid\n', truncated: false }
  evidence.envelopeHash = digest(evidence.envelope)
  evidence.receipt.envelopeHash = evidence.envelopeHash
  evidence.receiptHash = digest(evidence.receipt)
  evidence.diagnosticHash = digest(evidence.diagnostic)
  await writeFile(gatePath, JSON.stringify(evidence))
  const rewritten = {
    ...original,
    fullAttempt: { ...original.fullAttempt, requestHash: evidence.envelopeHash, receiptHash: evidence.receiptHash },
  }
  await writeFile(join(root, '.cap/execution/test-state.json'), JSON.stringify(rewritten))
  await writeFile(join(root, '.cap/execution/latest-test.json'), JSON.stringify({ schemaVersion: 2, id: original.fullAttempt.actionId, requestHash: evidence.envelopeHash }))
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_invalid/)
})

test('historical recorder migration rejects an installed package root with a missing subpath', async t => {
  const { root } = await environmentFixture(t, {
    script: "require('react/missing-subpath')",
    beforeFull: async repo => {
      await mkdir(join(repo, 'web/node_modules/react'), { recursive: true })
      await writeFile(join(repo, 'web/node_modules/react/index.js'), 'module.exports = {}\n')
    },
  })
  await historicalRecorder(root)
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_environment_retry_not_allowed/)
})

test('historical recorder migration fails closed when the original terminal anchor is absent', async t => {
  const { root } = await legacyEnvironmentFixture(t)
  const original = await historicalRecorder(root)
  await rm(join(root, '.git/capital-agent/test-full-attempts', `${original.consumptionFingerprint}.terminal.json`))
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_invalid/)
})

test('historical recorder cannot be migrated by coherently synthesizing every local evidence file', async t => {
  const { root, first } = await legacyEnvironmentFixture(t)
  const original = await historicalRecorder(root)
  const before = await readFile(join(first.artifactDir, 'gate.json'), 'utf8')
  await assert.rejects(authorizeEnvironmentRetry(root), /test_recorder_changed/)
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_unsupported/)
  assert.deepEqual(JSON.parse(await readFile(join(root, '.cap/execution/test-state.json'), 'utf8')), original)
  assert.equal(await readFile(join(first.artifactDir, 'gate.json'), 'utf8'), before)
  for (const kind of ['migration', 'environment', 'retry']) {
    await assert.rejects(readFile(join(root, '.git/capital-agent/test-full-attempts', `${original.consumptionFingerprint}.${kind}.json`)), { code: 'ENOENT' })
  }
})

test('environment classification rejects mixed failures without an Error prefix', async t => {
  for (const failure of ['DOMAIN VALIDATION FAILED', 'FAIL business rule', 'not ok 1 - business constraint', '✖ invalid result']) {
    for (const environment of ['bwrap: creating new namespace failed: Operation not permitted', 'npm ERR! request failed ENOTFOUND registry.invalid']) {
      const { root, first } = await environmentFixture(t, {
        script: `console.log(${JSON.stringify(failure)}); console.error(${JSON.stringify(environment)}); process.exit(1)`,
      })
      await assert.rejects(authorizeEnvironmentRetry(root), /test_environment_retry_not_allowed/, `${failure}: ${environment}`)
      assert.equal(first.gate.nextActions[0].requiresSourceChange, true)
    }
  }
  const { root, first } = await environmentFixture(t, {
    script: "console.log('DOMAIN VALIDATION FAILED'); require('react')",
  })
  await assert.rejects(authorizeEnvironmentRetry(root), /test_environment_retry_not_allowed/, 'business failure plus declared missing package')
  assert.equal(first.gate.nextActions[0].requiresSourceChange, true)
  for (const line of [
    'FAIL business rule; bwrap: creating new namespace failed: Operation not permitted',
    'DOMAIN VALIDATION FAILED; npm ERR! request failed ENOTFOUND registry.invalid',
  ]) {
    const sameLine = await environmentFixture(t, {
      script: `console.error(${JSON.stringify(line)}); process.exit(1)`,
    })
    await assert.rejects(authorizeEnvironmentRetry(sameLine.root), /test_environment_retry_not_allowed/, line)
    assert.equal(sameLine.first.gate.nextActions[0].requiresSourceChange, true)
  }
  const sameLineMissing = await environmentFixture(t, {
    script: "process.stderr.write('FAIL business rule; '); require('react')",
  })
  await assert.rejects(authorizeEnvironmentRetry(sameLineMissing.root), /test_environment_retry_not_allowed/, 'business failure and missing package on the same line')
  assert.equal(sameLineMissing.first.gate.nextActions[0].requiresSourceChange, true)
})

test('historical recorder migration refuses unknown, truncated, incompatible and code failure evidence', async t => {
  for (const kind of ['unknown-recorder', 'truncated', 'protocol', 'ontology', 'assertion', 'unknown-failure']) {
    const { root } = await environmentFixture(t, { script: kind === 'assertion' ? "require('node:assert').equal(1, 2)" : kind === 'unknown-failure' ? "throw new Error('business failure')" : undefined })
    await historicalRecorder(root, kind === 'unknown-recorder' ? 'a'.repeat(64) : legacyRecorder, evidence => {
      if (kind === 'truncated') evidence.diagnostic.truncated = true
      if (kind === 'protocol') evidence.envelope.versions.protocol += 1
      if (kind === 'ontology') evidence.envelope.versions.ontology = 'b'.repeat(64)
    })
    await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_(?:recorder_changed|environment_retry_not_allowed|targeted_evidence_invalid|full_evidence_invalid)/, kind)
    assert.equal((await inspectTestState(root)).valid, false)
  }
})

test('historical recorder migration rejects drift and corrupted original evidence', async t => {
  for (const kind of ['source', 'session', 'receipt']) {
    const { root, first } = await environmentFixture(t)
    await historicalRecorder(root)
    if (kind === 'source') await writeFile(join(root, 'source.txt'), 'drift\n')
    if (kind === 'session') {
      const path = join(root, '.cap/STATE.md')
      await writeFile(path, (await readFile(path, 'utf8')).replace('session-test-state', 'another-session'))
    }
    if (kind === 'receipt') {
      const path = join(first.artifactDir, 'gate.json')
      const evidence = JSON.parse(await readFile(path, 'utf8'))
      evidence.receipt.exitCode = 0
      await writeFile(path, JSON.stringify(evidence))
    }
    await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_(?:source_changed|identity_changed|full_evidence_invalid)/, kind)
  }
})

test('unsupported historical recorder remains blocked after projection rewind', async t => {
  const { root } = await legacyEnvironmentFixture(t)
  const original = await historicalRecorder(root)
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_unsupported/)
  await writeFile(join(root, '.cap/execution/test-state.json'), JSON.stringify(original))
  await assert.rejects(authorizeEnvironmentRetry(root, { migrateRecorder: true }), /test_recorder_migration_unsupported/)
})

test('environment retry fails closed for relative, undeclared, assertion and unknown failures', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function')
  for (const script of ["require('./absent.cjs')", "require('not-declared-cap-fixture')", "require('node:assert').equal(1, 2)", "throw new Error('business failure')", 'process.exit(7)', "console.error('connection refused'); throw new TypeError('bug')"]) {
    const { root, first } = await environmentFixture(t, { script })
    await assert.rejects(authorizeEnvironmentRetry(root), /test_environment_retry_not_allowed/)
    assert.equal(first.gate.nextActions[0].requiresSourceChange, true)
    assert.equal((await inspectLocalExecution(root)).nextActions[0].requiresSourceChange, true)
  }
})

test('second environment failure consumes retry even if active state is deleted or rewound', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function')
  const { root, command } = await environmentFixture(t)
  await authorizeEnvironmentRetry(root)
  const authorized = await readFile(join(root, '.cap/execution/test-state.json'), 'utf8')
  const retry = await runLocalAction(root, { environment: {}, testScope: 'full', command })
  assert.equal(retry.gate.passed, false)
  assert.equal(retry.gate.nextActions[0].requiresSourceChange, true)
  await assert.rejects(authorizeEnvironmentRetry(root), /test_environment_retry_already_authorized/)
  await writeFile(join(root, '.cap/execution/test-state.json'), authorized)
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command }), /test_full_already_attempted/)
  await rm(join(root, '.cap/execution/test-state.json'))
  await assert.rejects(impact(root), /test_full_already_attempted/)
})

test('environment authorization does not survive source, command or session drift', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function')
  const { root, command } = await environmentFixture(t)
  await authorizeEnvironmentRetry(root)
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command: fullPassing }), /test_full_command_unplanned/)
  await writeFile(join(root, 'source.txt'), 'changed after authorization\n')
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command }), /test_source_changed/)
  await writeFile(join(root, 'source.txt'), 'feature\n')
  const path = join(root, '.cap/STATE.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('session-test-state', 'another-session'))
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command }), /test_identity_changed/)
})

test('missing executor and declared node_modules tool path are deterministic environment failures', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function')

  const missingRoot = await fixture(t)
  const missingCommand = ['cap-fixture-executable-that-does-not-exist']
  await createTestImpact(missingRoot, { changedFiles: ['source.txt'], activeChecks: ['logic'], targetedCommands: [passing], fullCommand: missingCommand })
  await runLocalAction(missingRoot, { environment: {}, testScope: 'targeted', command: passing })
  await freezeTestCandidate(missingRoot)
  await runLocalAction(missingRoot, { environment: {}, testScope: 'full', command: missingCommand })
  assert.equal((await authorizeEnvironmentRetry(missingRoot)).phase, 'environment_retry_ready')

  const root = await fixture(t)
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web/package.json'), JSON.stringify({ devDependencies: { typescript: '5.0.0' } }))
  git(root, 'add', 'web/package.json')
  git(root, 'commit', '-qm', 'declare typescript tool')
  const command = [process.execPath, join(root, 'web/node_modules/typescript/lib/typescript.js')]
  await createTestImpact(root, { changedFiles: ['source.txt', 'web/package.json'], activeChecks: ['logic'], targetedCommands: [passing], fullCommand: command })
  await runLocalAction(root, { environment: {}, testScope: 'targeted', command: passing })
  await freezeTestCandidate(root)
  const first = await runLocalAction(root, { environment: {}, testScope: 'full', command })
  assert.equal(first.gate.nextActions[0].kind, 'authorize_environment_retry', JSON.stringify(first.diagnostic))
  const state = await authorizeEnvironmentRetry(root)
  assert.equal(state.environmentRetry.authorization.classification.dependencies[0].packageName, 'typescript')
})

test('timed-out environment retry consumes the only recovery attempt', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  assert.equal(typeof authorizeEnvironmentRetry, 'function')
  const { root, command } = await environmentFixture(t, { script: "require('react'); setTimeout(() => {}, 1000)" })
  await authorizeEnvironmentRetry(root)
  await mkdir(join(root, 'web/node_modules/react'), { recursive: true })
  await writeFile(join(root, 'web/node_modules/react/index.js'), 'module.exports = {}\n')
  const retry = await runLocalAction(root, { environment: {}, testScope: 'full', command, timeoutMs: 10 })
  assert.equal(retry.receipt.status, 'timed_out')
  assert.equal((await inspectTestState(root)).phase, 'full_failed')
  await assert.rejects(runLocalAction(root, { environment: {}, testScope: 'full', command }), /test_full_already_attempted/)
})

test('edited retry authorization cannot self-certify an environment failure', async t => {
  const { authorizeEnvironmentRetry } = await import('../runtime/execution/test-state.mjs')
  const { root } = await environmentFixture(t)
  const authorized = await authorizeEnvironmentRetry(root)
  const ledgerRoot = join(root, git(root, 'rev-parse', '--git-common-dir'), 'capital-agent/test-full-attempts')
  const path = join(ledgerRoot, `${authorized.consumptionFingerprint}.environment.json`)
  const forged = { ...authorized.environmentRetry.authorization, classification: { category: 'artifact_network' } }
  await writeFile(path, JSON.stringify(forged))
  const statePath = join(root, '.cap/execution/test-state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  state.environmentRetry.authorization = forged
  state.environmentRetry.authorizationHash = digest(forged)
  await writeFile(statePath, JSON.stringify(state))
  const inspected = await inspectTestState(root)
  assert.equal(inspected.valid, false)
  assert.equal(inspected.reason, 'test_environment_retry_evidence_invalid')
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
  git(join(root, 'vendor/dep'), 'config', 'core.fileMode', 'false')
  await chmod(join(root, 'vendor/dep/dep.txt'), 0o755)
  const modeOnly = await inspectContextFingerprint(root)
  assert.notEqual(modeOnly.worktree, before.worktree)
  await chmod(join(root, 'vendor/dep/dep.txt'), 0o644)
  assert.equal((await inspectContextFingerprint(root)).worktree, before.worktree)
  await writeFile(join(root, 'vendor/dep/dep.txt'), 'dirty\n')
  await writeFile(join(root, 'vendor/dep/untracked.txt'), 'dirty\n')
  const after = await inspectContextFingerprint(root)
  assert.notEqual(after.worktree, before.worktree)
  await writeFile(join(root, 'vendor/dep/dep.txt'), 'different dirty content\n')
  await writeFile(join(root, 'vendor/dep/untracked.txt'), 'different untracked content\n')
  const changedDirtyContent = await inspectContextFingerprint(root)
  assert.notEqual(changedDirtyContent.worktree, after.worktree)
  await chmod(join(root, 'vendor/dep/dep.txt'), 0o755)
  const changedExecutableMode = await inspectContextFingerprint(root)
  assert.notEqual(changedExecutableMode.worktree, changedDirtyContent.worktree)
  const state = await inspectTestState(root)
  assert.equal(state.valid, false)
  assert.equal(state.reason, 'test_source_changed')
  await assert.rejects(createTestImpact(root, {
    changedFiles: ['source.txt'], activeChecks: ['logic'], targetedCommands: [passing], fullCommand: fullPassing,
  }), /test_impact_changed_files_mismatch/)
})

test('missing targeted evidence after candidate freeze requires a new source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  const targeted = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  await rm(join(targeted.artifactDir, 'gate.json'))

  const status = await inspectLocalExecution(root)
  assert.equal(status.reason, 'test_targeted_evidence_invalid')
  assert.deepEqual(status.nextActions.map(action => action.kind), [
    'change_source_then_refresh_test_impact',
  ])
  assert.equal(status.nextActions[0].requiresSourceChange, true)
})

test('missing full evidence after full pass requires a new source snapshot', async t => {
  const root = await fixture(t)
  await impact(root)
  await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'targeted', command: passing,
  })
  await freezeTestCandidate(root)
  const full = await runLocalAction(root, {
    environment: {}, stage: 'test', testScope: 'full', command: fullPassing,
  })
  await rm(join(full.artifactDir, 'gate.json'))

  const status = await inspectLocalExecution(root)
  assert.equal(status.reason, 'test_full_evidence_invalid')
  assert.deepEqual(status.nextActions.map(action => action.kind), [
    'change_source_then_refresh_test_impact',
  ])
  assert.equal(status.nextActions[0].requiresSourceChange, true)
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
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let runnerError = ''
  runner.stderr.setEncoding('utf8')
  runner.stderr.on('data', chunk => { runnerError += chunk })
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
    if (runner.exitCode !== null) assert.fail(`full runner exited before publishing pending evidence: ${runner.exitCode}: ${runnerError.trim()}`)
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
