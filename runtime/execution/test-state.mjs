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
  gitBuffer,
  jsonFile,
  repoRoot,
  safePath,
  stageName,
  textFile,
  argvCheck,
  versions,
} from './local-support.mjs'

const statePath = '.cap/execution/test-state.json'
const fullAttemptsPath = 'capital-agent/test-full-attempts'
const phases = new Set(['impact_ready', 'targeted_passed', 'candidate_frozen', 'full_passed', 'full_failed'])
const checks = /^(?:logic|model|journey(?::(?:Web|OpenAPI|App))?)$/
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const emptyFingerprint = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const same = (left, right) => canonical(left) === canonical(right)
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

function isoNow() {
  return new Date().toISOString()
}

function uniqueStrings(values, code, pattern = null) {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) fail(code)
  const normalized = values.map(value => value.trim())
  if (new Set(normalized).size !== normalized.length || (pattern && normalized.some(value => !pattern.test(value)))) fail(code)
  return normalized
}

function changedFiles(values, { allowEmpty = false } = {}) {
  if (allowEmpty && Array.isArray(values) && values.length === 0) return []
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.length || value.includes('\0'))) {
    fail('test_impact_changed_files_invalid')
  }
  const files = [...values]
  if (new Set(files).size !== files.length) fail('test_impact_changed_files_invalid')
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

function cleanSourceSnapshot(snapshot) {
  return ['index', 'worktree', 'untracked'].every(key => snapshot?.[key] === emptyFingerprint)
}

function gitPaths(repo, args) {
  const output = gitBuffer(repo, [...args, '-z']).toString('utf8')
  return output ? output.split('\0').filter(Boolean) : []
}

function actualChangedFiles(repo, base) {
  const files = new Set([
    ...gitPaths(repo, ['diff', '--no-renames', '--name-only', `${base}...HEAD`]),
    ...gitPaths(repo, ['diff', '--no-renames', '--name-only']),
    ...gitPaths(repo, ['diff', '--cached', '--no-renames', '--name-only']),
    ...gitPaths(repo, ['ls-files', '--others', '--exclude-standard']),
  ])
  return changedFiles([...files], { allowEmpty: true })
}

async function trustedTaskBaseCommit(repo, task) {
  if (!idPattern.test(task)) fail('test_identity_missing')
  const baseline = await jsonFile(repo, `.cap/local-state/task-baselines/${task}.json`).catch(error => {
    if (error.code === 'ENOENT') fail('test_task_baseline_missing')
    throw error
  })
  if (baseline?.schema !== 1 || baseline.taskId !== task || !Array.isArray(baseline.dirtyPaths) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.head || '')) fail('test_task_baseline_invalid')
  const baselineRepo = await realpath(resolve(baseline.repo || '')).catch(() => null)
  if (baselineRepo !== repo) fail('test_task_baseline_invalid')
  return baseline.head
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
  const baseCommit = await trustedTaskBaseCommit(repo, task)
  if (field(state, 'base-commit') !== baseCommit) fail('test_base_commit_mismatch')
  const snapshot = await inspectContextFingerprint(repo, { rejectSkipWorktree: true })
  const identity = { repo, task, session, branch, commit, baseCommit }
  const sourceFingerprint = digest({ identity, snapshot })
  const consumptionFingerprint = digest({
    commit,
    index: snapshot.index,
    worktree: snapshot.worktree,
    untracked: snapshot.untracked,
  })
  return { repo, stage: stageName(field(state, 'stage')), identity, snapshot, sourceFingerprint, consumptionFingerprint, recorderVersion: versions.recorder, actualChangedFiles: actualChangedFiles(repo, baseCommit) }
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !phases.has(state.phase)) fail('test_state_invalid')
  if (!state.identity || !state.snapshot || !hashPattern.test(state.sourceFingerprint || '') || !hashPattern.test(state.consumptionFingerprint || '') || !hashPattern.test(state.recorderVersion || '')) fail('test_state_invalid')
  const plan = state.plan
  if (!plan || !Array.isArray(plan.changedFiles) || !Array.isArray(plan.activeChecks) || !plan.activeChecks.length) fail('test_state_invalid')
  const planMode = plan.mode || 'change'
  if (!['change', 'baseline-audit'].includes(planMode)) fail('test_state_invalid')
  try {
    changedFiles(plan.changedFiles, { allowEmpty: planMode === 'baseline-audit' })
    uniqueStrings(plan.activeChecks, 'test_state_invalid', checks)
  } catch {
    fail('test_state_invalid')
  }
  if (planMode === 'change' && (plan.changedFiles.length === 0 || (plan.auditScope !== undefined && plan.auditScope !== null))) fail('test_state_invalid')
  if (planMode === 'baseline-audit' && (plan.changedFiles.length !== 0 || plan.auditScope !== 'full-chain' || !plan.activeChecks.some(check => check === 'journey' || check.startsWith('journey:')) || !cleanSourceSnapshot(state.snapshot))) fail('test_state_invalid')
  if (!Array.isArray(plan.targetedCommandHashes) || !plan.targetedCommandHashes.length || typeof plan.fullCommandHash !== 'string') fail('test_state_invalid')
  if (!plan.targetedCommandHashes.every(hash => hashPattern.test(hash)) || new Set(plan.targetedCommandHashes).size !== plan.targetedCommandHashes.length || !hashPattern.test(plan.fullCommandHash)) fail('test_state_invalid')
  if (plan.targetedCommandHashes.includes(plan.fullCommandHash)) fail('test_state_invalid')
  if (!state.targetedResults || typeof state.targetedResults !== 'object' || Array.isArray(state.targetedResults)) fail('test_state_invalid')
  if (state.fullAttempt !== null && (typeof state.fullAttempt !== 'object' || !idPattern.test(state.fullAttempt.actionId || ''))) fail('test_state_invalid')
  if (digest({ identity: state.identity, snapshot: state.snapshot }) !== state.sourceFingerprint) fail('test_state_invalid')
  if (digest({ commit: state.identity.commit, index: state.snapshot.index, worktree: state.snapshot.worktree, untracked: state.snapshot.untracked }) !== state.consumptionFingerprint) fail('test_state_invalid')
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
  if (state.plan.mode === 'change' && !same(state.plan.changedFiles, current.actualChangedFiles)) return 'test_impact_changed_files_mismatch'
  if (state.plan.mode === 'baseline-audit' && current.actualChangedFiles.length) return 'test_impact_changed_files_mismatch'
  return ''
}

