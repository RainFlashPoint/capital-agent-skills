#!/usr/bin/env node

import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OUTBOX_TYPES = new Set(['task.attach', 'artifact.record', 'delivery.record', 'action.create:test', 'action.create:review', 'experience.record', 'skill.event'])
const text = (value, max = 4000) => String(value ?? '').trim().slice(0, max)
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function containedBy(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function resolveOutboxPaths(repoRoot = '.') {
  const repo = await realpath(resolve(repoRoot)).catch(() => { throw new Error('outbox_repo_not_found') })
  const cap = join(repo, '.cap')
  const before = await lstat(cap).catch(() => null)
  if (before?.isSymbolicLink()) throw new Error('outbox_symlink_not_allowed:.cap')
  await mkdir(cap, { recursive: true, mode: 0o700 })
  const canonicalCap = await realpath(cap)
  if (!containedBy(repo, canonicalCap)) throw new Error('outbox_path_not_contained:.cap')
  const path = join(canonicalCap, 'outbox.jsonl')
  const current = await lstat(path).catch(() => null)
  if (current?.isSymbolicLink()) throw new Error('outbox_symlink_not_allowed:outbox.jsonl')
  return { repo, cap: canonicalCap, path, lock: join(canonicalCap, '.outbox.lock') }
}

function stableKey(input = {}) {
  const explicit = text(input.idempotencyKey || input.idempotency_key, 500)
  if (explicit) return explicit
  const digest = createHash('sha256').update(JSON.stringify({ type: input.type, localTaskRef: input.localTaskRef || input.local_task_ref || '', payload: input.payload || {} })).digest('hex').slice(0, 24)
  return `cap-outbox:${input.type}:${digest}`
}

function normalizeEvent(input = {}, now = new Date().toISOString()) {
  const type = text(input.type, 100)
  if (!OUTBOX_TYPES.has(type)) throw new Error(`unsupported_outbox_type:${type || 'empty'}`)
  const idempotencyKey = stableKey(input)
  const rawPayload = input.payload && typeof input.payload === 'object' ? input.payload : {}
  const payload = type === 'experience.record'
    ? { ...rawPayload, idempotency_key: idempotencyKey }
    : rawPayload
  return {
    id: text(input.id, 200) || `evt_${randomUUID()}`,
    idempotencyKey,
    type,
    localTaskRef: text(input.localTaskRef || input.local_task_ref, 300),
    dependsOn: [...new Set((Array.isArray(input.dependsOn) ? input.dependsOn : []).map(item => text(item, 200)).filter(Boolean))],
    payload,
    createdAt: text(input.createdAt, 100) || now,
    attempt: Math.max(0, Number(input.attempt) || 0),
    lastAttemptAt: text(input.lastAttemptAt, 100),
    lastError: text(input.lastError, 1000),
  }
}

async function acquireLock(paths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await mkdir(paths.lock, { mode: 0o700 })
      const owner = await open(join(paths.lock, 'owner.json'), 'wx', 0o600)
      await owner.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
      await owner.close()
      return async () => rm(paths.lock, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const lockStat = await stat(paths.lock).catch(() => null)
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await rm(paths.lock, { recursive: true, force: true }).catch(() => {})
        continue
      }
      await delay(10 + Math.floor(Math.random() * 20))
    }
  }
  throw new Error('outbox_lock_timeout')
}

async function writeEvents(paths, rows) {
  const temp = `${paths.path}.${process.pid}.${randomUUID()}.tmp`
  const body = rows.map(item => JSON.stringify(item)).join('\n') + (rows.length ? '\n' : '')
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, paths.path)
    const directory = await open(dirname(paths.path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function readOutboxUnlocked(paths) {
  const raw = await readFile(paths.path, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error))
  const rows = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line) continue
    try { rows.push(normalizeEvent(JSON.parse(line))) } catch { throw new Error(`outbox_corrupt_line:${index + 1}`) }
  }
  return rows
}

export async function readOutbox(repoRoot = '.') {
  return readOutboxUnlocked(await resolveOutboxPaths(repoRoot))
}

