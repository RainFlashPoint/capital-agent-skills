import { createHash } from 'node:crypto'
import { readContained, assertContextArtifactPointer, captureContextBindingDetails, loadContextManifest, validatePublishedSnapshotIntegrity, validateRecoveryReceipt } from './cap-context-gate.mjs'
import { manifestSourceHash, TASK_CONTEXT_PROJECTION } from './cap-context-checkpoint.mjs'

const field = (text, key) => text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const sha256 = text => createHash('sha256').update(text).digest('hex')
const PAGE_BYTES = 4096

export function recoveryPages(content) {
  const pages = []
  let page = '', bytes = 0
  for (const character of content) {
    const size = Buffer.byteLength(character)
    if (bytes + size > PAGE_BYTES) { pages.push(page); page = ''; bytes = 0 }
    page += character
    bytes += size
  }
  if (page || !pages.length) pages.push(page)
  return pages
}

export function recoverySummary(receipt, path) {
  const content = JSON.stringify(receipt)
  return { event: receipt.event, digest: receipt.digest, path, sha256: sha256(content), bytes: Buffer.byteLength(content), pageCount: recoveryPages(content).length, hotCount: receipt.hot.length, warmRefCount: receipt.warmRefs.length }
}

export async function projectRecoveryOutput(repo, result) {
  if (!result.valid || !result.recovery) return result
  const state = await readContained(repo, '.cap/STATE.md')
  if (['requested', 'running', 'failed'].includes(field(state, 'provider-compaction'))) throw new Error('recovery_provider_pending')
  const path = field(state, 'context-recovery-receipt')
  assertContextArtifactPointer(repo, path, 'recovery_receipt_path_invalid')
  const content = await readContained(repo, path)
  if (content !== `${JSON.stringify(result.recovery, null, 2)}\n`) throw new Error('recovery_receipt_changed')
  if (result.recoveryReused) return { ...result, outputMode: 'compact', recovery: null, recoveryPages: recoverySummary(result.recovery, path), nextAction: 'Previously replayed receipt reused; read saved pages only if this runtime has not consumed them, then rerun the stage guard.' }
  return { ...result, outputMode: 'recovery-paged', recovery: recoverySummary(result.recovery, path), nextAction: 'Read every recovery page separately with --sha256 set to recovery.sha256; do not print the reassembled receipt. Review all hot atoms and needed warm references, then bind the manifest and rerun the stage guard.' }
}

export async function readRecoveryPage(repo, { event, digest, page, sha256: expectedSha256, environment = process.env }) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('recovery_sha256_required')
  const { inspectBoundary } = await import('./cap-runtime.mjs')
  repo = (await inspectBoundary(repo, { environment })).repo
  const state = await readContained(repo, '.cap/STATE.md')
  if (['requested', 'running', 'failed'].includes(field(state, 'provider-compaction'))) throw new Error('recovery_provider_pending')
  const path = field(state, 'context-recovery-receipt')
  assertContextArtifactPointer(repo, path, 'recovery_receipt_path_invalid')
  const { binding, legacySemanticsHash } = await captureContextBindingDetails(repo, { environment })
  const manifestPath = field(state, 'context-manifest')
  const snapshot = await loadContextManifest(repo, manifestPath)
  const integrity = await validatePublishedSnapshotIntegrity(repo, snapshot, binding, { expectedManifestSha256: field(state, 'context-manifest-sha256'), allowSourceDrift: true, manifestPath })
  if (!integrity.valid) throw new Error('recovery_snapshot_invalid')
  if (['taskId', 'sessionId', 'repo', 'branch', 'commit', 'stage'].some(key => snapshot.manifest.entry?.[key] !== binding[key])) throw new Error('recovery_identity_changed')
  const boundRuntime = snapshot.manifest.entry.runtimeSessionId
  if (boundRuntime && boundRuntime !== 'none' && boundRuntime !== binding.runtimeSessionId) throw new Error('recovery_identity_changed')
  if (field(state, 'provider-compaction') === 'succeeded' && (field(state, 'provider-compaction-event') !== event || snapshot.manifest.provider.eventRef !== event)) throw new Error('recovery_provider_event_mismatch')
  const expectedSemanticsHash = snapshot.manifest.entry.semanticsProjection === TASK_CONTEXT_PROJECTION ? binding.semanticsHash : legacySemanticsHash
  if (snapshot.manifest.entry.sourceFingerprint !== binding.sourceFingerprint || snapshot.manifest.entry.semanticsHash !== expectedSemanticsHash) throw new Error('recovery_sources_changed')
  for (const source of snapshot.manifest.sources || []) {
    if (source.path === '.cap/STATE.md') continue // Recovery cursors change after the manifest was published.
    if (manifestSourceHash(source, await readContained(repo, source.path)) !== source.sha256) throw new Error('recovery_sources_changed')
  }
  const content = await readContained(repo, path)
  const receipt = JSON.parse(content)
  if (binding.recoveryEvent !== event || !validateRecoveryReceipt(receipt, snapshot.manifest, snapshot.checkpoint, binding)) throw new Error('recovery_receipt_invalid')
  if (event !== receipt.event) throw new Error('recovery_event_mismatch')
  if (digest !== receipt.digest) throw new Error('recovery_digest_mismatch')
  const replay = JSON.stringify(receipt)
  if (expectedSha256 !== sha256(replay)) throw new Error('recovery_sha256_mismatch')
  const pages = recoveryPages(replay)
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) throw new Error('recovery_page_invalid')
  return { valid: true, event, digest, path, page, pageCount: pages.length, pageSha256: sha256(pages[page - 1]), sha256: sha256(replay), content: pages[page - 1] }
}