async function readState(repo) {
  const state = await textFile(repo, statePath).then(parseJson).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return state ? validateState(state) : null
}

async function fullAttemptLocation(repo, consumptionFingerprint, { create = false } = {}) {
  if (!hashPattern.test(consumptionFingerprint)) fail('test_state_invalid')
  const commonPath = git(repo, ['rev-parse', '--git-common-dir'])
  const commonRoot = await realpath(isAbsolute(commonPath) ? commonPath : resolve(repo, commonPath)).catch(() => fail('execution_git_failed'))
  if (create) await safePath(commonRoot, fullAttemptsPath, { create: true })
  return {
    root: commonRoot,
    path: `${fullAttemptsPath}/${consumptionFingerprint}.json`,
    fullPath: join(commonRoot, fullAttemptsPath, `${consumptionFingerprint}.json`),
  }
}

function validateFullReservation(value, consumptionFingerprint) {
  if (!value || value.schemaVersion !== 1 || value.consumptionFingerprint !== consumptionFingerprint || !hashPattern.test(value.sourceFingerprint || '') || !idPattern.test(value.actionId || '') || !hashPattern.test(value.commandHash || '')) fail('test_full_reservation_invalid')
  if (!value.identity || !value.snapshot || digest({ identity: value.identity, snapshot: value.snapshot }) !== value.sourceFingerprint) fail('test_full_reservation_invalid')
  if (digest({ commit: value.identity.commit, index: value.snapshot.index, worktree: value.snapshot.worktree, untracked: value.snapshot.untracked }) !== consumptionFingerprint) fail('test_full_reservation_invalid')
  return value
}