export async function enqueueOutboxEvent(repoRoot = '.', input = {}) {
  const paths = await resolveOutboxPaths(repoRoot); const release = await acquireLock(paths)
  try {
    const rows = await readOutboxUnlocked(paths)
    const event = normalizeEvent(input)
    const existing = rows.find(item => item.idempotencyKey === event.idempotencyKey)
    if (existing) return { event: existing, idempotent: true, pending: rows.length }
    rows.push(event)
    await writeEvents(paths, rows)
    return { event, idempotent: false, pending: rows.length }
  } finally { await release() }
}

export function buildReplayPlan(rows = []) {
  const pendingIds = new Set(rows.map(item => item.id))
  const completed = new Set()
  const remaining = [...rows]
  const ordered = []
  let progressed = true
  while (remaining.length && progressed) {
    progressed = false
    for (let index = 0; index < remaining.length;) {
      const item = remaining[index]
      const unresolved = item.dependsOn.filter(id => pendingIds.has(id) && !completed.has(id))
      if (unresolved.length) { index += 1; continue }
      ordered.push({ ...item, replayStatus: 'ready', unresolvedDependencies: [] })
      completed.add(item.id)
      remaining.splice(index, 1)
      progressed = true
    }
  }
  return [...ordered, ...remaining.map(item => ({ ...item, replayStatus: 'blocked', unresolvedDependencies: item.dependsOn.filter(id => pendingIds.has(id) && !completed.has(id)) }))]
}

export async function inspectOutbox(repoRoot = '.') {
  const rows = await readOutbox(repoRoot)
  const plan = buildReplayPlan(rows)
  const ready = plan.filter(item => item.replayStatus === 'ready')
  const blocked = plan.filter(item => item.replayStatus === 'blocked')
  const paths = await resolveOutboxPaths(repoRoot)
  return { path: paths.path, pending: rows.length, ready: ready.length, blocked: blocked.length, oldestCreatedAt: rows.map(item => item.createdAt).filter(Boolean).sort()[0] || '', next: ready[0] ? { id: ready[0].id, type: ready[0].type, idempotencyKey: ready[0].idempotencyKey, localTaskRef: ready[0].localTaskRef } : null, events: plan }
}

export async function acknowledgeOutboxEvent(repoRoot = '.', eventId = '') {
  const paths = await resolveOutboxPaths(repoRoot); const release = await acquireLock(paths)
  try {
    const rows = await readOutboxUnlocked(paths)
    const next = rows.filter(item => item.id !== eventId)
    if (next.length === rows.length) return { acknowledged: false, pending: rows.length }
    await writeEvents(paths, next)
    return { acknowledged: true, pending: next.length }
  } finally { await release() }
}

export async function markOutboxAttempt(repoRoot = '.', eventId = '', error = '', now = new Date().toISOString()) {
  const paths = await resolveOutboxPaths(repoRoot); const release = await acquireLock(paths)
  try {
    const rows = await readOutboxUnlocked(paths)
    const index = rows.findIndex(item => item.id === eventId)
    if (index < 0) return { updated: false, pending: rows.length }
    rows[index] = { ...rows[index], attempt: rows[index].attempt + 1, lastAttemptAt: now, lastError: text(error, 1000) }
    await writeEvents(paths, rows)
    return { updated: true, pending: rows.length, event: rows[index] }
  } finally { await release() }
}

async function main() {
  const [command = 'status', repoArg = '.', value = ''] = process.argv.slice(2)
  const repoRoot = resolve(repoArg)
  if (['status', 'list', 'replay-plan'].includes(command)) return console.log(JSON.stringify(await inspectOutbox(repoRoot), null, 2))
  if (command === 'ack') return console.log(JSON.stringify(await acknowledgeOutboxEvent(repoRoot, value), null, 2))
  if (command === 'fail') return console.log(JSON.stringify(await markOutboxAttempt(repoRoot, value, process.argv.slice(5).join(' ') || 'replay_failed'), null, 2))
  if (command === 'enqueue') return console.log(JSON.stringify(await enqueueOutboxEvent(repoRoot, JSON.parse(value || '{}')), null, 2))
  throw new Error(`unknown_command:${command}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
