#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONCURRENCY = 1
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_KILL_GRACE_MS = 2_000

const positiveInteger = (value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label}_must_be_between_1_and_${maximum}`)
  return parsed
}

const terminations = new WeakMap()

const terminateProcessTree = (child, graceMs) => {
  if (!child?.pid) return Promise.resolve()
  if (terminations.has(child)) return terminations.get(child)

  const termination = (async () => {
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise(resolvePromise => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        killer.once('error', () => resolvePromise())
        killer.once('close', () => resolvePromise())
      })
      return
    }

    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await new Promise(resolvePromise => {
      const done = () => {
        clearTimeout(timer)
        child.removeListener('close', done)
        resolvePromise()
      }
      const timer = setTimeout(done, graceMs)
      child.once('close', done)
      if (child.exitCode !== null || child.signalCode !== null) done()
    })
    // A closed leader does not prove its process group is gone. Kill the
    // remaining group immediately, before reporting completion or reusing IDs.
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  })()
  terminations.set(child, termination)
  return termination
}

export const discoverRegularTestFiles = async (root = process.cwd()) => {
  const names = await readdir(resolve(root, 'scripts'))
  return names.filter(name => /^test-.*\.mjs$/.test(name)).sort().map(name => `scripts/${name}`)
}

export async function runTestFiles(files, options = {}) {
  if (!files.length) throw new Error('node_test_files_empty')
  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY, 'concurrency', 4)
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeout_ms', 600_000)
  const killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS, 'kill_grace_ms', 10_000)
  const logger = options.logger || console.log
  const cwd = options.cwd || process.cwd()
  const stdio = options.stdio || 'inherit'
  const env = { ...(options.env || process.env) }
  delete env.NODE_TEST_CONTEXT
  const isolationRoot = await mkdtemp(join(tmpdir(), 'cap-node-tests-'))
  const active = new Set()
  const results = []
  let cursor = 0
  let maxActive = 0
  let stopScheduling = false

  const cleanup = async () => {
    await Promise.all([...active].map(child => terminateProcessTree(child, killGraceMs)))
  }
  const onSignal = signal => {
    stopScheduling = true
    cleanup().finally(() => {
      process.removeListener(signal, signalHandlers[signal])
      process.kill(process.pid, signal)
    })
  }
  const signalHandlers = {
    SIGINT: () => onSignal('SIGINT'),
    SIGTERM: () => onSignal('SIGTERM'),
  }
  process.once('SIGINT', signalHandlers.SIGINT)
  process.once('SIGTERM', signalHandlers.SIGTERM)

  const runOne = (file, index) => new Promise(resolvePromise => {
    const startedAt = Date.now()
    logger(`[node-test ${index + 1}/${files.length}] START ${file}`)
    const childEnv = { ...env, CAPITAL_AGENT_SESSION_LOCK_DIR: join(isolationRoot, String(index)) }
    for (const key of ['CAPITAL_AGENT_RUNTIME_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete childEnv[key]
    const child = spawn(process.execPath, ['--test', file], {
      cwd,
      env: childEnv,
      stdio,
      detached: process.platform !== 'win32',
    })
    active.add(child)
    maxActive = Math.max(maxActive, active.size)
    let timedOut = false
    let spawnError = ''
    const timer = setTimeout(() => {
      timedOut = true
      logger(`[node-test ${index + 1}/${files.length}] TIMEOUT ${file} after ${timeoutMs}ms`)
      terminateProcessTree(child, killGraceMs).catch(() => {})
    }, timeoutMs)

    child.once('error', error => { spawnError = error.message })
    child.once('close', async code => {
      clearTimeout(timer)
      await terminations.get(child)
      active.delete(child)
      const durationMs = Date.now() - startedAt
      const passed = !timedOut && !spawnError && code === 0
      const status = passed ? 'PASS' : timedOut ? 'TIMEOUT' : 'FAIL'
      logger(`[node-test ${index + 1}/${files.length}] ${status} ${file} (${durationMs}ms${spawnError ? `; ${spawnError}` : ''})`)
      const result = { file, code, passed, timedOut, durationMs, error: spawnError }
      results[index] = result
      if (!passed) stopScheduling = true
      resolvePromise(result)
    })
  })

  const worker = async () => {
    while (true) {
      if (stopScheduling) return
      const index = cursor
      cursor += 1
      if (index >= files.length) return
      await runOne(files[index], index)
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  } finally {
    process.removeListener('SIGINT', signalHandlers.SIGINT)
    process.removeListener('SIGTERM', signalHandlers.SIGTERM)
    await cleanup()
    await rm(isolationRoot, { recursive: true, force: true })
  }

  const completedResults = results.filter(Boolean)
  const failedResults = completedResults.filter(result => !result.passed)
  return {
    total: completedResults.length,
    requested: files.length,
    notRun: files.length - completedResults.length,
    passed: completedResults.length - failedResults.length,
    failed: failedResults.length,
    timedOut: completedResults.filter(result => result.timedOut).length,
    maxActive,
    results: completedResults,
  }
}

const parseCli = argv => {
  const options = { stress: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--stress') options.stress = true
    else if (value === '--concurrency') options.concurrency = argv[++index]
    else if (value === '--timeout-ms') options.timeoutMs = argv[++index]
    else throw new Error(`unknown_argument:${value}`)
  }
  return options
}

const main = async () => {
  const cli = parseCli(process.argv.slice(2))
  const stress = cli.stress
  const files = stress ? ['scripts/stress-cap-outbox.mjs'] : await discoverRegularTestFiles()
  const concurrency = positiveInteger(cli.concurrency || process.env.CAP_NODE_TEST_CONCURRENCY, stress ? 1 : DEFAULT_CONCURRENCY, 'concurrency', 4)
  const timeoutMs = positiveInteger(cli.timeoutMs || process.env.CAP_NODE_TEST_TIMEOUT_MS, stress ? 90_000 : DEFAULT_TIMEOUT_MS, 'timeout_ms', 600_000)
  console.log(`[node-test] profile=${stress ? 'release-stress' : 'regular'} files=${files.length} concurrency=${concurrency} timeout_ms=${timeoutMs}`)
  const summary = await runTestFiles(files, { concurrency, timeoutMs })
  console.log(`[node-test] summary requested=${summary.requested} completed=${summary.total} passed=${summary.passed} failed=${summary.failed} timed_out=${summary.timedOut} not_run=${summary.notRun} max_active=${summary.maxActive}`)
  if (summary.failed > 0) process.exitCode = 1
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(error => {
  console.error(`[node-test] ERROR ${error.message}`)
  process.exitCode = 1
})
