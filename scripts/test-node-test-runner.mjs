import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTestFiles } from './node-test-runner.mjs'

const quiet = () => {}

test('node test runner keeps file concurrency within the configured limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-test-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const path = join(root, `test-${index}.mjs`)
    await writeFile(path, "import test from 'node:test'\ntest('bounded', async () => { await new Promise(resolve => setTimeout(resolve, 150)) })\n")
    return path
  }))

  const summary = await runTestFiles(files, { concurrency: 2, timeoutMs: 2_000, logger: quiet, stdio: 'ignore' })
  assert.equal(summary.failed, 0)
  assert.equal(summary.passed, 4)
  assert.equal(summary.maxActive, 2)
})

test('node test runner stops scheduling new files after the first failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-test-fail-fast-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const failing = join(root, 'test-1-fail.mjs')
  const shouldNotRun = join(root, 'test-2-should-not-run.mjs')
  await writeFile(failing, "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fails', () => assert.fail('expected fixture failure'))\n")
  await writeFile(shouldNotRun, "import test from 'node:test'\ntest('should not run', () => {})\n")

  const summary = await runTestFiles([failing, shouldNotRun], { concurrency: 1, timeoutMs: 2_000, logger: quiet, stdio: 'ignore' })
  assert.equal(summary.failed, 1)
  assert.equal(summary.total, 1)
  assert.equal(summary.notRun, 1)
})

test('node test runner isolates host session identity and lock storage per file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-test-session-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outputs = [join(root, 'one.json'), join(root, 'two.json')]
  const files = await Promise.all(outputs.map(async (output, index) => {
    const path = join(root, `test-session-${index}.mjs`)
    await writeFile(path, `
import test from 'node:test'
import { writeFileSync } from 'node:fs'
test('session isolation', () => writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  runtime: process.env.CAPITAL_AGENT_RUNTIME_SESSION_ID || '',
  thread: process.env.CODEX_THREAD_ID || '',
  session: process.env.CODEX_SESSION_ID || '',
  claude: process.env.CLAUDE_CODE_SESSION_ID || '',
  locks: process.env.CAPITAL_AGENT_SESSION_LOCK_DIR || '',
})))
`)
    return path
  }))

  const summary = await runTestFiles(files, {
    concurrency: 2,
    timeoutMs: 2_000,
    logger: quiet,
    stdio: 'ignore',
    env: { ...process.env, CAPITAL_AGENT_RUNTIME_SESSION_ID: 'inherited-runtime', CODEX_THREAD_ID: 'inherited-thread' },
  })
  assert.equal(summary.failed, 0)
  const [first, second] = await Promise.all(outputs.map(async path => JSON.parse(await readFile(path, 'utf8'))))
  for (const observed of [first, second]) assert.deepEqual({ ...observed, locks: '' }, { runtime: '', thread: '', session: '', claude: '', locks: '' })
  assert.notEqual(first.locks, second.locks)
})

test('node test runner rejects an empty suite and unsafe file concurrency', async () => {
  await assert.rejects(runTestFiles([]), /node_test_files_empty/)
  await assert.rejects(runTestFiles(['unused.mjs'], { concurrency: 5 }), /concurrency_must_be_between_1_and_4/)
})

test('node test runner times out a stuck file and removes its descendant process', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-test-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pidPath = join(root, 'descendant.pid')
  const fixture = join(root, 'test-stuck.mjs')
  await writeFile(fixture, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
setInterval(() => {}, 1000)
await new Promise(() => {})
`)

  const startedAt = Date.now()
  const summary = await runTestFiles([fixture], { concurrency: 1, timeoutMs: 500, killGraceMs: 200, logger: quiet, stdio: 'ignore' })
  assert.equal(summary.failed, 1)
  assert.equal(summary.timedOut, 1)
  assert.ok(Date.now() - startedAt < 5_000)

  const descendantPid = Number(await readFile(pidPath, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try { process.kill(descendantPid, 0) } catch { alive = false }
  }
  assert.equal(alive, false, `descendant process ${descendantPid} survived the timeout cleanup`)
})
