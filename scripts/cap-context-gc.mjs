#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, rename, rmdir, lstat, readFile, rm, link } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_FILES = 4096
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const CONTEXT_DIR = '.cap/context'
const QUARANTINE_DIR = '.cap/local-state/garbage/context'
const PRUNE_LOG = '.cap/local-state/garbage/context-pruned.jsonl'
const STALE_DIR = '.cap/local-state/stale'

function gitRoot(candidate = '.') {
  return execFileSync('git', ['-C', resolve(candidate), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function stateField(text, key) {
  return String(text).match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'mi'))?.[1]?.trim() || ''
}

function contextPointer(value, field, allowBare = false) {
  if (!value || value === 'none') return ''
  const artifactName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
  if (allowBare && typeof value === 'string' && artifactName.test(value)) {
    return `${CONTEXT_DIR}/${value}`
  }
  const prefix = `${CONTEXT_DIR}/`
  if (typeof value !== 'string' || !value.startsWith(prefix)
    || !artifactName.test(value.slice(prefix.length))
    || (!allowBare && !value.endsWith('.json'))) {
    throw new Error(`context_gc_invalid_pointer:${field}`)
  }
  return value
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(repo, path) {
  const absolute = join(repo, path)
  const info = await lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`context_gc_invalid_file:${path}`)
  return JSON.parse(await readFile(absolute, 'utf8'))
}

function pointerFromValue(value, field, allowBare = false) {
  if (!value) return ''
  if (typeof value === 'object') value = value.path
  return contextPointer(String(value), field, allowBare)
}

function addContextPointer(retained, pointer, field, allowBare = false) {
  const normalized = pointerFromValue(pointer, field, allowBare)
  if (normalized) retained.add(normalized.slice(CONTEXT_DIR.length + 1))
  return normalized
}

async function retainManifest(repo, pointer, retained, visited, expectedSha256 = '') {
  if (!pointer) return
  if (expectedSha256 && hashBytes(await readFile(join(repo, pointer))) !== expectedSha256) {
    throw new Error(`context_gc_manifest_hash_mismatch:${pointer}`)
  }
  if (visited.has(pointer)) return
  visited.add(pointer)
  retained.add(pointer.slice(CONTEXT_DIR.length + 1))
  const manifest = await readJson(repo, pointer)
  addContextPointer(retained, manifest.checkpoint, `${pointer}.checkpoint`, true)
  addContextPointer(retained, manifest.previousCheckpoint, `${pointer}.previousCheckpoint`, true)
  addContextPointer(retained, manifest.atomLog, `${pointer}.atomLog`, true)
  const entry = manifest.entry || {}
  addContextPointer(retained, entry.recoveryReceipt, `${pointer}.entry.recoveryReceipt`, true)
  const predecessor = pointerFromValue(entry.previousManifest || manifest.previousManifest, `${pointer}.previousManifest`, true)
  if (predecessor && manifest.integrityVersion === 1 && !/^[a-f0-9]{64}$/.test(entry.previousManifestSha256 || '')) {
    throw new Error(`context_gc_predecessor_hash_missing:${pointer}`)
  }
  if (predecessor) await retainManifest(repo, predecessor, retained, visited, entry.previousManifestSha256)
  const anchor = addContextPointer(retained, manifest.lineageAnchor?.path, `${pointer}.lineageAnchor`)
  if (anchor) {
    if (hashBytes(await readFile(join(repo, anchor))) !== manifest.lineageAnchor.sha256) {
      throw new Error(`context_gc_lineage_anchor_hash_mismatch:${anchor}`)
    }
    const audit = await readJson(repo, anchor)
    if (!Array.isArray(audit.artifacts)) throw new Error(`context_gc_invalid_lineage_anchor:${anchor}`)
    for (const item of audit.artifacts) addContextPointer(retained, item?.path, `${anchor}.artifacts`, true)
  }
}

async function listContextFiles(repo) {
  const root = join(repo, CONTEXT_DIR)
  const result = []
  let totalBytes = 0
  try {
    for (const path of [join(repo, '.cap'), root]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`context_gc_unsupported_directory:${relative(repo, path)}`)
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (result.length >= MAX_FILES) throw new Error('context_gc_file_budget')
      const path = join(root, entry.name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`context_gc_unsupported_entry:${relative(repo, path)}`)
      totalBytes += info.size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('context_gc_byte_budget')
      result.push(path)
    }
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return result.sort()
}

/**
 * Build a conservative cleanup plan. A file referenced by any manifest is
 * historical evidence even when it is not in the current STATE lineage.
 */
export async function planContextGarbage(candidate = '.') {
  const repo = resolve(gitRoot(candidate))
  const statePath = join(repo, '.cap/STATE.md')
  const state = await readFile(statePath, 'utf8').catch(() => '')
  const taskId = stateField(state, 'task-id')
  const manifestPointer = contextPointer(stateField(state, 'context-manifest'), 'STATE.context-manifest')
  const files = await listContextFiles(repo)
  const current = new Set()
  const visited = new Set()
  if (manifestPointer) await retainManifest(repo, manifestPointer, current, visited)
  for (const [field, key] of [
    ['context-checkpoint', 'STATE.context-checkpoint'],
    ['context-recovery-receipt', 'STATE.context-recovery-receipt'],
    ['context-previous-manifest', 'STATE.context-previous-manifest'],
  ]) addContextPointer(current, stateField(state, field), key)
  const previousPointer = contextPointer(stateField(state, 'context-previous-manifest'), 'STATE.context-previous-manifest')
  if (previousPointer) await retainManifest(repo, previousPointer, current, visited)

  const retained = new Set(current)
  for (const file of files) {
    const name = basename(file)
    if (!name.endsWith('.json') || current.has(name)) continue
    const pointer = `${CONTEXT_DIR}/${name}`
    const value = await readJson(repo, pointer)
    const looksLikeManifest = typeof value?.checkpoint === 'string' && value.atomLog && value.entry
    if (looksLikeManifest) await retainManifest(repo, pointer, retained, visited)
    else if (/^manifest-[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error(`context_gc_invalid_manifest:${pointer}`)
  }
  const present = new Set(files.map(file => basename(file)))
  const liveFiles = new Map()
  for (const file of files) liveFiles.set(basename(file), { path: relative(repo, file).split('/').join('/'), sha256: hashBytes(await readFile(file)) })
  const staleLiveNames = await staleContextReferences(repo, liveFiles, { onlyDirectMatches: true })
  for (const name of staleLiveNames) retained.add(name)
  for (const name of retained) if (!present.has(name)) throw new Error(`context_gc_referenced_file_missing:${name}`)
  const expectedManifestSha = stateField(state, 'context-manifest-sha256')
  if (manifestPointer && expectedManifestSha && expectedManifestSha !== 'none') {
    const actual = hashBytes(await readFile(join(repo, manifestPointer)))
    if (actual !== expectedManifestSha) throw new Error('context_gc_active_manifest_hash_mismatch')
  }
  const candidates = []
  const retainedByHash = new Map()
  const inventory = []
  for (const file of files) {
    const name = relative(join(repo, CONTEXT_DIR), file).split('/').join('/')
    const bytes = await readFile(file)
    const sha256 = hashBytes(bytes)
    inventory.push({ name, size: bytes.length, sha256 })
    if (retained.has(name) && !retainedByHash.has(sha256)) retainedByHash.set(sha256, `${CONTEXT_DIR}/${name}`)
  }
  const seenByHash = new Map(retainedByHash)
  for (const { name, size, sha256 } of inventory) {
    const item = { path: `${CONTEXT_DIR}/${name}`, size, sha256 }
    if (retained.has(name)) {
      continue
    }
    if ((await lstat(join(repo, item.path))).nlink !== 1) throw new Error(`context_gc_hardlinked_candidate:${item.path}`)
    const duplicateOf = seenByHash.get(sha256) || ''
    candidates.push({
      ...item,
      reason: duplicateOf ? 'duplicate-unreferenced' : 'unreferenced-by-any-manifest',
      ...(duplicateOf ? { duplicateOf } : {}),
    })
    if (!duplicateOf) seenByHash.set(sha256, item.path)
  }
  const candidateBytes = candidates.reduce((sum, item) => sum + item.size, 0)
  const reviewForGit = [...retained].sort().map(name => `${CONTEXT_DIR}/${name}`)
  for (const path of ['.cap/STATE.md', '.cap/task-context.md', '.cap/spec.md', '.cap/plan.md']) {
    const info = await lstat(join(repo, path)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`context_gc_review_file_invalid:${path}`)
    if (info) reviewForGit.push(path)
  }
  reviewForGit.sort()
  const reviewForGitFiles = []
  for (const path of reviewForGit) {
    const bytes = await readFile(join(repo, path))
    reviewForGitFiles.push({ path, size: bytes.length, sha256: hashBytes(bytes) })
  }
  const uniqueCandidateHashes = new Set()
  let potentialDeduplicatedBytes = 0
  for (const item of candidates) {
    if (uniqueCandidateHashes.has(item.sha256)) potentialDeduplicatedBytes += item.size
    else uniqueCandidateHashes.add(item.sha256)
  }
  return {
    schemaVersion: 1,
    repo,
    taskId,
    stateSha256: hashBytes(Buffer.from(state)),
    inventorySha256: hashBytes(Buffer.from(JSON.stringify(inventory))),
    activeManifest: manifestPointer || 'none',
    currentFiles: [...current].sort().map(name => `${CONTEXT_DIR}/${name}`),
    historicalFiles: [...retained].filter(name => !current.has(name)).sort().map(name => `${CONTEXT_DIR}/${name}`),
    retainedFiles: [...retained].sort().map(name => `${CONTEXT_DIR}/${name}`),
    reviewForGit,
    reviewForGitFiles,
    candidates,
    candidateCount: candidates.length,
    candidateBytes,
    potentialDeduplicatedBytes,
    safeToApply: Boolean(manifestPointer && taskId),
    applyMode: 'quarantine-only',
  }
}

/** Quarantine is recoverable only until its exact inventory is reviewed for pruning. */
export async function planQuarantinePrune(candidate = '.') {
  const repo = resolve(gitRoot(candidate))
  const context = await planContextGarbage(repo)
  if (!context.safeToApply) throw new Error('context_gc_active_manifest_missing')
  const root = join(repo, QUARANTINE_DIR)
  for (const path of ['.cap/local-state', '.cap/local-state/garbage', QUARANTINE_DIR]) {
    const info = await lstat(join(repo, path)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) break
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`context_gc_unsupported_directory:${path}`)
  }
  const batches = []
  let totalFiles = 0
  let totalBytes = 0
  for (const batch of await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!batch.isDirectory() || batch.isSymbolicLink() || !/^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f-]{36}$/.test(batch.name)) throw new Error(`context_gc_invalid_quarantine_batch:${batch.name}`)
    const directory = join(root, batch.name)
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(entry.name)) throw new Error(`context_gc_invalid_quarantine_file:${batch.name}/${entry.name}`)
      const path = join(directory, entry.name)
      const bytes = await readFile(path)
      totalFiles += 1
      totalBytes += bytes.length
      if (totalFiles > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new Error('context_gc_quarantine_budget')
      files.push({ path: `${QUARANTINE_DIR}/${batch.name}/${entry.name}`, size: bytes.length, sha256: hashBytes(bytes) })
    }
    batches.push({ name: batch.name, files: files.sort((a, b) => a.path.localeCompare(b.path)) })
  }
  batches.sort((a, b) => a.name.localeCompare(b.name))
  const quarantined = new Map()
  for (const batch of batches) for (const file of batch.files) {
    const name = basename(file.path)
    if (quarantined.has(name)) throw new Error(`context_gc_ambiguous_quarantine_name:${name}`)
    quarantined.set(name, file)
  }
  for (const path of context.retainedFiles) {
    const file = quarantined.get(basename(path))
    if (file) throw new Error(`context_gc_quarantined_live_reference:${file.path}`)
  }
  const protectedNames = await staleContextReferences(repo, quarantined)
  const restoreFiles = [...protectedNames].sort().map(name => quarantined.get(name))
  const pruneBatches = batches.map(batch => ({ name: batch.name, files: batch.files.filter(file => !protectedNames.has(basename(file.path))) }))
    .filter(batch => batch.files.length)
  const inventory = { stateSha256: context.stateSha256, inventorySha256: context.inventorySha256, retainedFiles: context.retainedFiles, reviewForGitFiles: context.reviewForGitFiles, batches, restoreFiles, pruneBatches }
  return {
    schemaVersion: 1, repo, taskId: context.taskId,
    planSha256: hashBytes(Buffer.from(JSON.stringify(inventory))),
    batchCount: batches.length, fileCount: totalFiles, bytes: totalBytes, batches,
    restoreFiles, restoreCount: restoreFiles.length,
    pruneBatches, pruneCount: pruneBatches.reduce((n, batch) => n + batch.files.length, 0),
    safeToPrune: restoreFiles.length === 0,
    reviewForGit: context.reviewForGit, reviewForGitFiles: context.reviewForGitFiles,
    applyMode: 'exact-plan-prune',
  }
}

