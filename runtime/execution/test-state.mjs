import { mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { canonical, digest } from '../ontology/schema.mjs'
import { parseJson } from '../ontology/json.mjs'
import { inspectContextFingerprint } from '../../scripts/cap-context-fingerprint.mjs'
import {
  atomicJson,
  fail,
  field,
  git,
  jsonFile,
  repoRoot,
  safePath,
  stageName,
  textFile,
  argvCheck,
  versions,
} from './local-support.mjs'

const statePath = '.cap/execution/test-state.json'
const fullAttemptsPath = '.cap/execution/test-full-attempts'
const phases = new Set(['impact_ready', 'targeted_passed', 'candidate_frozen', 'full_passed', 'full_failed'])
const checks = /^(?:logic|model|journey(?::(?:Web|OpenAPI|App))?)$/
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const same = (left, right) => canonical(left) === canonical(right)

function isoNow() {
  return new Date().toISOString()
}

function uniqueStrings(values, code, pattern = null) {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) fail(code)
  const normalized = values.map(value => value.trim())
  if (new Set(normalized).size !== normalized.length || (pattern && normalized.some(value => !pattern.test(value)))) fail(code)
  return normalized
}

function changedFiles(values) {
  const files = uniqueStrings(values, 'test_impact_changed_files_invalid')
  if (files.some(path => isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))) {
    fail('test_impact_changed_files_invalid')
  }
  return [...files].sort()
}

function commandHashes(commands) {
  if (!Array.isArray(commands) || !commands.length) fail('test_targeted_commands_invalid')
  const hashes = commands.map(command => digest(argvCheck(command)))
  if (new Set(hashes).size !== hashes.length) fail('test_targeted_commands_invalid')
  return hashes
}

