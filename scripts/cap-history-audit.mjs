#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { join, resolve, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseJson } from '../runtime/ontology/json.mjs'

const SCHEMA = 'cap-experience/v1'
const MAX_BYTES = 1024 * 1024

function fail(message) { process.stderr.write(`cap-history-audit: ${message}\n`); process.exitCode = 1 }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }
function safeRel(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false
  const p = posix.normalize(value)
  return p === value && !p.startsWith('/') && p !== '..' && !p.startsWith('../') && !p.includes('/../')
}
async function inside(root, path) {
  try { return (await realpath(path)) === root || (await realpath(path)).startsWith(`${root}/`) } catch { return false }
}
async function readSafe(root, rel) {
  if (!safeRel(rel)) return null
  const path = resolve(root, rel)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || !(await inside(root, path))) return null
    return { bytes: await readFile(path), rel }
  } catch { return null }
}
function issue(value) { return value }
function sensitive(text) {
  return /(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)\s*[:=]|(?:sk|ak)-[A-Za-z0-9_-]{12,}|\b10(?:\.\d{1,3}){3}\b|\b192\.168(?:\.\d{1,3}){2}\b|\/Users\/|\/home\/|\/private\//i.test(text)
}
function parseArgs(argv) {
  let repo = '.', json = false, limit = 100
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') repo = argv[++i] || ''
    else if (a === '--json') json = true
    else if (a === '--limit') { limit = Number(argv[++i]); if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer') }
    else throw new Error('invalid_arguments')
  }
  return { repo, json, limit }
}

export async function auditHistory({ repo = '.', limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_limit')
  const root = await realpath(resolve(repo))
  const indexRoot = join(root, '.cap/history/index')
  const names = []; let truncated = false
  try {
    const info = await lstat(indexRoot)
    if (info.isSymbolicLink() || !info.isDirectory() || !(await inside(root, indexRoot))) throw new Error('unsafe_index')
    const d = await opendir(indexRoot)
    let visited = 0
    try {
      while (true) {
        const e = await d.read(); if (!e) break
        if (++visited > limit) { truncated = true; break }
        if (e.name.endsWith('.json')) names.push(e.name)
      }
    } finally { await d.close() }
    names.sort()
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('index_unreadable')
    return { repo: '.', scanned: 0, truncated: false, candidates: [], counts: { pass: 0, 'needs-review': 0, fail: 0 } }
  }
  const candidates = []
  const hashes = new Map()
  for (const name of names) {
    const indexRel = `.cap/history/index/${name}`
    const item = { index: /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(name) ? indexRel : `invalid-index-${sha256(name).slice(0,12)}`, task_id: '', status: 'fail', issues: [] }
    const data = await readSafe(root, indexRel)
    if (!data) { item.issues.push(issue('unsafe_or_missing_index')); candidates.push(item); continue }
    let index
    try { index = parseJson(data.bytes.toString('utf8')) } catch { item.issues.push(issue('invalid_json')); candidates.push(item); continue }
    if (!index || typeof index !== 'object' || Array.isArray(index)) { item.issues.push('invalid_index'); candidates.push(item); continue }
    const rawTask = typeof index.taskId === 'string' ? index.taskId : (typeof index.task_id === 'string' ? index.task_id : '')
    item.task_id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(rawTask) ? rawTask : ''
    const schema = index.schemaVersion === 1 ? 'retire/v1' : (index.schema || index.experienceIndex?.schema || '')
    if (schema !== 'retire/v1') item.issues.push('unknown_schema')
    if (index.status !== 'completed') item.issues.push('invalid_retire_metadata')
    const task = item.task_id
    if (task && name !== `${task}.json`) item.issues.push('index_task_mismatch')
    if (!task || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(task)) item.issues.push('invalid_task_id')
    const target = index.experienceIndex?.path || index.experience_path || index.path || `.cap/history/${task}/experience.md`
    const expectedRoot = `.cap/history/${task}`
    if (!task || typeof target !== 'string' || !target.startsWith(`${expectedRoot}/`) || target.includes('..')) item.issues.push('index_path_mismatch')
    const manifestRel = `${expectedRoot}/manifest.json`
    const manifestData = await readSafe(root, manifestRel)
    if (!manifestData) item.issues.push('missing_manifest')
    let manifest = null
    if (manifestData) { try { manifest = parseJson(manifestData.bytes.toString('utf8')) } catch { item.issues.push('invalid_manifest') } }
    if (!manifest || manifest.schemaVersion !== 1 || manifest.status !== 'completed' || manifest.taskId !== task || !Array.isArray(manifest.artifacts)) item.issues.push('invalid_manifest_metadata')
    const exp = await readSafe(root, target)
    if (!exp) item.issues.push('missing_or_unsafe_experience')
    if (exp) {
      const text = exp.bytes.toString('utf8'); const h = sha256(exp.bytes); hashes.set(h, [...(hashes.get(h) || []), task])
      if (sensitive(text)) item.issues.push('sensitive_value')
      const foundSchema = text.match(/^schema:\s*([^\r\n]+)/mi)?.[1]?.trim() || ''
      if (foundSchema !== SCHEMA) item.issues.push(foundSchema ? 'unknown_schema' : 'missing_schema')
      const artifactName = target.startsWith(`${expectedRoot}/`) ? target.slice(expectedRoot.length + 1) : target
      const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts.filter(f => f?.path === artifactName) : []
      if (artifacts.length !== 1) item.issues.push('invalid_experience_artifact')
      const artifact = artifacts[0]
      if (!artifact?.sha256) item.issues.push('missing_experience_hash')
      else if (artifact.sha256 !== h) item.issues.push('hash_mismatch')
      if (artifact?.size !== exp.bytes.length) item.issues.push('size_mismatch')
    }
    if (item.issues.includes('unknown_schema')) item.status = 'needs-review'
    else if (item.issues.length === 0) item.status = 'pass'
    candidates.push(item)
  }
  for (const tasks of hashes.values()) if (tasks.length > 1) for (const item of candidates) if (tasks.includes(item.task_id)) item.issues.push('duplicate_content')
  const counts = { pass: 0, 'needs-review': 0, fail: 0 }
  const reviewIssues = new Set(['sensitive_value','duplicate_content','unknown_schema','missing_schema'])
  for (const item of candidates) {
    item.status = item.issues.some(x => !reviewIssues.has(x)) ? 'fail' : item.issues.length ? 'needs-review' : 'pass'
    counts[item.status]++
  }
  return { repo: '.', scanned: names.length, truncated, candidates, counts }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { const options = parseArgs(process.argv.slice(2)); const result = await auditHistory(options); process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `cap-history-audit: ${result.scanned} scanned; pass=${result.counts.pass} needs-review=${result.counts['needs-review']} fail=${result.counts.fail}\n`) }
  catch (error) { fail('audit_failed: check repository, index and arguments') }
}
