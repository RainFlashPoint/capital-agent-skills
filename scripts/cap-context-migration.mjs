// Explicit compatibility recovery. Historical evidence remains unverified;
// only the reviewed current checkpoint can become a new executable root.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertContextArtifactPointer, readContained, manifestContentSha256, validateRecoveryReceipt } from './cap-context-gate.mjs'
import { checkpointDigest, validateManifest, validateCheckpointTransition } from './cap-context-checkpoint.mjs'

const MAX_NODES = 512
const MAX_AUDIT_BYTES = 64 * 1024 * 1024
const field = (text, key) => text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const reject = code => { throw new Error(code) }
const artifact = name => `.cap/context/${name}`
const legacy = manifest => manifest.integrityVersion === undefined

export async function auditLegacyPredecessor(repo, { reviewPath, binding }) {
  assertContextArtifactPointer(repo, reviewPath)
  const inventory = new Map()
  const budget = { remaining: MAX_AUDIT_BYTES }
  const remember = async path => {
    assertContextArtifactPointer(repo, path)
    if (!inventory.has(path)) {
      const text = await readContained(repo, path, budget)
      inventory.set(path, { path, sha256: manifestContentSha256(text) })
      return text
    }
    const text = await readContained(repo, path)
    if (manifestContentSha256(text) !== inventory.get(path).sha256) reject('context_migration_inputs_changed')
    return text
  }
  const review = await remember(reviewPath)
  if (review.trim().length < 40) reject('context_migration_review_required')
  const state = await readContained(repo, '.cap/STATE.md')
  const headPath = field(state, 'context-manifest')
  let pointer = headPath, latest = null, child = null
  const visited = new Set(), issues = []
  while (pointer !== 'none') {
    if (visited.has(pointer)) reject('published_manifest_chain_cycle')
    if (visited.size >= MAX_NODES) reject('context_migration_read_budget')
    visited.add(pointer)
    const text = await remember(pointer)
    const manifest = JSON.parse(text)
    // This recovery cannot turn failed modern integrity into legacy evidence.
    if (!legacy(manifest)) reject('context_migration_requires_legacy_chain')
    const checkpointPath = artifact(manifest.checkpoint)
    const checkpoint = JSON.parse(await remember(checkpointPath))
    const previous = manifest.previousCheckpoint ? JSON.parse(await remember(artifact(manifest.previousCheckpoint))) : null
    const atomLogContent = await remember(artifact(manifest.atomLog?.path))
    const sourceContents = {}
    // Hash declarations are retained in the sealed manifest. Historical live
    // sources cannot prove old bytes, and need not still exist after a rename.
    for (const source of manifest.sources || []) {
      if (typeof source.path !== 'string' || source.path.startsWith('/') || source.path.split(/[\\/]/).includes('..')) reject('context_migration_source_path_invalid')
      sourceContents[source.path] = ''
    }
    const checked = validateManifest(manifest, { checkpoint, previous, atomLogContent, sourceContents, allowSourceDrift: true })
    if (!checked.valid) reject(`context_migration_snapshot_invalid:${checked.errors[0].code}`)
    const entry = manifest.entry
    if (!entry || entry.schemaVersion !== 1) reject('published_manifest_entry_invalid')
    for (const key of ['taskId', 'repo', 'branch', 'commit', 'stage']) if (entry[key] !== checkpoint.identity?.[key]) reject('context_migration_identity_invalid')
    for (const key of ['taskId', 'repo', 'branch']) if (entry[key] !== binding[key]) reject('context_migration_identity_invalid')
    if (entry.sessionId !== binding.sessionId) reject('published_manifest_session_mismatch')
    if (child) {
      if (child.entry.previousDigest !== manifest.digest) reject('context_migration_predecessor_invalid')
      if (child.entry.previousManifestSha256 && child.entry.previousManifestSha256 !== manifestContentSha256(text)) reject('published_manifest_sha256_mismatch')
      if (child.previousDigest !== null) {
        if (child.previousDigest !== manifest.digest || child.previousCheckpoint !== manifest.checkpoint) reject('context_migration_chain_split')
      } else if (child.digest !== manifest.digest || child.checkpoint !== manifest.checkpoint) reject('context_migration_chain_split')
    } else {
      if (field(state, 'context-checkpoint') !== checkpointPath || field(state, 'context-checkpoint-digest') !== manifest.digest) reject('context_migration_published_binding_invalid')
      const sha = field(state, 'context-manifest-sha256')
      if (sha && sha !== 'none' && sha !== manifestContentSha256(text)) reject('published_manifest_sha256_mismatch')
      latest = { path: checkpointPath, digest: manifest.digest, checkpoint }
    }
    if (entry.recoveryEvent && entry.recoveryEvent !== 'none') {
      let valid = false
      try {
        if (entry.recoveryReceipt && entry.recoveryReceipt !== 'none') {
          const receipt = JSON.parse(await remember(entry.recoveryReceipt))
          valid = validateRecoveryReceipt(receipt, manifest, checkpoint, entry)
        }
      } catch (cause) {
        // Missing old receipts are evidence gaps; path and IO errors are not.
        if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause
      }
      if (!valid) issues.push({ manifest: pointer, code: 'published_recovery_receipt_invalid', status: 'unverified' })
    }
    issues.push({ manifest: pointer, code: 'historical_source_bytes_unavailable', status: 'unverified' })
    if (entry.previousManifest === 'none' && (entry.previousDigest !== null || entry.previousManifestSha256)) reject('context_migration_predecessor_invalid')
    child = manifest
    pointer = entry.previousManifest
  }
  if (!latest) reject('context_migration_predecessor_missing')
  const audit = { schemaVersion: 1, kind: 'legacy-context-lineage', historicalEvidence: 'unverified', taskId: binding.taskId, sessionId: binding.sessionId, repo: binding.repo, branch: binding.branch, headManifest: headPath, previousCheckpoint: latest.path, previousDigest: latest.digest, reviewPath, nodeCount: visited.size, artifacts: [...inventory.values()].sort((a, b) => a.path.localeCompare(b.path)), issues }
  const text = `${JSON.stringify(audit, null, 2)}\n`
  if (Buffer.byteLength(text) > 1024 * 1024) reject('context_migration_read_budget')
  const path = `.cap/context/lineage-${randomUUID()}.json`
  await writeFile(join(repo, path), text, { flag: 'wx', mode: 0o600 })
  return { ...latest, lineageAnchor: { path, sha256: manifestContentSha256(text) } }
}

