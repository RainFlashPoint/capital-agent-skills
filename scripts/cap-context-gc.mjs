#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, lstat, readFile, rm, link } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_FILES = 4096
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const CONTEXT_DIR = '.cap/context'

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
    candidates,
    candidateCount: candidates.length,
    candidateBytes,
    potentialDeduplicatedBytes,
    safeToApply: Boolean(manifestPointer && taskId),
    applyMode: 'quarantine-only',
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
  const repo = argv.find(value => !value.startsWith('-')) || '.'
  const apply = argv.includes('--apply')
  const json = argv.includes('--json')
  const result = apply ? await applyContextGarbage(repo) : await planContextGarbage(repo)
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ valid: false, code: error.message })}\n`)
    process.exitCode = 1
  })
}
