import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectOutbox } from './cap-outbox.mjs'

const TOTAL_WRITES = 40
const DEFAULT_CONCURRENCY = 4
const DEFAULT_CHILD_TIMEOUT_MS = 15_000

const boundedInteger = (value, fallback, maximum, label) => {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label}_must_be_between_1_and_${maximum}`)
  return parsed
}

test('outbox preserves every event under bounded multi-process contention', { timeout: 90_000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-outbox-race-'))
  const cli = fileURLToPath(new URL('./cap-outbox.mjs', import.meta.url))
  const concurrency = boundedInteger(process.env.CAP_OUTBOX_STRESS_CONCURRENCY, DEFAULT_CONCURRENCY, 16, 'stress_concurrency')
  const childTimeoutMs = boundedInteger(process.env.CAP_OUTBOX_STRESS_CHILD_TIMEOUT_MS, DEFAULT_CHILD_TIMEOUT_MS, 60_000, 'stress_child_timeout_ms')
  const active = new Set()
  let stopScheduling = false

  const stopChild = child => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1_000)
    force.unref()
  }

  const waitForClose = child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return Promise.race([
      new Promise(resolvePromise => child.once('close', resolvePromise)),
      new Promise(resolvePromise => {
        const timer = setTimeout(resolvePromise, 2_000)
        timer.unref()
      }),
    ])
  }

  t.after(async () => {
    for (const child of active) stopChild(child)
    await Promise.all([...active].map(waitForClose))
    await rm(repo, { recursive: true, force: true })
  })

  const runWrite = index => new Promise(resolvePromise => {
    const input = JSON.stringify({ type: 'skill.event', idempotencyKey: `race:${index}`, payload: { index } })
    const child = spawn(process.execPath, [cli, 'enqueue', repo, input], {
      env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    active.add(child)
    let error = ''
    let timedOut = false
    let stderr = ''
    const timer = setTimeout(() => {
      timedOut = true
      stopChild(child)
    }, childTimeoutMs)
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', cause => { error = cause.message })
    child.once('close', status => {
      clearTimeout(timer)
      active.delete(child)
      resolvePromise({ index, status, timedOut, error, stderr })
    })
  })

  let nextIndex = 0
  let completed = 0
  const results = Array(TOTAL_WRITES)
  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= TOTAL_WRITES) return
      results[index] = await runWrite(index)
      completed += 1
      if (results[index].status !== 0 || results[index].timedOut || results[index].error) stopScheduling = true
      if (completed % 10 === 0 || completed === TOTAL_WRITES) {
        t.diagnostic(`outbox stress progress ${completed}/${TOTAL_WRITES}; active=${active.size}; concurrency=${concurrency}`)
      }
      if (stopScheduling) return
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  const completedResults = results.filter(Boolean)
  const failures = completedResults.filter(result => result.status !== 0 || result.timedOut || result.error)
  assert.deepEqual(failures, [], failures.map(result => JSON.stringify(result)).join('\n'))
  assert.equal(completedResults.length, TOTAL_WRITES)

  const outbox = await inspectOutbox(repo)
  assert.equal(outbox.pending, TOTAL_WRITES)
  assert.equal(new Set(outbox.events.map(item => item.idempotencyKey)).size, TOTAL_WRITES)
})