/** A stale Task can still own a chain that an older GC incorrectly quarantined. */
async function staleContextReferences(repo, quarantined, { onlyDirectMatches = false } = {}) {
  if (!quarantined.size) return new Set()
  const staleRoot = join(repo, STALE_DIR)
  const rootInfo = await lstat(staleRoot).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!rootInfo) return new Set()
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('context_gc_invalid_stale_root')
  const protectedNames = new Set()
  const visited = new Set()
  const visiting = new Set()
  const artifact = async (name, snapshot) => {
    const file = quarantined.get(name)
    if (file) protectedNames.add(name)
    const local = join(snapshot, 'context', name)
    const live = join(repo, CONTEXT_DIR, name)
    for (const path of [local, live, ...(file ? [join(repo, file.path)] : [])]) {
      const info = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (info) {
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`context_gc_invalid_stale_artifact:${name}`)
        const bytes = await readFile(path)
        if (file && hashBytes(bytes) !== file.sha256) throw new Error(`context_gc_stale_artifact_conflict:${name}`)
        return { path, bytes }
      }
    }
    throw new Error(`context_gc_stale_reference_missing:${name}`)
  }
  const followManifest = async (pointer, snapshot, expectedHash = '') => {
    if (!pointer) return
    const name = basename(pointer)
    const item = await artifact(name, snapshot)
    if (expectedHash && hashBytes(item.bytes) !== expectedHash) throw new Error(`context_gc_stale_manifest_hash_mismatch:${name}`)
    if (visiting.has(item.path)) throw new Error(`context_gc_stale_manifest_cycle:${name}`)
    if (visited.has(item.path)) return
    visiting.add(item.path)
    visited.add(item.path)
    if (visited.size > MAX_FILES) throw new Error('context_gc_stale_reference_budget')
    let manifest
    try { manifest = JSON.parse(item.bytes.toString('utf8')) } catch { throw new Error(`context_gc_invalid_stale_manifest:${name}`) }
    if (!manifest || typeof manifest !== 'object' || typeof manifest.checkpoint !== 'string' || !manifest.atomLog || !manifest.entry) throw new Error(`context_gc_invalid_stale_manifest:${name}`)
    for (const [value, field] of [[manifest.checkpoint, 'checkpoint'], [manifest.previousCheckpoint, 'previousCheckpoint'], [manifest.atomLog, 'atomLog'], [manifest.entry.recoveryReceipt, 'recoveryReceipt']]) {
      const ref = pointerFromValue(value, `${name}.${field}`, true)
      if (ref) {
        const target = await artifact(basename(ref), snapshot)
        if (value && typeof value === 'object' && value.sha256 && hashBytes(target.bytes) !== value.sha256) {
          throw new Error(`context_gc_stale_artifact_hash_mismatch:${basename(ref)}`)
        }
      }
    }
    const predecessor = pointerFromValue(manifest.entry.previousManifest || manifest.previousManifest, `${name}.previousManifest`, true)
    if (predecessor) {
      const sha = manifest.entry.previousManifestSha256 || ''
      if (manifest.integrityVersion === 1 && !/^[a-f0-9]{64}$/.test(sha)) throw new Error(`context_gc_stale_predecessor_hash_missing:${name}`)
      await followManifest(predecessor, snapshot, sha)
    }
    const anchor = pointerFromValue(manifest.lineageAnchor?.path, `${name}.lineageAnchor`)
    if (anchor) {
      const audit = await artifact(basename(anchor), snapshot)
      if (hashBytes(audit.bytes) !== manifest.lineageAnchor.sha256) throw new Error(`context_gc_stale_lineage_hash_mismatch:${name}`)
      let data
      try { data = JSON.parse(audit.bytes.toString('utf8')) } catch { throw new Error(`context_gc_invalid_stale_lineage:${name}`) }
      if (!Array.isArray(data.artifacts)) throw new Error(`context_gc_invalid_stale_lineage:${name}`)
      for (const value of data.artifacts) {
        const ref = pointerFromValue(value, `${name}.lineageArtifact`, true)
        if (ref) {
          const target = await artifact(basename(ref), snapshot)
          if (value.sha256 && hashBytes(target.bytes) !== value.sha256) throw new Error(`context_gc_stale_artifact_hash_mismatch:${basename(ref)}`)
        }
      }
    }
    visiting.delete(item.path)
  }
  const tasks = await readdir(staleRoot, { withFileTypes: true })
  if (tasks.length > MAX_FILES) throw new Error('context_gc_stale_reference_budget')
  for (const task of tasks) {
    if (!task.isDirectory() || task.isSymbolicLink()) throw new Error(`context_gc_invalid_stale_task:${task.name}`)
    const taskRoot = join(staleRoot, task.name)
    const snapshots = await readdir(taskRoot, { withFileTypes: true })
    if (snapshots.length > MAX_FILES) throw new Error('context_gc_stale_reference_budget')
    for (const entry of snapshots) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`context_gc_invalid_stale_snapshot:${task.name}/${entry.name}`)
      const snapshot = join(taskRoot, entry.name)
      const statePath = join(snapshot, 'STATE.md')
      const info = await lstat(statePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!info) continue
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`context_gc_invalid_stale_state:${task.name}/${entry.name}`)
      const state = await readFile(statePath, 'utf8')
      const manifest = contextPointer(stateField(state, 'context-manifest'), 'stale.STATE.context-manifest')
      if (onlyDirectMatches) {
        const direct = [manifest, ...['context-checkpoint', 'context-recovery-receipt', 'context-previous-manifest']
          .map(field => contextPointer(stateField(state, field), `stale.STATE.${field}`))].filter(Boolean)
        if (!direct.some(ref => quarantined.has(basename(ref)))) continue
      }
      for (const field of ['context-checkpoint', 'context-recovery-receipt', 'context-previous-manifest']) {
        const ref = contextPointer(stateField(state, field), `stale.STATE.${field}`)
        if (ref) await artifact(basename(ref), snapshot)
      }
      if (manifest) await followManifest(manifest, snapshot, stateField(state, 'context-manifest-sha256'))
      const previous = contextPointer(stateField(state, 'context-previous-manifest'), 'stale.STATE.context-previous-manifest')
      if (previous) await followManifest(previous, snapshot)
    }
  }
  return protectedNames
}