async function facts(repoCandidate) {
  const repo = await repoRoot(repoCandidate)
  const state = await textFile(repo, '.cap/STATE.md')
  const task = field(state, 'task-id')
  const session = field(state, 'session-id') || null
  const branch = git(repo, ['branch', '--show-current'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  if (!task || !branch || !commit) fail('test_identity_missing')
  if (field(state, 'branch') && field(state, 'branch') !== branch) fail('test_identity_changed')
  if (field(state, 'worktree') && await realpath(resolve(field(state, 'worktree'))).catch(() => null) !== repo) fail('test_identity_changed')
  const snapshot = await inspectContextFingerprint(repo)
  const identity = { repo, task, session, branch, commit }
  const sourceFingerprint = digest({ identity, snapshot })
  const consumptionFingerprint = digest({ source: { repo, branch, commit }, snapshot })
  return { repo, stage: stageName(field(state, 'stage')), identity, snapshot, sourceFingerprint, consumptionFingerprint, recorderVersion: versions.recorder }
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !phases.has(state.phase)) fail('test_state_invalid')
  if (!state.identity || !state.snapshot || !hashPattern.test(state.sourceFingerprint || '') || !hashPattern.test(state.consumptionFingerprint || '') || !hashPattern.test(state.recorderVersion || '')) fail('test_state_invalid')
  const plan = state.plan
  if (!plan || !Array.isArray(plan.changedFiles) || !plan.changedFiles.length || !Array.isArray(plan.activeChecks) || !plan.activeChecks.length) fail('test_state_invalid')
  try {
    changedFiles(plan.changedFiles)
    uniqueStrings(plan.activeChecks, 'test_state_invalid', checks)
  } catch {
    fail('test_state_invalid')
  }
  if (!Array.isArray(plan.targetedCommandHashes) || !plan.targetedCommandHashes.length || typeof plan.fullCommandHash !== 'string') fail('test_state_invalid')
  if (!plan.targetedCommandHashes.every(hash => hashPattern.test(hash)) || new Set(plan.targetedCommandHashes).size !== plan.targetedCommandHashes.length || !hashPattern.test(plan.fullCommandHash)) fail('test_state_invalid')
  if (plan.targetedCommandHashes.includes(plan.fullCommandHash)) fail('test_state_invalid')
  if (!state.targetedResults || typeof state.targetedResults !== 'object' || Array.isArray(state.targetedResults)) fail('test_state_invalid')
  if (state.fullAttempt !== null && (typeof state.fullAttempt !== 'object' || !idPattern.test(state.fullAttempt.actionId || ''))) fail('test_state_invalid')
  if (digest({ identity: state.identity, snapshot: state.snapshot }) !== state.sourceFingerprint) fail('test_state_invalid')
  if (digest({ source: { repo: state.identity.repo, branch: state.identity.branch, commit: state.identity.commit }, snapshot: state.snapshot }) !== state.consumptionFingerprint) fail('test_state_invalid')
  const resultKeys = Object.keys(state.targetedResults).sort()
  if (!same(resultKeys, [...plan.targetedCommandHashes].sort())) fail('test_state_invalid')
  if (resultKeys.some(hash => {
    const result = state.targetedResults[hash]
    if (!result || !['pending', 'passed', 'failed'].includes(result.status)) return true
    if (result.status === 'pending') return false
    return !idPattern.test(result.actionId || '') || !hashPattern.test(result.requestHash || '') || !hashPattern.test(result.receiptHash || '')
  })) fail('test_state_invalid')
  const targetedPassed = plan.targetedCommandHashes.every(hash => state.targetedResults[hash]?.status === 'passed')
  if (state.phase !== 'impact_ready' && !targetedPassed) fail('test_state_invalid')
  if (state.phase === 'impact_ready' && targetedPassed) fail('test_state_invalid')
  if (['impact_ready', 'targeted_passed'].includes(state.phase) && (state.frozenAt || state.fullAttempt)) fail('test_state_invalid')
  if (['candidate_frozen', 'full_passed', 'full_failed'].includes(state.phase) && !state.frozenAt) fail('test_state_invalid')
  if (state.fullAttempt && (state.fullAttempt.commandHash !== plan.fullCommandHash || !['running', 'passed', 'failed'].includes(state.fullAttempt.status))) fail('test_state_invalid')
  if (state.fullAttempt?.status === 'running' && state.phase !== 'candidate_frozen') fail('test_state_invalid')
  if (state.fullAttempt && state.fullAttempt.status !== 'running' && (!hashPattern.test(state.fullAttempt.requestHash || '') || !hashPattern.test(state.fullAttempt.receiptHash || ''))) fail('test_state_invalid')
  if (state.phase === 'candidate_frozen' && state.fullAttempt && state.fullAttempt.status !== 'running') fail('test_state_invalid')
  if (state.phase === 'full_passed' && state.fullAttempt?.status !== 'passed') fail('test_state_invalid')
  if (state.phase === 'full_failed' && state.fullAttempt?.status !== 'failed') fail('test_state_invalid')
  return state
}

function freshness(state, current) {
  if (!same(state.identity, current.identity)) return 'test_identity_changed'
  if (state.recorderVersion !== current.recorderVersion) return 'test_recorder_changed'
  if (!same(state.snapshot, current.snapshot) || state.sourceFingerprint !== current.sourceFingerprint) return 'test_source_changed'
  return ''
}

async function readState(repo) {
  const state = await textFile(repo, statePath).then(parseJson).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return state ? validateState(state) : null
}

function fullAttemptPath(consumptionFingerprint) {
  if (!hashPattern.test(consumptionFingerprint)) fail('test_state_invalid')
  return `${fullAttemptsPath}/${consumptionFingerprint}.json`
}

function validateFullReservation(value, consumptionFingerprint) {
  if (!value || value.schemaVersion !== 1 || value.consumptionFingerprint !== consumptionFingerprint || !hashPattern.test(value.sourceFingerprint || '') || !idPattern.test(value.actionId || '') || !hashPattern.test(value.commandHash || '')) fail('test_full_reservation_invalid')
  if (!value.identity || !value.snapshot || digest({ identity: value.identity, snapshot: value.snapshot }) !== value.sourceFingerprint) fail('test_full_reservation_invalid')
  if (digest({ source: { repo: value.identity.repo, branch: value.identity.branch, commit: value.identity.commit }, snapshot: value.snapshot }) !== consumptionFingerprint) fail('test_full_reservation_invalid')
  return value
}

async function readFullReservation(repo, consumptionFingerprint) {
  return jsonFile(repo, fullAttemptPath(consumptionFingerprint)).then(value => validateFullReservation(value, consumptionFingerprint)).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function assertExecutionOwner(repo, actionId) {
  const owner = await jsonFile(repo, '.cap/execution/.lock/owner.json').catch(() => fail('execution_in_progress_or_interrupted'))
  if (owner?.id !== actionId || owner?.pid !== process.pid) fail('execution_in_progress_or_interrupted')
}

async function reserveFullAttempt(repo, state, actionId, commandHash) {
  await safePath(repo, fullAttemptsPath, { create: true })
  const reservation = {
    schemaVersion: 1,
    sourceFingerprint: state.sourceFingerprint,
    consumptionFingerprint: state.consumptionFingerprint,
    identity: state.identity,
    snapshot: state.snapshot,
    actionId,
    commandHash,
    startedAt: isoNow(),
  }
  try {
    await atomicJson(join(repo, fullAttemptPath(state.consumptionFingerprint)), reservation, { exclusive: true })
  } catch (error) {
    if (error.code === 'EEXIST') fail('test_full_already_attempted')
    throw error
  }
  return reservation
}

async function verifyTargetedEvidence(repo, state, commandHash) {
  const result = state.targetedResults[commandHash]
  if (result?.status !== 'passed' || !idPattern.test(result.actionId || '')) fail('test_targeted_evidence_invalid')
  const dir = `.cap/execution/${result.actionId}`
  const evidence = await jsonFile(repo, `${dir}/gate.json`).catch(() => fail('test_targeted_evidence_invalid'))
  if (evidence.schemaVersion !== 3 || evidence.status !== 'terminal') fail('test_targeted_evidence_invalid')
  const request = evidence.envelope
  const receipt = evidence.receipt
  if (request.id !== result.actionId || request.stage !== 'test' || request.testScope !== 'targeted' || request.commandHash !== commandHash) fail('test_targeted_evidence_invalid')
  for (const key of ['repo', 'task', 'session', 'branch', 'commit']) if (request[key] !== state.identity[key]) fail('test_targeted_evidence_invalid')
  for (const key of ['root', 'index', 'worktree', 'untracked']) if (request.snapshot?.[key] !== state.snapshot[key]) fail('test_targeted_evidence_invalid')
  if (!same(request.versions, versions) || digest(request) !== result.requestHash) fail('test_targeted_evidence_invalid')
  if (evidence.envelopeHash !== result.requestHash || evidence.receiptHash !== result.receiptHash || digest(receipt) !== result.receiptHash || evidence.diagnosticHash !== digest(evidence.diagnostic)) fail('test_targeted_evidence_invalid')
  if (receipt?.authority !== 'local-observed' || receipt.envelopeId !== result.actionId || receipt.envelopeHash !== result.requestHash || receipt.status !== 'passed' || receipt.exitCode !== 0 || receipt.signal || !same(receipt.afterSnapshot, request.snapshot)) fail('test_targeted_evidence_invalid')
  for (const key of ['repo', 'task', 'session', 'branch', 'commit']) if (receipt[key] !== state.identity[key]) fail('test_targeted_evidence_invalid')
  return true
}

async function verifyAllTargetedEvidence(repo, state) {
  for (const commandHash of state.plan.targetedCommandHashes) await verifyTargetedEvidence(repo, state, commandHash)
}

async function withExecutionLock(repo, operation, action) {
  await safePath(repo, '.cap/execution', { create: true })
  const lock = join(repo, '.cap/execution/.lock')
  try {
    await mkdir(lock)
  } catch (error) {
    if (error.code === 'EEXIST') fail('execution_in_progress_or_interrupted')
    throw error
  }
  try {
    await atomicJson(join(lock, 'owner.json'), {
      schemaVersion: 2,
      pid: process.pid,
      id: `test-state-${operation}-${process.pid}-${Date.now()}`,
      startedAt: isoNow(),
    }, { exclusive: true })
    return await action()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function writeState(repo, state) {
  await atomicJson(join(repo, statePath), state)
  return state
}

export async function createTestImpact(repoCandidate = '.', options = {}) {
  const repo = await repoRoot(repoCandidate)
  return withExecutionLock(repo, 'impact', async () => {
    const current = await facts(repo)
    if (current.stage !== 'test') fail('test_stage_required')
    const plan = {
      changedFiles: changedFiles(options.changedFiles),
      activeChecks: uniqueStrings(options.activeChecks, 'test_active_checks_invalid', checks).sort(),
      targetedCommandHashes: commandHashes(options.targetedCommands).sort(),
      fullCommandHash: digest(argvCheck(options.fullCommand)),
    }
    if (plan.targetedCommandHashes.includes(plan.fullCommandHash)) fail('test_full_command_overlaps_targeted')
    const existing = await readState(repo)
    if (await readFullReservation(repo, current.consumptionFingerprint)) fail('test_full_already_attempted')
    if (existing && !freshness(existing, current)) {
      if (existing.fullAttempt || ['full_passed', 'full_failed'].includes(existing.phase)) fail('test_full_already_attempted')
      if (existing.phase === 'candidate_frozen') fail('test_candidate_frozen')
    }
    return writeState(repo, {
      schemaVersion: 1,
      phase: 'impact_ready',
      identity: current.identity,
      snapshot: current.snapshot,
      sourceFingerprint: current.sourceFingerprint,
      consumptionFingerprint: current.consumptionFingerprint,
      recorderVersion: current.recorderVersion,
      plan,
      targetedResults: Object.fromEntries(plan.targetedCommandHashes.map(hash => [hash, { status: 'pending' }])),
      frozenAt: null,
      fullAttempt: null,
      updatedAt: isoNow(),
    })
  })
}

export async function inspectTestState(repoCandidate = '.') {
  const current = await facts(repoCandidate)
  const state = await readState(current.repo)
  const reservation = await readFullReservation(current.repo, current.consumptionFingerprint)
  if (!state) return { schemaVersion: 1, valid: false, phase: 'missing', reason: reservation ? 'test_full_already_attempted' : 'test_impact_missing', statePath }
  const reason = freshness(state, current)
  if (!reason && state.fullAttempt && !reservation) {
    return { ...state, valid: false, reason: 'test_full_attempt_incomplete', statePath }
  }
  if (!reason && reservation && (!state.fullAttempt || state.fullAttempt.actionId !== reservation.actionId)) {
    return { ...state, valid: false, reason: 'test_full_attempt_incomplete', statePath }
  }
  return { ...state, valid: !reason, reason, statePath }
}

export async function freezeTestCandidate(repoCandidate = '.') {
  const repo = await repoRoot(repoCandidate)
  return withExecutionLock(repo, 'freeze', async () => {
    const current = await facts(repo)
    if (current.stage !== 'test') fail('test_stage_required')
    const state = await readState(repo)
    if (!state) fail('test_impact_missing')
    const reason = freshness(state, current)
    if (reason) fail(reason)
    if (state.phase !== 'targeted_passed') fail('test_targeted_not_passed')
    if (!state.plan.targetedCommandHashes.every(hash => state.targetedResults[hash]?.status === 'passed')) fail('test_targeted_not_passed')
    await verifyAllTargetedEvidence(repo, state)
    return writeState(repo, { ...state, phase: 'candidate_frozen', frozenAt: isoNow(), updatedAt: isoNow() })
  })
}

export async function reserveTestRun(repoCandidate = '.', { scope, command, actionId } = {}) {
  if (!['targeted', 'full'].includes(scope)) fail('test_scope_required')
  if (typeof actionId !== 'string' || !actionId) fail('test_action_id_invalid')
  const current = await facts(repoCandidate)
  if (current.stage !== 'test') fail('test_stage_required')
  await assertExecutionOwner(current.repo, actionId)
  const commandHash = digest(argvCheck(command))
  const state = await readState(current.repo)
  if (!state) fail('test_impact_missing')
  const reason = freshness(state, current)
  if (reason) fail(reason)
  if (scope === 'targeted') {
    if (!state.plan.targetedCommandHashes.includes(commandHash)) fail('test_targeted_command_unplanned')
    if (state.phase === 'targeted_passed') fail('test_targeted_complete')
    if (state.phase !== 'impact_ready') fail('test_candidate_frozen')
    return { state, commandHash, current }
  }
  if (state.plan.fullCommandHash !== commandHash) fail('test_full_command_unplanned')
  if (state.fullAttempt || await readFullReservation(current.repo, state.consumptionFingerprint) || ['full_passed', 'full_failed'].includes(state.phase)) fail('test_full_already_attempted')
  if (state.phase !== 'candidate_frozen') fail('test_candidate_not_frozen')
  await verifyAllTargetedEvidence(current.repo, state)
  const reservation = await reserveFullAttempt(current.repo, state, actionId, commandHash)
  const next = {
    ...state,
    fullAttempt: { actionId, commandHash, status: 'running', startedAt: reservation.startedAt, finishedAt: null },
    updatedAt: isoNow(),
  }
  await writeState(current.repo, next)
  return { state: next, commandHash, current }
}

export async function completeTestRun(repoCandidate = '.', { scope, commandHash, actionId, passed, resultStatus = '', requestHash = '', receiptHash = '' } = {}) {
  if (!['targeted', 'full'].includes(scope)) fail('test_scope_required')
  if (!hashPattern.test(requestHash) || !hashPattern.test(receiptHash)) fail('test_evidence_hash_invalid')
  const repo = await repoRoot(repoCandidate)
  await assertExecutionOwner(repo, actionId)
  const state = await readState(repo)
  if (!state) fail('test_impact_missing')
  const finishedAt = isoNow()
  if (scope === 'targeted') {
    if (!state.plan.targetedCommandHashes.includes(commandHash)) fail('test_targeted_command_unplanned')
    const targetedResults = {
      ...state.targetedResults,
      [commandHash]: { status: passed ? 'passed' : 'failed', actionId, requestHash, receiptHash, finishedAt, resultStatus },
    }
    const phase = state.plan.targetedCommandHashes.every(hash => targetedResults[hash]?.status === 'passed')
      ? 'targeted_passed'
      : 'impact_ready'
    return writeState(repo, { ...state, phase, targetedResults, updatedAt: finishedAt })
  }
  if (state.fullAttempt?.actionId !== actionId || state.fullAttempt?.commandHash !== commandHash) fail('test_full_reservation_mismatch')
  const reservation = await readFullReservation(repo, state.consumptionFingerprint)
  if (!reservation || reservation.actionId !== actionId || reservation.commandHash !== commandHash) fail('test_full_reservation_mismatch')
  return writeState(repo, {
    ...state,
    phase: passed ? 'full_passed' : 'full_failed',
    fullAttempt: { ...state.fullAttempt, status: passed ? 'passed' : 'failed', requestHash, receiptHash, resultStatus, finishedAt },
    updatedAt: finishedAt,
  })
}

export async function testExecutionGate(repoCandidate = '.', request = {}) {
  const state = await inspectTestState(repoCandidate)
  if (!state.valid) return { passed: false, reason: state.reason, state }
  if (state.phase !== 'impact_ready') {
    try {
      await verifyAllTargetedEvidence(await repoRoot(repoCandidate), state)
    } catch {
      return { passed: false, reason: 'test_targeted_evidence_invalid', state }
    }
  }
  if (state.fullAttempt?.status === 'running') return { passed: false, reason: 'test_full_attempt_incomplete', state }
  if (state.phase !== 'full_passed') return { passed: false, reason: `test_${state.phase}`, state }
  if (request.testScope !== 'full' || state.fullAttempt?.actionId !== request.id) return { passed: false, reason: 'test_full_evidence_mismatch', state }
  return { passed: true, reason: 'verified_test_sequence', state }
}
