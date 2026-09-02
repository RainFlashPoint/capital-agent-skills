#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repo, ...args], { encoding, stdio: ['ignore', 'pipe', 'ignore'] })
}

function safeSegment(value = '') {
  const safe = String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) throw new Error('task_id_invalid')
  return safe
}

function comparablePath(value = '') {
  const normalized = String(value).replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function canonicalRepo(candidate = '.') {
  return realpath(String(git(resolve(candidate), ['rev-parse', '--show-toplevel'])).trim())
}

function parseStatus(raw = Buffer.alloc(0)) {
  const fields = raw.toString('utf8').split('\0')
  const rows = []
  for (let index = 0; index < fields.length; index += 1) {
    const row = fields[index]
    if (!row) continue
    let match = row.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s)
    if (match) rows.push({ status: match[1], path: match[2] })
    else if ((match = row.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s))) {
      rows.push({ status: match[1], path: match[2] })
      index += 1 // porcelain v2 emits the rename source as the next NUL field
    } else if ((match = row.match(/^\? (.*)$/s))) rows.push({ status: '??', path: match[1] })
  }
  return rows
    .filter(item => item.path && item.path !== '.cap' && !item.path.startsWith('.cap/'))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export async function inspectDirtyPaths(repoCandidate = '.') {
  const repo = await canonicalRepo(repoCandidate)
  const raw = git(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], 'buffer')
  return { repo, paths: parseStatus(raw) }
}

async function safeBaselineRoot(repo) {
  const capRoot = join(repo, '.cap')
  const localState = join(capRoot, 'local-state')
  const baselineRoot = join(localState, 'task-baselines')
  for (const path of [capRoot, localState, baselineRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('task_baseline_unsafe_directory')
  }
  const canonical = await realpath(baselineRoot)
  if (comparablePath(canonical) !== comparablePath(baselineRoot)) throw new Error('task_baseline_path_escape')
  return baselineRoot
}

export async function captureTaskBaseline(repoCandidate = '.', taskId = '') {
  const repo = await canonicalRepo(repoCandidate)
  const baselineRoot = await safeBaselineRoot(repo)
  const path = join(baselineRoot, `${safeSegment(taskId)}.json`)
  const existing = await readFile(path, 'utf8').then(JSON.parse).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing) {
    if (existing.schema !== 1 || existing.taskId !== taskId || comparablePath(existing.repo) !== comparablePath(repo) || !Array.isArray(existing.dirtyPaths)) {
      throw new Error('task_baseline_invalid')
    }
    return { path, payload: existing, created: false }
  }
  const { paths } = await inspectDirtyPaths(repo)
  const payload = {
    schema: 1,
    taskId,
    repo,
    branch: String(git(repo, ['branch', '--show-current'])).trim(),
    head: (() => { try { return String(git(repo, ['rev-parse', '--verify', 'HEAD'])).trim() } catch { return 'working-tree' } })(),
    capturedAt: new Date().toISOString(),
    dirtyPaths: paths,
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  let created = false
  try {
    await link(temporary, path)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
  if (!created) {
    const concurrent = await readFile(path, 'utf8').then(JSON.parse)
    if (concurrent.schema !== 1 || concurrent.taskId !== taskId || comparablePath(concurrent.repo) !== comparablePath(repo) || !Array.isArray(concurrent.dirtyPaths)) {
      throw new Error('task_baseline_invalid')
    }
    return { path, payload: concurrent, created: false }
  }
  return { path, payload, created: true }
}

function normalizePattern(value = '') {
  const pattern = String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!pattern || isAbsolute(pattern) || pattern === '..' || pattern.startsWith('../') || pattern.includes('/../')) return ''
  return pattern
}

function globRegex(pattern = '') {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') { source += '.*'; index += 1 }
    else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

export function plannedModifyPatterns(taskContext = '') {
  const body = String(taskContext)
  const start = body.search(/^## Impact surface\s*$/m)
  if (start < 0) return []
  const tail = body.slice(start).replace(/^## Impact surface\s*\r?\n?/, '')
  const next = tail.search(/^## /m)
  const section = next >= 0 ? tail.slice(0, next) : tail
  const raw = [...section.matchAll(/^- modify:\s*`([^`]+)`/gm)].map(match => match[1])
  const normalized = raw.map(normalizePattern)
  if (normalized.some((pattern, index) => !pattern && raw[index])) throw new Error('task_context_modify_pattern_invalid')
  return normalized.filter(Boolean)
}

export async function inspectPreexistingDirtyOverlap(repoCandidate = '.', taskId = '', taskContext = '') {
  const repo = await canonicalRepo(repoCandidate)
  const baselinePath = join(repo, '.cap', 'local-state', 'task-baselines', `${safeSegment(taskId)}.json`)
  const baseline = await readFile(baselinePath, 'utf8').then(JSON.parse).catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!baseline) return { checked: false, baselinePath, overlap: [], patterns: [] }
  if (baseline.schema !== 1 || baseline.taskId !== taskId || comparablePath(baseline.repo) !== comparablePath(repo) || !Array.isArray(baseline.dirtyPaths)) {
    throw new Error('task_baseline_invalid')
  }
  const patterns = plannedModifyPatterns(taskContext)
  const matchers = patterns.map(globRegex)
  const current = await inspectDirtyPaths(repo)
  const currentDirty = new Set(current.paths.map(item => item.path))
  const overlap = baseline.dirtyPaths
    .map(item => item.path)
    .filter(path => currentDirty.has(path) && matchers.some(matcher => matcher.test(path)))
  return { checked: true, baselinePath, patterns, overlap: [...new Set(overlap)].sort() }
}

export async function removeTaskBaseline(path = '') {
  if (path) await rm(path, { force: true })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [command = 'inspect', repo = '.', taskId = ''] = process.argv.slice(2)
  if (command === 'capture') {
    const result = await captureTaskBaseline(repo, taskId)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else if (command === 'check') {
    const context = await readFile(join(await canonicalRepo(repo), '.cap', 'task-context.md'), 'utf8')
    const result = await inspectPreexistingDirtyOverlap(repo, taskId, context)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.overlap.length) process.exitCode = 2
  } else throw new Error(`unknown command: ${command}`)
}