/** Prune only a reviewed plan, after checking all current and historical roots again. */
export async function applyQuarantinePrune(candidate = '.', planSha256 = '') {
  if (!/^[a-f0-9]{64}$/.test(planSha256)) throw new Error('context_gc_prune_plan_required')
  const repo = resolve(gitRoot(candidate))
  const lockPath = join(repo, '.cap/.context-gc.lock')
  const prepareLockPath = join(repo, '.cap/.context-prepare.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  let prepareLock
  try {
    prepareLock = await open(prepareLockPath, 'wx', 0o600)
    const plan = await planQuarantinePrune(repo)
    if (plan.planSha256 !== planSha256) throw new Error('context_gc_prune_plan_changed')
    if (!plan.safeToPrune) throw new Error('context_gc_restore_referenced_quarantine_first')
    const logPath = join(repo, PRUNE_LOG)
    const logInfo = await lstat(logPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (logInfo && (!logInfo.isFile() || logInfo.isSymbolicLink())) throw new Error('context_gc_prune_log_invalid')
    let removed = 0
    for (const batch of plan.pruneBatches) {
      for (const file of batch.files) {
        const absolute = join(repo, file.path)
        const info = await lstat(absolute)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || hashBytes(await readFile(absolute)) !== file.sha256) throw new Error(`context_gc_prune_source_changed:${file.path}`)
        const record = { taskId: plan.taskId, planSha256, path: file.path, sha256: file.sha256 }
        await appendFile(logPath, `${JSON.stringify({ ...record, status: 'planned' })}\n`, { mode: 0o600 })
        await rm(absolute)
        await appendFile(logPath, `${JSON.stringify({ ...record, status: 'removed' })}\n`, { mode: 0o600 })
        removed += 1
      }
      await rmdir(join(repo, QUARANTINE_DIR, batch.name))
    }
    return { valid: true, planSha256, removed, reviewForGit: plan.reviewForGit, log: removed ? PRUNE_LOG : '' }
  } finally {
    await prepareLock?.close().catch(() => {})
    if (prepareLock) await rm(prepareLockPath, { force: true }).catch(() => {})
    await lock.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

/** Move candidates to ignored local garbage storage; never delete them. */
export async function applyContextGarbage(candidate = '.', plan = null) {
  const repo = resolve(gitRoot(candidate))
  const current = plan || await planContextGarbage(repo)
  if (!current.safeToApply) throw new Error('context_gc_active_manifest_missing')
  const lockPath = join(repo, '.cap/.context-gc.lock')
  const prepareLockPath = join(repo, '.cap/.context-prepare.lock')
  let lock, prepareLock
  let acquired = false
  try {
    lock = await open(lockPath, 'wx', 0o600)
    acquired = true
    prepareLock = await open(prepareLockPath, 'wx', 0o600)
    const fresh = await planContextGarbage(repo)
    const signature = value => JSON.stringify({ repo: value.repo, taskId: value.taskId, stateSha256: value.stateSha256, inventorySha256: value.inventorySha256, activeManifest: value.activeManifest, retainedFiles: value.retainedFiles, candidates: value.candidates })
    if (signature(fresh) !== signature(current)) throw new Error('context_gc_plan_changed')
    if (current.candidates.length === 0) return { ...current, applied: true, quarantineRoot: '', moved: [] }
    for (const path of ['.cap/local-state', '.cap/local-state/garbage', '.cap/local-state/garbage/context']) {
      let info
      try { info = await lstat(join(repo, path)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`context_gc_unsupported_directory:${path}`)
    }
    const label = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    const destinationRoot = join(repo, '.cap/local-state/garbage/context', label)
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 })
    const moved = []
    const quarantinedByHash = new Map()
    let deduplicatedBytes = 0
    for (const item of current.candidates) {
      if (hashBytes(Buffer.from(await readFile(join(repo, '.cap/STATE.md'), 'utf8'))) !== current.stateSha256) throw new Error('context_gc_state_changed')
      const source = join(repo, item.path)
      const info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`context_gc_source_changed:${item.path}`)
      const bytes = await readFile(source)
      if (hashBytes(bytes) !== item.sha256 || bytes.length !== item.size) throw new Error(`context_gc_source_changed:${item.path}`)
      const destination = join(destinationRoot, basename(item.path))
      const canonical = quarantinedByHash.get(item.sha256)
      if (canonical) {
        await link(canonical, destination)
        await rm(source)
        deduplicatedBytes += item.size
      } else {
        await rename(source, destination)
        quarantinedByHash.set(item.sha256, destination)
      }
      moved.push({ ...item, quarantinedPath: relative(repo, destination).split('/').join('/') })
    }
    return { ...current, applied: true, quarantineRoot: relative(repo, destinationRoot).split('/').join('/'), moved, deduplicatedBytes }
  } finally {
    await prepareLock?.close().catch(() => {})
    if (prepareLock) await rm(prepareLockPath, { force: true }).catch(() => {})
    await lock?.close().catch(() => {})
    if (acquired) await rm(lockPath, { force: true }).catch(() => {})
  }
}

async function main(argv = process.argv.slice(2)) {
  const digestIndex = argv.indexOf('--plan-sha256')
  const positional = argv.filter((value, index) => !value.startsWith('-') && (digestIndex < 0 || index !== digestIndex + 1))
  const repo = positional[0] || '.'
  const apply = argv.includes('--apply')
  const json = argv.includes('--json')
  const prune = argv.includes('--prune')
  const result = prune
    ? apply ? await applyQuarantinePrune(repo, digestIndex >= 0 ? argv[digestIndex + 1] : '') : await planQuarantinePrune(repo)
    : apply ? await applyContextGarbage(repo) : await planContextGarbage(repo)
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ valid: false, code: error.message })}\n`)
    process.exitCode = 1
  })
}
