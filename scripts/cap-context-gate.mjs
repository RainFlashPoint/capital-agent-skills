#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkpointDigest, classifyPressure, validateManifest } from './cap-context-checkpoint.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { resolveExecutionStage } from '../runtime/execution/local-support.mjs'
import { semanticCoverageRequirements, validateSemanticCoverage } from './cap-context-coverage.mjs'
import { inspectHistoryRules } from './cap-history-rules.mjs'

const STAGES = new Set(['plan', 'implement', 'test', 'review', 'release'])
const PRESSURES = ['unknown', 'low', 'medium', 'high', 'critical']
const MAX_BYTES = 1024 * 1024
function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
function field(text, key) {
  return text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}
function section(text, heading) {
  const body = text.split(new RegExp(`^## ${heading}[ \\t]*$`, 'mi'))[1] || ''
  return body.split(/^## /m)[0].split('\n').filter(line => !/^(?:context-|provider-compaction(?:-|:)|updated:)/.test(line)).join('\n').trim()
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The complete replay payload must match the validated snapshot. Checking only
// ids permits an edited receipt to silently replace a protected assertion.
export function validateRecoveryReceipt(receipt, manifest, checkpoint, binding) {
  const hot = manifest.plan.hot.map(id => checkpoint.atoms.find(atom => atom.id === id))
  const warmRefs = manifest.plan.warm.flatMap(id => checkpoint.atoms.find(atom => atom.id === id).sourceRefs)
  return receipt?.schemaVersion === 1 && receipt.event === binding.recoveryEvent
    && receipt.digest === manifest.digest && receipt.planDigest === hash(manifest.plan)
    && ['taskId', 'sessionId', 'repo', 'branch', 'commit'].every(key => receipt[key] === binding[key])
    && checkpointDigest(receipt.hot) === checkpointDigest(hot)
    && checkpointDigest(receipt.warmRefs) === checkpointDigest(warmRefs)
}

// Read only bounded regular files through a repository-contained, no-symlink chain.
export async function readContained(repo, path, budget = { remaining: 8 * MAX_BYTES }) {
  if (typeof path !== 'string' || isAbsolute(path) || /\\|\0/.test(path)) throw new Error('context_path_invalid')
  const target = resolve(repo, path)
  const rel = relative(repo, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('context_path_escape')
  let current = repo
  const segments = rel.split(sep)
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i])
    const info = await lstat(current)
    if (info.isSymbolicLink() || (i < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('context_path_invalid')
  }
  const h = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const info = await h.stat()
    if (!info.isFile() || info.size > MAX_BYTES || info.size > budget.remaining) throw new Error('context_read_budget')
    if (await realpath(target) !== target) throw new Error('context_path_invalid')
    budget.remaining -= info.size
    // Fixed-size read also bounds a file that grows after stat.
    const buffer = Buffer.alloc(info.size + 1)
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size) throw new Error('context_source_changed')
    const after = await lstat(target)
    if (after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('context_source_changed')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await h.close() }
}

export async function loadContextManifest(repo, pointer) {
  if (!pointer?.startsWith('.cap/context/')) throw new Error('context_manifest_path')
  const budget = { remaining: 8 * MAX_BYTES }
  const manifest = JSON.parse(await readContained(repo, pointer, budget))
  const resource = path => {
    if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('context_manifest_path')
    return readContained(repo, join(relative(repo, resolve(repo, pointer, '..')), path).split(sep).join('/'), budget)
  }
  const checkpoint = JSON.parse(await resource(manifest.checkpoint))
  const previous = manifest.previousCheckpoint ? JSON.parse(await resource(manifest.previousCheckpoint)) : null
  const atomLogContent = await resource(manifest.atomLog?.path)
  const sourceContents = {}
  for (const source of manifest.sources || []) sourceContents[source.path] = await readContained(repo, source.path, budget)
  return { manifest, checkpoint, previous, atomLogContent, sourceContents }
}

async function inputs(candidate, options = {}) {
  const root = git(resolve(candidate), ['rev-parse', '--show-toplevel'])
  if (!root) throw new Error('context_repository_missing')
  const repo = await realpath(root)
  const session = await inspectSessionRoot({ repoRoot: repo, environment: options.environment || process.env, capture: false, requireExisting: true })
  if (session.blocked) throw new Error('session_root_mismatch')
  const budget = { remaining: 8 * MAX_BYTES }
  const optional = path => readContained(repo, path, budget).catch(e => { if (e.code === 'ENOENT') return ''; throw e })
  const state = await optional('.cap/STATE.md')
  const context = await optional('.cap/task-context.md')
  const spec = await optional('.cap/spec.md')
  const plan = await optional('.cap/plan.md')
  const rawStage = resolveExecutionStage(options, field(state, 'stage').replace(/^cap-/, ''))
  const stage = ({ map: 'understand', shape: 'define', build: 'implement', verify: 'test' })[rawStage] || rawStage
  if (stage && !['understand', 'define', ...STAGES, 'done'].includes(stage)) throw new Error('context_stage_invalid')
  let pressure = options.pressure || field(state, 'context-pressure') || 'unknown'
  if (!PRESSURES.includes(pressure)) throw new Error('context_pressure_invalid')
  const used = field(state, 'context-used-tokens'), window = field(state, 'context-window-tokens')
  if (used || window) {
    if (!used || !window) throw new Error('context_token_observation_invalid')
    const observed = classifyPressure(Number(used), Number(window))
    if (PRESSURES.indexOf(observed) > PRESSURES.indexOf(pressure)) pressure = observed
  }
  const binding = {
    schemaVersion: 1,
    taskId: field(state, 'task-id'),
    sessionId: field(state, 'session-id'),
    repo: sanitizeRepositoryUrl(git(repo, ['remote', 'get-url', 'origin'])) || repo,
    branch: git(repo, ['branch', '--show-current']),
    commit: git(repo, ['rev-parse', '--verify', 'HEAD']) || 'working-tree',
    stage,
    sourceFingerprint: hash(await inspectContextFingerprint(repo)),
    semanticsHash: hash({ taskContext: context, spec, plan, authorization: section(state, 'External operation authorization'), decisions: section(state, 'Decisions log'), gates: section(state, 'Gates passed'), nextAction: section(state, 'Next action') }),
    recoveryEvent: field(state, 'context-recovery-event') || 'none',
    recoveryReceipt: field(state, 'context-recovery-receipt') || 'none',
  }
  const observedResumeEvent = options.resumeEvent || (options.environment || process.env).CAPITAL_AGENT_CONTEXT_RESUME_EVENT || ''
  if (observedResumeEvent && (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(observedResumeEvent) || observedResumeEvent === 'none')) throw new Error('context_recovery_event_invalid')
  return { repo, state, context, binding, pressure, observedResumeEvent, coverageSources: { '.cap/task-context.md': context, '.cap/STATE.md': state, ...(spec ? { '.cap/spec.md': spec } : {}), ...(plan ? { '.cap/plan.md': plan } : {}) } }
}

export async function captureCoverageRequirements(repo, options = {}) {
  return semanticCoverageRequirements((await inputs(repo, options)).coverageSources)
}

export async function capturePublishedPredecessor(repo, options = {}) {
  const input = await inputs(repo, options)
  repo = input.repo
  const { state } = input
  const pointer = field(state, 'context-manifest')
  if (!pointer || pointer === 'none') return null
  if (!pointer.startsWith('.cap/context/')) throw new Error('context_published_predecessor_invalid')
  const manifest = JSON.parse(await readContained(repo, pointer))
  const path = join(relative(repo, resolve(repo, pointer, '..')), manifest.checkpoint || '').split(sep).join('/')
  if (!path.startsWith('.cap/context/') || manifest.digest !== field(state, 'context-checkpoint-digest') || path !== field(state, 'context-checkpoint')) throw new Error('context_published_predecessor_invalid')
  const checkpoint = JSON.parse(await readContained(repo, path))
  if (checkpointDigest(checkpoint) !== manifest.digest) throw new Error('context_published_predecessor_invalid')
  return { path, digest: manifest.digest, manifestPath: pointer, checkpoint }
}

export async function captureContextBinding(repo, options = {}) {
  const { binding } = await inputs(repo, options)
  if (!binding.taskId || !binding.stage) throw new Error('context_task_binding_missing')
  return binding
}

export async function captureContextPressure(repo, options = {}) {
  return (await inputs(repo, options)).pressure
}

export async function inspectSemanticContext(candidate, options = {}) {
  let input
  const result = (reason, { required = true, passed = false, kind = 'refresh_context_checkpoint', ...extra } = {}) => ({
    required, passed, reason, stage: input?.binding.stage || options.stage || '', pressure: input?.pressure || 'unknown',
    ...extra,
    nextActions: passed || !required ? [] : [{ kind, label: kind === 'create_context_checkpoint' ? '生成并校验语义检查点' : kind === 'recover_context_checkpoint' ? '校验并恢复语义检查点' : '刷新并校验语义检查点', reason, requiresUser: false, reference: 'cap-flow/references/context-compaction.md' }],
    remediation: passed || !required ? '' : '按 context-compaction.md 核对原始来源，保留前驱并生成当前阶段的检查点，用 create-manifest --bind-entry 绑定输入；校验后由 STATE 单写者更新指针，再重跑阶段门。不要向用户索取新的实施授权。',
  })
  try { input = await inputs(candidate, options) } catch { return result('context_inputs_invalid') }
  const { repo, state, context, binding, pressure, observedResumeEvent, coverageSources } = input
  const pointer = field(state, 'context-manifest')
  const active = binding.taskId && field(state, 'stage') && context && binding.stage !== 'done'
  const required = Boolean(active && (observedResumeEvent || STAGES.has(binding.stage) || PRESSURES.indexOf(pressure) >= 2 || (pointer && pointer !== 'none')))
  if (required && observedResumeEvent && observedResumeEvent !== binding.recoveryEvent) return result('context_recovery_required', { kind: 'recover_context_checkpoint', observedResumeEvent })
  if (active) {
    const historyRules = inspectHistoryRules(context, { repo: binding.repo, taskId: binding.taskId })
    if (!historyRules.passed) return { ...historyRules, stage: binding.stage, pressure }
  }
  if (!required) return result('context_not_required', { required: false, passed: true })
  if (!pointer || pointer === 'none' || pointer.startsWith('<')) return result('context_checkpoint_missing', { kind: 'create_context_checkpoint' })
  try {
    const { manifest, checkpoint, previous, atomLogContent, sourceContents } = await loadContextManifest(repo, pointer)
    const entry = manifest.entry
    if (!entry || entry.schemaVersion !== 1) return result('context_entry_binding_missing')
    const publishedPreviousDigest = field(state, 'context-previous-digest')
    if (entry.previousManifest !== (field(state, 'context-previous-manifest') || 'none') || entry.previousDigest !== (publishedPreviousDigest && publishedPreviousDigest !== 'none' ? publishedPreviousDigest : null)) return result('context_predecessor_invalid')
    for (const key of ['taskId', 'repo', 'branch', 'commit']) if (manifest.identity[key] !== binding[key] || entry[key] !== binding[key]) return result('context_identity_changed')
    if (entry.sessionId !== binding.sessionId) return result('context_identity_changed')
    if (entry.sourceFingerprint !== binding.sourceFingerprint) return result('context_sources_changed')
    if (manifest.identity.stage !== binding.stage || entry.stage !== binding.stage) return result('context_stage_changed')
    if (entry.semanticsHash !== binding.semanticsHash) return result('context_semantics_changed')
    const providerStatus = field(state, 'provider-compaction')
    if (['requested', 'running', 'failed'].includes(providerStatus) || ['requested', 'running', 'failed'].includes(manifest.provider.status)) return result('context_provider_pending', { kind: 'recover_context_checkpoint' })
    if (manifest.provider.status === 'succeeded' && providerStatus !== 'succeeded') return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    if (providerStatus === 'succeeded' && (field(state, 'provider-compaction-event') !== manifest.provider.eventRef || (field(state, 'provider-compaction-kind') && field(state, 'provider-compaction-kind') !== manifest.provider.kind))) return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    if (providerStatus === 'succeeded' && binding.recoveryEvent === 'none') return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    if (providerStatus === 'succeeded' && binding.recoveryEvent !== manifest.provider.eventRef) return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    if (entry.recoveryEvent !== binding.recoveryEvent) return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    const checked = validateManifest(manifest, { checkpoint, previous, atomLogContent, sourceContents })
    if (!checked.valid) return result('context_manifest_invalid', { errors: checked.errors.map(e => e.code) })
    if (entry.previousManifest === 'none') {
      if (entry.previousDigest !== null || manifest.previousDigest !== null) return result('context_predecessor_invalid')
    } else {
      if (!entry.previousManifest?.startsWith('.cap/context/')) return result('context_predecessor_invalid')
      const ancestor = await loadContextManifest(repo, entry.previousManifest)
      const ancestorPath = join(relative(repo, resolve(repo, entry.previousManifest, '..')), ancestor.manifest.checkpoint).split(sep).join('/')
      if (ancestor.manifest.digest !== entry.previousDigest || checkpointDigest(ancestor.checkpoint) !== entry.previousDigest) return result('context_predecessor_invalid')
      const expectedPrevious = relative(resolve(repo, pointer, '..'), resolve(repo, ancestorPath)).split(sep).join('/')
      if (manifest.previousDigest !== null && (manifest.previousDigest !== entry.previousDigest || manifest.previousCheckpoint !== expectedPrevious)) return result('context_predecessor_invalid')
      if (manifest.previousDigest === null && (entry.previousDigest !== manifest.digest || ancestorPath !== field(state, 'context-checkpoint'))) return result('context_predecessor_invalid')
    }
    const coverageErrors = validateSemanticCoverage(checkpoint, semanticCoverageRequirements(coverageSources))
    if (coverageErrors.length) return result('context_semantic_coverage_incomplete', { errors: coverageErrors })
    if (binding.recoveryEvent !== 'none') {
      try {
        if (!binding.recoveryReceipt.startsWith('.cap/context/')) throw new Error('recovery_receipt_missing')
        const receipt = JSON.parse(await readContained(repo, binding.recoveryReceipt))
        if (!validateRecoveryReceipt(receipt, manifest, checkpoint, binding) || entry.recoveryReceipt !== binding.recoveryReceipt) throw new Error('recovery_receipt_mismatch')
      } catch { return result('context_recovery_required', { kind: 'recover_context_checkpoint' }) }
    }
    if (providerStatus === 'succeeded') {
      const event = field(state, 'provider-compaction-event')
      const kind = field(state, 'provider-compaction-kind')
      if (!event || event === 'none' || manifest.provider.eventRef !== event || (kind && kind !== manifest.provider.kind) || !validateManifest(manifest, { checkpoint, previous, atomLogContent, sourceContents, requireRecovery: true }).valid) return result('context_recovery_required', { kind: 'recover_context_checkpoint' })
    }
    if (PRESSURES.indexOf(pressure) > PRESSURES.indexOf(manifest.pressure)) return result('context_pressure_increased')
    if (field(state, 'context-checkpoint-digest') !== manifest.digest || field(state, 'context-checkpoint') !== join(relative(repo, resolve(repo, pointer, '..')), manifest.checkpoint).split(sep).join('/')) return result('context_pointer_mismatch')
    return result('context_checkpoint_current', { passed: true, manifest: pointer, digest: manifest.digest })
  } catch { return result('context_manifest_invalid') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo = '.', ...args] = process.argv.slice(2)
  const option = name => args[args.indexOf(name) + 1]
  const result = await inspectSemanticContext(repo, { stage: args.includes('--stage') ? option('--stage') : '', pressure: args.includes('--pressure') ? option('--pressure') : '' })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.passed) process.exitCode = 1
}