async function readFullReservation(repo, consumptionFingerprint) {
  const location = await fullAttemptLocation(repo, consumptionFingerprint)
  return jsonFile(location.root, location.path).then(value => validateFullReservation(value, consumptionFingerprint)).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function assertExecutionOwner(repo, actionId) {
  const owner = await jsonFile(repo, '.cap/execution/.lock/owner.json').catch(() => fail('execution_in_progress_or_interrupted'))
  if (owner?.id !== actionId || owner?.pid !== process.pid) fail('execution_in_progress_or_interrupted')
}

async function reserveFullAttempt(repo, state, actionId, commandHash) {
  const location = await fullAttemptLocation(repo, state.consumptionFingerprint, { create: true })
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
    await atomicJson(location.fullPath, reservation, { exclusive: true })
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

async function terminalFullResult(repo, state, actionId) {
  const pointer = await jsonFile(repo, '.cap/execution/latest-test.json').catch(() => fail('test_full_evidence_invalid'))
  const evidence = await jsonFile(repo, `.cap/execution/${actionId}/gate.json`).catch(() => fail('test_full_evidence_invalid'))
  const request = evidence.envelope
  const receipt = evidence.receipt
  if (pointer?.schemaVersion !== 2 || pointer.id !== actionId || pointer.requestHash !== evidence.envelopeHash) fail('test_full_evidence_invalid')
  if (evidence.schemaVersion !== 3 || evidence.status !== 'terminal' || request?.id !== actionId || request.stage !== 'test' || request.testScope !== 'full') fail('test_full_evidence_invalid')
  if (request.schemaVersion !== 2 || request.trust !== 'local-observed' || receipt?.schemaVersion !== 2 || receipt.authority !== 'local-observed') fail('test_full_evidence_invalid')
  if (request.commandHash !== state.plan.fullCommandHash || request.commandHash !== state.fullAttempt?.commandHash) fail('test_full_evidence_invalid')
  for (const key of ['repo', 'task', 'session', 'branch', 'commit']) if (request[key] !== state.identity[key]) fail('test_full_evidence_invalid')
  for (const key of ['root', 'index', 'worktree', 'untracked']) if (request.snapshot?.[key] !== state.snapshot[key]) fail('test_full_evidence_invalid')
  if (!same(request.versions, versions) || evidence.envelopeHash !== digest(request)) fail('test_full_evidence_invalid')
  if (evidence.receiptHash !== digest(receipt) || evidence.diagnosticHash !== digest(evidence.diagnostic)) fail('test_full_evidence_invalid')
  if (receipt.envelopeId !== actionId || receipt.envelopeHash !== evidence.envelopeHash) fail('test_full_evidence_invalid')
  for (const key of ['repo', 'task', 'session', 'branch', 'commit']) if (receipt[key] !== state.identity[key]) fail('test_full_evidence_invalid')
  if (!same(receipt.afterSnapshot, request.snapshot)) fail('test_full_evidence_invalid')
  if (!validDate(request.startedAt) || !validDate(receipt.finishedAt) || receipt.finishedAt < request.startedAt || receipt.finishedAt > isoNow()) fail('test_full_evidence_invalid')
  if (!['passed', 'failed', 'timed_out', 'output_limit', 'spawn_failed'].includes(receipt.status)) fail('test_full_evidence_invalid')
  if (!(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) || !(receipt.signal === null || typeof receipt.signal === 'string' && receipt.signal.length > 0)) fail('test_full_evidence_invalid')
  if (!hashPattern.test(receipt.stdoutHash || '') || !hashPattern.test(receipt.stderrHash || '')) fail('test_full_evidence_invalid')
  return {
    passed: receipt.status === 'passed' && receipt.exitCode === 0 && !receipt.signal,
    resultStatus: receipt.status,
    requestHash: evidence.envelopeHash,
    receiptHash: evidence.receiptHash,
  }
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
    if (await readFullReservation(repo, current.consumptionFingerprint)) fail('test_full_already_attempted')
    const planMode = options.planMode || 'change'
    if (!['change', 'baseline-audit'].includes(planMode)) fail('test_impact_mode_invalid')
    const activeChecks = uniqueStrings(options.activeChecks, 'test_active_checks_invalid', checks).sort()
    if (planMode === 'baseline-audit' && (options.auditScope !== 'full-chain' || !activeChecks.some(check => check === 'journey' || check.startsWith('journey:')))) fail('test_baseline_audit_checks_invalid')
    if (planMode === 'baseline-audit' && !cleanSourceSnapshot(current.snapshot)) fail('test_baseline_audit_source_dirty')
    if (planMode === 'change' && options.auditScope !== undefined && options.auditScope !== null) fail('test_impact_mode_invalid')
    const declaredChangedFiles = changedFiles(options.changedFiles, { allowEmpty: planMode === 'baseline-audit' })
    if (!same(declaredChangedFiles, current.actualChangedFiles)) fail('test_impact_changed_files_mismatch')
    const plan = {
      mode: planMode,
      auditScope: planMode === 'baseline-audit' ? options.auditScope : null,
      changedFiles: declaredChangedFiles,
      activeChecks,
      targetedCommandHashes: commandHashes(options.targetedCommands).sort(),
      fullCommandHash: digest(argvCheck(options.fullCommand)),
    }
    if (plan.targetedCommandHashes.includes(plan.fullCommandHash)) fail('test_full_command_overlaps_targeted')
    const existing = await readState(repo)
    if (existing && !freshness(existing, current)) {
      if (existing.fullAttempt || ['full_passed', 'full_failed'].includes(existing.phase)) fail('test_full_already_attempted')
      if (existing.phase === 'candidate_frozen') fail('test_candidate_frozen')
      if (same(existing.plan, plan)) return existing
      if (Object.values(existing.targetedResults).some(result => result.status !== 'pending')) fail('test_impact_plan_locked')
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

export async function reconcileTerminalTestRun(repoCandidate = '.', actionId = '') {
  if (!idPattern.test(actionId)) fail('test_action_id_invalid')
  const repo = await repoRoot(repoCandidate)
  return withExecutionLock(repo, 'reconcile', async () => {
    const state = await readState(repo)
    if (!state) fail('test_impact_missing')
    if (state.fullAttempt?.actionId !== actionId) return state
    if (state.fullAttempt.status !== 'running') return state
    const current = await facts(repo)
    if (current.stage !== 'test') fail('test_stage_required')
    const reason = freshness(state, current)
    if (reason) fail(reason)
    const reservation = await readFullReservation(repo, state.consumptionFingerprint)
    if (!reservation || reservation.actionId !== actionId || reservation.commandHash !== state.fullAttempt.commandHash) fail('test_full_reservation_mismatch')
    const result = await terminalFullResult(repo, state, actionId)
    const finishedAt = isoNow()
    const { passed, ...evidenceResult } = result
    return writeState(repo, {
      ...state,
      phase: passed ? 'full_passed' : 'full_failed',
      fullAttempt: { ...state.fullAttempt, status: passed ? 'passed' : 'failed', ...evidenceResult, finishedAt },
      updatedAt: finishedAt,
    })
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
