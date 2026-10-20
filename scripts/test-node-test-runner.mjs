import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverRegularTestFiles, runTestFiles } from './node-test-runner.mjs'

const quiet = () => {}

test('Node CLI keeps default regression separate from explicit stress', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-profiles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts/test-regular.mjs'), "import test from 'node:test'; test('regular marker', () => {})\n")
  await writeFile(join(root, 'scripts/stress-cap-outbox.mjs'), "import test from 'node:test'; test('stress marker', () => {})\n")
  assert.deepEqual(await discoverRegularTestFiles(root), ['scripts/test-regular.mjs'])
  const runner = fileURLToPath(new URL('./node-test-runner.mjs', import.meta.url))
  for (const stress of [false, true]) {
    const result = spawnSync(process.execPath, [runner, ...(stress ? ['--stress'] : [])], {
      cwd: root,
      env: { ...process.env, CAP_NODE_TEST_CONCURRENCY: '', CAP_NODE_TEST_TIMEOUT_MS: '' },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, stress ? /profile=release-stress files=1 concurrency=1 timeout_ms=90000/ : /profile=regular files=1 concurrency=1 timeout_ms=600000/)
    assert.match(result.stdout, stress ? /stress marker/ : /regular marker/)
    assert.doesNotMatch(result.stdout, stress ? /regular marker/ : /stress marker/)
    assert.match(result.stdout, /completed=1 passed=1 failed=0 timed_out=0 not_run=0 max_active=1/)
  }
})

test('default release-check schedules regular regression without Outbox stress', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-release-default-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'bin'))
  await copyFile(new URL('./release-check', import.meta.url), join(root, 'scripts/release-check'))
  await writeFile(join(root, 'scripts/validate-skills'), 'exit 0\n')
  const log = join(root, 'commands.log')
  for (const command of ['node', 'python3', 'git']) {
    await writeFile(join(root, 'bin', command), `#!/bin/sh\nprintf '%s\\n' '${command}'\" $*\" >> \"$CAP_RELEASE_COMMAND_LOG\"\n`, { mode: 0o755 })
  }
  const result = spawnSync('bash', [join(root, 'scripts/release-check')], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CAP_RELEASE_COMMAND_LOG: log, CAP_RELEASE_DIFF_BASE: 'HEAD^' },
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const commands = await readFile(log, 'utf8')
  assert.match(commands, /^node scripts\/node-test-runner\.mjs$/m)
  assert.match(commands, /^python3 -m unittest discover/m)
  assert.doesNotMatch(commands, /--stress|stress-cap-outbox/)
  assert.match(result.stdout, /RELEASE CHECK: PASS/)
})

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

test('timeout cleanup kills a TERM-resistant descendant after its leader exits', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-resistant-'))
  const pidPath = join(root, 'descendant.pid')
  t.after(async () => {
    const pid = Number(await readFile(pidPath, 'utf8').catch(() => ''))
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true })
  })
  const fixture = join(root, 'test-resistant.mjs')
  await writeFile(fixture, `
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', ${JSON.stringify("const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(" + JSON.stringify(pidPath) + ", String(process.pid)); setInterval(() => {}, 1000)")}], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`)
  const summary = await runTestFiles([fixture], { timeoutMs: 800, killGraceMs: 200, logger: quiet, stdio: 'ignore' })
  assert.equal(summary.timedOut, 1)
  const pid = Number(await readFile(pidPath, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try { process.kill(pid, 0) } catch { alive = false }
  }
  assert.equal(alive, false, `TERM-resistant descendant ${pid} survived cleanup`)
})

test('interruption cleans resistant descendants and stops scheduling files', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cap-node-interrupt-'))
  const pidPath = join(root, 'descendant.pid')
  const marker = join(root, 'should-not-run')
  const fixture = join(root, 'test-stuck.mjs')
  const next = join(root, 'test-next.mjs')
  const harness = join(root, 'harness.mjs')
  await writeFile(fixture, `
import { spawn } from 'node:child_process'
spawn(process.execPath, ['-e', ${JSON.stringify("const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(" + JSON.stringify(pidPath) + ", String(process.pid)); setInterval(() => {}, 1000)")}], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`)
  await writeFile(next, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran')`)
  await writeFile(harness, `import { runTestFiles } from ${JSON.stringify(new URL('./node-test-runner.mjs', import.meta.url).href)}; await runTestFiles(${JSON.stringify([fixture, next])}, { timeoutMs: 5000, killGraceMs: 200, stdio: 'ignore' })`)
  const child = spawn(process.execPath, [harness], { stdio: 'ignore' })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    const pid = Number(await readFile(pidPath, 'utf8').catch(() => ''))
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true })
  })
  let pid = 0
  for (let attempt = 0; attempt < 60 && !pid; attempt += 1) {
    pid = Number(await readFile(pidPath, 'utf8').catch(() => ''))
    if (!pid) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(pid, 'resistant descendant started')
  child.kill('SIGTERM')
  assert.equal((await closed).signal, 'SIGTERM')
  let alive = true
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try { process.kill(pid, 0) } catch { alive = false }
  }
  assert.equal(alive, false, `TERM-resistant descendant ${pid} survived interruption`)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})
