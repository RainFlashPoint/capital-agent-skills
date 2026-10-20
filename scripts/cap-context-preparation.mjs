import { randomUUID, createHash } from 'node:crypto'
import { writeFile, readFile, rename, rm, open } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { captureContextBinding, captureContextPressure, captureCoverageRequirements, capturePublishedPredecessor, inspectSemanticContext, loadContextManifest, readContained, validateRecoveryReceipt } from './cap-context-gate.mjs'
import { checkpointDigest, createManifest, fileSource, validateCheckpointTransition, validateManifest, planContext, contextReplay } from './cap-context-checkpoint.mjs'
import { validateSemanticCoverage, semanticProtectionAdvisories } from './cap-context-coverage.mjs'
import { resolveExecutionStage } from '../runtime/execution/local-support.mjs'

const field = (text, key) => text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const setField = (text, key, value) => new RegExp(`^(?:- )?${key}:.*$`, 'm').test(text) ? text.replace(new RegExp(`^(?:- )?${key}:.*$`, 'm'), `${key}: ${value}`) : `${text.trimEnd()}\n${key}: ${value}\n`
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const problem = (code, path = '$') => ({ code, path })
const failed = errors => ({ valid: false, errors })

async function replaceState(repo, previous, next) {
  const path = join(repo, '.cap', `.STATE-prepare-${randomUUID()}.tmp`)
  try {
    await writeFile(path, next, { flag: 'wx', mode: 0o600 })
    if (await readContained(repo, '.cap/STATE.md') !== previous) throw new Error('context_state_changed')
    await rename(path, join(repo, '.cap/STATE.md'))
  } finally { await rm(path, { force: true }) }
}

// The driver remains the single STATE writer. This lock serializes its prepare
// calls; an interrupted writer is reported, never silently treated as success.
export async function prepareContext(candidate, options = {}) {
  const { inspectBoundary } = await import('./cap-runtime.mjs')
  let repo, lock
  try {
    repo = (await inspectBoundary(candidate, { environment: options.environment || process.env })).repo
    await readContained(repo, '.cap/STATE.md')
    lock = await open(join(repo, '.cap/.context-prepare.lock'), 'wx', 0o600)
    await lock.writeFile(`${process.pid}\n`)
    return await prepareLocked(repo, options)
  } catch (cause) {
    return failed(cause.blockers || [problem(cause.code === 'EEXIST' ? 'context_writer_busy' : cause.message || 'context_preflight_failed')])
  } finally {
    if (lock) {
      await lock.close()
      await rm(join(repo, '.cap/.context-prepare.lock'), { force: true })
    }
  }
}

