#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OUTBOX_TYPES = new Set(['task.attach', 'artifact.record', 'delivery.record', 'action.create:test', 'action.create:review', 'experience.record', 'skill.event'])
const text = (value, max = 4000) => String(value ?? '').trim().slice(0, max)
const outboxPath = repoRoot => join(resolve(repoRoot), '.cap/outbox.jsonl')

function stableKey(input = {}) {
  const explicit = text(input.idempotencyKey || input.idempotency_key, 500)
  if (explicit) return explicit
  const digest = createHash('sha256').update(JSON.stringify({ type: input.type, localTaskRef: input.localTaskRef || input.local_task_ref || '', payload: input.payload || {} })).digest('hex').slice(0, 24)
  return `cap-outbox:${input.type}:${digest}`
}

function normalizeEvent(input = {}, now = new Date().toISOString()) {
  const type = text(input.type, 100)
  if (!OUTBOX_TYPES.has(type)) throw new Error(`unsupported_outbox_type:${type || 'empty'}`)
  return {
    id: text(input.id, 200) || `evt_${randomUUID()}`,
    idempotencyKey: stableKey(input),
    type,
    localTaskRef: text(input.localTaskRef || input.local_task_ref, 300),
    dependsOn: [...new Set((Array.isArray(input.dependsOn) ? input.dependsOn : []).map(item => text(item, 200)).filter(Boolean))],
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    createdAt: text(input.createdAt, 100) || now,
    attempt: Math.max(0, Number(input.attempt) || 0),
    lastAttemptAt: text(input.lastAttemptAt, 100),
    lastError: text(input.lastError, 1000),
  }
}

async function writeEvents(repoRoot, rows) {
  const path = outboxPath(repoRoot)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, rows.map(item => JSON.stringify(item)).join('\n') + (rows.length ? '\n' : ''))
  await rename(temp, path)
}

export async function readOutbox(repoRoot = '.') {
  const raw = await readFile(outboxPath(repoRoot), 'utf8').catch(() => '')
  return raw.split(/\r?\n/).filter(Boolean).map(line => { try { return normalizeEvent(JSON.parse(line)) } catch { return null } }).filter(Boolean)
}

export async function enqueueOutboxEvent(repoRoot = '.', input = {}) {
  const rows = await readOutbox(repoRoot)
  const event = normalizeEvent(input)
  const existing = rows.find(item => item.idempotencyKey === event.idempotencyKey)
  if (existing) return { event: existing, idempotent: true, pending: rows.length }
  rows.push(event)
  await writeEvents(repoRoot, rows)
  return { event, idempotent: false, pending: rows.length }
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
  return { path: outboxPath(repoRoot), pending: rows.length, ready: ready.length, blocked: blocked.length, oldestCreatedAt: rows.map(item => item.createdAt).filter(Boolean).sort()[0] || '', next: ready[0] ? { id: ready[0].id, type: ready[0].type, idempotencyKey: ready[0].idempotencyKey, localTaskRef: ready[0].localTaskRef } : null, events: plan }
}

export async function acknowledgeOutboxEvent(repoRoot = '.', eventId = '') {
  const rows = await readOutbox(repoRoot)
  const next = rows.filter(item => item.id !== eventId)
  if (next.length === rows.length) return { acknowledged: false, pending: rows.length }
  await writeEvents(repoRoot, next)
  return { acknowledged: true, pending: next.length }
}

export async function markOutboxAttempt(repoRoot = '.', eventId = '', error = '', now = new Date().toISOString()) {
  const rows = await readOutbox(repoRoot)
  const index = rows.findIndex(item => item.id === eventId)
  if (index < 0) return { updated: false, pending: rows.length }
  rows[index] = { ...rows[index], attempt: rows[index].attempt + 1, lastAttemptAt: now, lastError: text(error, 1000) }
  await writeEvents(repoRoot, rows)
  return { updated: true, pending: rows.length, event: rows[index] }
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