export async function validateLineageAnchor(repo, anchor, checkpoint, binding) {
  try {
    assertContextArtifactPointer(repo, anchor?.path)
    const text = await readContained(repo, anchor.path)
    if (!/^[a-f0-9]{64}$/.test(anchor.sha256 || '') || manifestContentSha256(text) !== anchor.sha256) return false
    const audit = JSON.parse(text)
    if (audit.schemaVersion !== 1 || audit.kind !== 'legacy-context-lineage' || audit.historicalEvidence !== 'unverified' || !Number.isInteger(audit.nodeCount) || audit.nodeCount < 1 || audit.nodeCount > MAX_NODES) return false
    if (!['taskId', 'sessionId', 'repo', 'branch'].every(key => audit[key] === binding[key])) return false
    if (!Array.isArray(audit.artifacts) || audit.artifacts.length > MAX_NODES * 5 + 1) return false
    const budget = { remaining: MAX_AUDIT_BYTES }, paths = new Set()
    let previous
    for (const item of audit.artifacts) {
      assertContextArtifactPointer(repo, item.path)
      if (paths.has(item.path)) return false
      paths.add(item.path)
      const content = await readContained(repo, item.path, budget)
      if (manifestContentSha256(content) !== item.sha256) return false
      if (item.path === audit.previousCheckpoint) previous = JSON.parse(content)
    }
    if (!paths.has(audit.reviewPath) || !paths.has(audit.headManifest) || !previous || checkpointDigest(previous) !== audit.previousDigest) return false
    return validateCheckpointTransition(previous, checkpoint).valid
  } catch { return false }
}
