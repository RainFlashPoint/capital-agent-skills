import { createHash, randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertContextArtifactPointer, captureContextBindingDetails, loadContextManifest, readContained, validatePublishedSnapshotIntegrity, validateRecoveryReceipt } from './cap-context-gate.mjs'
import { contextReplay, TASK_CONTEXT_PROJECTION } from './cap-context-checkpoint.mjs'

const field = (text, key) => text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const setField = (text, key, value) => new RegExp(`^(?:- )?${key}:.*$`, 'm').test(text) ? text.replace(new RegExp(`^(?:- )?${key}:.*$`, 'm'), `${key}: ${value}`) : `${text.trimEnd()}\n${key}: ${value}\n`

// Called only when the agent receives a visible summary/resume or host event.
// Emitting hot atoms is local replay evidence, never a claim of provider success.
export async function observeContextResume(repo, { event = `visible-resume:${randomUUID()}`, environment = process.env } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(event) || event === 'none') throw new Error('context_recovery_event_invalid')
  const { inspectBoundary } = await import('./cap-runtime.mjs')
  repo = (await inspectBoundary(repo, { environment })).repo
  const state = await readContained(repo, '.cap/STATE.md')
  const { binding, legacySemanticsHash } = await captureContextBindingDetails(repo, { environment })
  if (field(state, 'context-recovery-event') === event && field(state, 'context-recovery-receipt') !== 'none') {
    try {
      const path = field(state, 'context-recovery-receipt')
      assertContextArtifactPointer(repo, path, 'context_recovery_receipt_path_invalid')
      const manifestPath = field(state, 'context-manifest')
      const snapshot = await loadContextManifest(repo, manifestPath)
      const integrity = await validatePublishedSnapshotIntegrity(repo, snapshot, binding, { expectedManifestSha256: field(state, 'context-manifest-sha256'), allowSourceDrift: true, manifestPath })
      if (!integrity.valid) throw new Error(integrity.errors.map(item => item.code).join(','))
      const provider = field(state, 'provider-compaction')
      if (['requested', 'running', 'failed'].includes(provider)) throw new Error('context_provider_pending')
      if (provider === 'succeeded' && (field(state, 'provider-compaction-event') !== event || snapshot.manifest.provider.eventRef !== event)) throw new Error('context_provider_event_mismatch')
      const expectedSemanticsHash = snapshot.manifest.entry?.semanticsProjection === TASK_CONTEXT_PROJECTION ? binding.semanticsHash : legacySemanticsHash
      if (snapshot.manifest.entry?.sourceFingerprint !== binding.sourceFingerprint || snapshot.manifest.entry?.semanticsHash !== expectedSemanticsHash) throw new Error('context_sources_changed')
      const receipt = JSON.parse(await readContained(repo, path))
      const receiptBinding = { ...binding, recoveryEvent: event }
      if (!validateRecoveryReceipt(receipt, snapshot.manifest, snapshot.checkpoint, receiptBinding)) throw new Error('receipt_mismatch')
      const { recoverySummary } = await import('./cap-context-recovery-pages.mjs')
      return { valid: true, reused: true, outputMode: 'compact', event, errors: [], recovery: null, recoveryPages: recoverySummary(receipt, path), nextAction: 'Previously verified recovery event; read saved pages if this runtime has not consumed them, then bind and guard.' }
    } catch { return { valid: false, event, errors: [{ code: 'context_recovery_receipt_invalid', path: 'context-recovery-receipt' }], recovery: null } }
  }
  let snapshot, errors = []
  try {
    const manifestPath = field(state, 'context-manifest')
    snapshot = await loadContextManifest(repo, manifestPath)
    const expectedManifestSha256 = field(state, 'context-manifest-sha256')
    const integrity = await validatePublishedSnapshotIntegrity(repo, snapshot, binding, { expectedManifestSha256, allowSourceDrift: false, manifestPath })
    errors = [...integrity.errors]
    for (const key of ['taskId', 'repo', 'branch', 'commit', 'stage']) if (snapshot.manifest.identity[key] !== binding[key]) errors.push({ code: 'context_identity_changed', path: key })
    if (snapshot.manifest.entry?.sessionId !== binding.sessionId) errors.push({ code: 'context_identity_changed', path: 'sessionId' })
    const expectedSemanticsHash = snapshot.manifest.entry?.semanticsProjection === TASK_CONTEXT_PROJECTION ? binding.semanticsHash : legacySemanticsHash
    if (snapshot.manifest.entry?.sourceFingerprint !== binding.sourceFingerprint || snapshot.manifest.entry?.semanticsHash !== expectedSemanticsHash) errors.push({ code: 'context_sources_changed', path: 'entry' })
    if (field(state, 'provider-compaction') === 'succeeded' && (field(state, 'provider-compaction-event') !== event || snapshot.manifest.provider.eventRef !== event)) errors.push({ code: 'context_provider_event_mismatch', path: 'provider.eventRef' })
    if (['requested', 'running', 'failed'].includes(field(state, 'provider-compaction')) || ['requested', 'running', 'failed'].includes(snapshot.manifest.provider.status)) errors.push({ code: 'context_provider_pending', path: 'provider' })
  } catch { errors.push({ code: 'context_manifest_invalid', path: 'context-manifest' }) }
  let next = setField(setField(state, 'context-recovery-event', event), 'context-recovery-receipt', 'none')
  let receipt = null
  if (!errors.length) {
    const { manifest, checkpoint } = snapshot
    receipt = { schemaVersion: 1, event, taskId: binding.taskId, sessionId: binding.sessionId, repo: binding.repo, branch: binding.branch, commit: binding.commit, digest: manifest.digest, planDigest: hash(manifest.plan), ...contextReplay(checkpoint, manifest.plan) }
    const path = `.cap/context/recovery-${randomUUID()}.json`
    // readContained above verified the context directory's no-symlink chain.
    await writeFile(join(repo, path), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    next = setField(next, 'context-recovery-receipt', path)
  }
  const temporary = join(repo, '.cap', `.STATE-resume-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: 0o600 })
    if (await readContained(repo, '.cap/STATE.md') !== state) throw new Error('context_state_changed')
    await rename(temporary, join(repo, '.cap/STATE.md'))
  } finally { await rm(temporary, { force: true }) }
  return { valid: !errors.length, event, errors, recovery: receipt, nextAction: errors.length ? 'repair original sources and manifest, then replay the same event' : 'read hot atoms, resolve required warm sources, bind a new manifest and rerun the full context guard' }
}