async function prepareLocked(repo, { checkpointPath, budgetTokens, event, deferRecovery = false, environment = process.env } = {}) {
  const { inspectTaskContext } = await import('./cap-runtime.mjs')
  let state = await readContained(repo, '.cap/STATE.md')
  const hostEvent = environment.CAPITAL_AGENT_CONTEXT_RESUME_EVENT
  if (event && hostEvent && event !== hostEvent) return failed([problem('context_recovery_event_mismatch')])
  event ||= hostEvent
  if (deferRecovery && !event) return failed([problem('context_recovery_event_invalid')])
  if (event && (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(event) || event === 'none')) return failed([problem('context_recovery_event_invalid')])
  // A visible event must remain blocking even when reconnaissance/coverage fails.
  if (event && event !== field(state, 'context-recovery-event')) {
    const next = setField(setField(state, 'context-recovery-event', event), 'context-recovery-receipt', 'none')
    await replaceState(repo, state, next)
    state = next
  }
  // A native pre-compaction callback marks the event before the runtime may
  // discard context. Missing/failed post callbacks must leave stage gates shut.
  if (deferRecovery) return { valid: true, pending: true, event, errors: [] }
  const errors = []
  const stage = resolveExecutionStage({}, field(state, 'stage').replace(/^cap-/, ''))
  try { await inspectTaskContext(repo, { stage, checkSemantic: false, environment }) }
  catch (cause) { errors.push(...(cause.blockers || [problem(cause.code || 'context_preflight_failed')])) }
  checkpointPath ||= field(state, 'context-checkpoint')
  // Fixed output directory keeps every predecessor/log/manifest reference local.
  if (!/^\.cap\/context\/[^/\\]+\.json$/.test(checkpointPath || '')) return failed([...errors, problem('context_checkpoint_path_invalid')])
  let checkpoint, predecessor, requirements
  try { checkpoint = JSON.parse(await readContained(repo, checkpointPath)) }
  catch { return failed([...errors, problem('context_checkpoint_invalid')]) }
  try { predecessor = await capturePublishedPredecessor(repo, { environment }) }
  catch { errors.push(problem('context_published_predecessor_invalid')) }
  try { requirements = await captureCoverageRequirements(repo, { environment }) }
  catch { return failed([...errors, problem('context_inputs_invalid')]) }
  const same = predecessor?.digest === checkpointDigest(checkpoint) && predecessor?.path === checkpointPath
  if (predecessor && !same) errors.push(...validateCheckpointTransition(predecessor.checkpoint, checkpoint).errors)
  if (predecessor && !same && predecessor.digest === checkpointDigest(checkpoint)) errors.push(problem('context_snapshot_duplicate'))
  const plan = planContext(checkpoint, { budgetTokens })
  errors.push(...plan.errors, ...validateSemanticCoverage(checkpoint, requirements))
  const binding = await captureContextBinding(repo, { environment })
  const pressure = await captureContextPressure(repo, { environment })
  for (const key of ['taskId', 'repo', 'branch', 'commit', 'stage']) if (checkpoint.identity?.[key] !== binding[key]) errors.push(problem('context_entry_identity_mismatch', key))
  const provider = {
    status: field(state, 'provider-compaction') || 'unavailable',
    kind: field(state, 'provider-compaction-kind') || 'none',
    eventRef: field(state, 'provider-compaction-event') || null,
  }
  if (provider.eventRef === 'none') provider.eventRef = null
  if (['requested', 'running', 'failed'].includes(provider.status)) errors.push(problem('context_provider_pending'))
  if (provider.status === 'succeeded' && (!binding.recoveryEvent || binding.recoveryEvent === 'none' || provider.eventRef !== binding.recoveryEvent)) errors.push(problem('context_provider_event_mismatch'))
  if (errors.length) return failed(errors)
  const existing = await inspectSemanticContext(repo, { environment })
  if (same && existing.passed) {
    const snapshot = await loadContextManifest(repo, existing.manifest)
    if (snapshot.manifest.hotBudgetTokens === budgetTokens && snapshot.manifest.entry.runtimeSessionId === binding.runtimeSessionId) return { valid: true, reused: true, manifest: existing.manifest, digest: existing.digest, errors: [], warnings: semanticProtectionAdvisories(checkpoint, requirements) }
  }

  const sources = {}
  for (const path of ['.cap/STATE.md', '.cap/task-context.md', '.cap/spec.md', '.cap/plan.md']) {
    try { sources[path] = await readContained(repo, path) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  }
  for (const atom of checkpoint.atoms) for (const ref of atom.sourceRefs) {
    const path = fileSource(ref)
    if (path && !Object.hasOwn(sources, path)) sources[path] = await readContained(repo, path)
  }
  const id = randomUUID()
  const log = checkpoint.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n'
  const logDigest = createHash('sha256').update(log).digest('hex')
  const logPath = `.cap/context/atoms-${logDigest}.jsonl`
  const manifestPath = `.cap/context/manifest-${id}.json`
  const makeManifest = currentBinding => {
    const manifest = createManifest(checkpoint, {
      checkpointPath: posix.basename(checkpointPath),
      previous: predecessor && !same ? predecessor.checkpoint : null,
      previousPath: predecessor && !same ? posix.basename(predecessor.path) : null,
      atomLogPath: posix.basename(logPath), atomLogContent: log, budgetTokens,
      trigger: binding.recoveryEvent !== 'none' ? 'visible-resume' : 'stage-entry',
      pressure, provider, sourceContents: sources,
    })
    manifest.entry = { ...currentBinding, previousManifest: predecessor?.manifestPath || 'none', previousDigest: predecessor?.digest || null }
    return manifest
  }
  let manifest = makeManifest(binding)
  let checked = validateManifest(manifest, { checkpoint, previous: predecessor && !same ? predecessor.checkpoint : null, atomLogContent: log, sourceContents: sources })
  if (!checked.valid) return failed(checked.errors)
  let recovery = null
  if (binding.recoveryEvent !== 'none') {
    const path = binding.recoveryReceipt
    try {
      const old = JSON.parse(await readContained(repo, path))
      if (validateRecoveryReceipt(old, manifest, checkpoint, binding)) recovery = old
    } catch { /* An absent/stale receipt requires exact replay of this candidate. */ }
    if (!recovery) {
      recovery = { schemaVersion: 1, event: binding.recoveryEvent, ...Object.fromEntries(['taskId', 'sessionId', 'repo', 'branch', 'commit'].map(key => [key, binding[key]])), digest: manifest.digest, planDigest: hash(manifest.plan), ...contextReplay(checkpoint, manifest.plan) }
      const path = `.cap/context/recovery-${id}.json`
      await writeFile(join(repo, path), `${JSON.stringify(recovery, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      const next = setField(state, 'context-recovery-receipt', path)
      await replaceState(repo, state, next)
      state = next
      sources['.cap/STATE.md'] = state
    }
  }
  const currentBinding = await captureContextBinding(repo, { environment })
  for (const key of ['taskId', 'sessionId', 'runtimeSessionId', 'repo', 'branch', 'commit', 'stage', 'sourceFingerprint', 'semanticsHash', 'recoveryEvent']) if (currentBinding[key] !== binding[key]) return failed([problem('context_inputs_changed', key)])
  if (checkpointDigest(JSON.parse(await readContained(repo, checkpointPath))) !== checkpointDigest(checkpoint)) return failed([problem('context_checkpoint_changed')])
  manifest = makeManifest(currentBinding)
  checked = validateManifest(manifest, { checkpoint, previous: predecessor && !same ? predecessor.checkpoint : null, atomLogContent: log, sourceContents: sources })
  if (!checked.valid) return failed(checked.errors)
  let atomCreated = false
  let manifestCreated = false
  let published = false
  try {
    try {
      await writeFile(join(repo, logPath), log, { flag: 'wx', mode: 0o600 })
      atomCreated = true
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      if (await readFile(join(repo, logPath), 'utf8') !== log) throw new Error('context_atom_hash_collision')
    }
    await writeFile(join(repo, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    manifestCreated = true
    let next = state
    for (const [key, value] of Object.entries({ 'context-checkpoint': checkpointPath, 'context-checkpoint-digest': manifest.digest, 'context-manifest': manifestPath, 'context-previous-manifest': predecessor?.manifestPath || 'none', 'context-previous-digest': predecessor?.digest || 'none' })) next = setField(next, key, value)
    await replaceState(repo, state, next)
    published = true
  } finally {
    if (!published) {
      if (manifestCreated) await rm(join(repo, manifestPath), { force: true })
      if (atomCreated) await rm(join(repo, logPath), { force: true })
    }
  }
  const gate = await inspectSemanticContext(repo, { environment })
  return { valid: gate.passed, reused: false, manifest: manifestPath, digest: manifest.digest, recovery, warnings: semanticProtectionAdvisories(checkpoint, requirements), errors: gate.passed ? [] : [problem(gate.reason)], contextGate: gate, nextAction: gate.passed ? 'Read replayed hot atoms and resolve needed warm references before continuing; rerun the full stage guard.' : gate.remediation }
}
