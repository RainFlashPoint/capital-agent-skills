#!/usr/bin/env node
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'fs/promises'
import { homedir, hostname, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'

const hash = value => createHash('sha256').update(String(value || '')).digest('hex')
const configPath = process.env.CAPITAL_AGENT_LOCAL_PROVIDER_CONFIG || join(homedir(), '.capital-agent', 'runner', 'config.json')
const environmentFailures = [
  /could not transfer artifact|non-resolvable parent pom|failed to read artifact descriptor|dependency resolution failed/i,
  /unknown host|name or service not known|temporary failure in name resolution/i,
  /connection (?:refused|reset|timed out)|connect timed out|read timed out/i,
  /pkix path building failed|unable to find valid certification path/i,
  /(?:401|403).*(?:repository|artifact)|not authorized.*(?:repository|artifact)/i,
]

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

async function effectiveMode() {
  const raw = await readFile(join(homedir(), '.config', 'capital-agent', 'env'), 'utf8').catch(() => '')
  const config = Object.fromEntries(raw.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
  return String(process.env.CAPITAL_AGENT_MODE || config.CAPITAL_AGENT_MODE || '').trim().toLowerCase()
}

function normalizeRepo(value = '') {
  return sanitizeRepoUrl(value).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '').replace(':', '/')
}

function sanitizeRepoUrl(value = '') {
  const raw = String(value || '').trim()
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return raw.replace(/(https?:\/\/)[^@\s/]+@/i, '$1')
  }
}

async function post(config, path, body = {}) {
  const response = await fetch(`${config.serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-runner-id': config.runnerId, 'x-runner-token': config.runnerCredential },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.code !== 0) throw new Error(`${path}: HTTP ${response.status} ${payload.msg || 'request failed'}`)
  return payload.data
}

function minimalEnvironment(home) {
  const env = {
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    CI: 'true',
  }
  for (const name of ['JAVA_HOME', 'GOROOT']) if (process.env[name]) env[name] = process.env[name]
  return env
}

async function sandboxInvocation(command, cwd, sandboxHome) {
  const canonicalCwd = await realpath(cwd)
  const canonicalHome = await realpath(sandboxHome)
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const readable = ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Java', '/private/etc', '/dev']
      .filter(existsSync).map(path => `(subpath ${JSON.stringify(path)})`).join(' ')
    const profile = `(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow network*)
(allow file-read* ${readable} (subpath ${JSON.stringify(canonicalCwd)}) (subpath ${JSON.stringify(canonicalHome)}))
(allow file-write* (subpath ${JSON.stringify(canonicalCwd)}) (subpath ${JSON.stringify(canonicalHome)}) (literal "/dev/null"))`
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/bash', '--noprofile', '--norc', '-c', command], mode: 'macos-sandbox' }
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
    const args = ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--proc', '/proc', '--dev', '/dev']
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt']) if (existsSync(path)) args.push('--ro-bind', path, path)
    args.push('--bind', canonicalCwd, canonicalCwd, '--bind', canonicalHome, canonicalHome, '--chdir', canonicalCwd, '/bin/bash', '--noprofile', '--norc', '-c', command)
    return { command: '/usr/bin/bwrap', args, mode: 'linux-bwrap' }
  }
  const error = new Error('受控 Provider 沙箱不可用；macOS 需要 sandbox-exec，Linux 需要 bubblewrap。')
  error.code = 'SANDBOX_UNAVAILABLE'
  throw error
}

function terminateChild(child, signal = 'SIGTERM') {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {}
}

async function executeCommand(command, cwd, timeoutMs, leaseState, sandboxHome) {
  let invocation
  try { invocation = await sandboxInvocation(command, cwd, sandboxHome) } catch (error) {
    return { status: 1, error, stdoutPreview: '', stderrPreview: '', stdoutHash: hash(''), stderrHash: hash(error.message), timedOut: false, sandboxMode: 'unavailable' }
  }
  return new Promise(resolvePromise => {
    const stdoutHash = createHash('sha256'); const stderrHash = createHash('sha256')
    let stdoutPreview = ''; let stderrPreview = ''; let timedOut = false
    const child = spawn(invocation.command, invocation.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnvironment(sandboxHome), detached: process.platform !== 'win32' })
    leaseState.activeChild = child
    child.stdout.on('data', chunk => { stdoutHash.update(chunk); if (stdoutPreview.length < 100_000) stdoutPreview += String(chunk).slice(0, 100_000 - stdoutPreview.length) })
    child.stderr.on('data', chunk => { stderrHash.update(chunk); if (stderrPreview.length < 100_000) stderrPreview += String(chunk).slice(0, 100_000 - stderrPreview.length) })
    const timer = setTimeout(() => { timedOut = true; terminateChild(child); setTimeout(() => terminateChild(child, 'SIGKILL'), 2000).unref?.() }, timeoutMs)
    let settled = false
    const finish = (status, error) => {
      if (settled) return
      settled = true; clearTimeout(timer); leaseState.activeChild = null
      resolvePromise({ status, error, stdoutPreview, stderrPreview, stdoutHash: stdoutHash.digest('hex'), stderrHash: stderrHash.digest('hex'), timedOut, sandboxMode: invocation.mode })
    }
    child.on('error', error => finish(1, error))
    child.on('close', status => finish(status, leaseState.lost ? { code: 'LEASE_LOST', message: leaseState.error } : timedOut ? { code: 'ETIMEDOUT' } : null))
  })
}

async function commandEvidence(action, cwd, leaseState) {
  const receipts = []
  const failures = []
  let passed = 0
  const sandboxHome = await mkdtemp(join(tmpdir(), 'capital-agent-provider-'))
  await mkdir(join(sandboxHome, 'tmp'), { recursive: true, mode: 0o700 })
  try {
    for (const check of action.contractSnapshot?.requiredChecks || []) {
      const startedAt = new Date().toISOString()
      const result = await executeCommand(String(check.command || ''), cwd, Math.max(1, Number(check.timeoutSeconds) || 900) * 1000, leaseState, sandboxHome)
      const finishedAt = new Date().toISOString()
      const diagnostic = `${result.stderrPreview || ''}\n${result.stdoutPreview || ''}\n${result.error?.message || ''}`
      const ok = result.status === 0 && !result.error
      if (ok) passed += 1
      else failures.push(result.error?.code === 'ETIMEDOUT' || result.error?.code === 'SANDBOX_UNAVAILABLE' || environmentFailures.some(pattern => pattern.test(diagnostic)) ? 'ENV_BLOCKED' : 'CODE_FAILED')
      receipts.push({
        commandId: `command_${hash(`${action.id}:${check.id}:${startedAt}`).slice(0, 16)}`,
        checkId: check.id,
        command: check.command,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        exitCode: Number.isInteger(result.status) ? result.status : 1,
        timedOut: result.error?.code === 'ETIMEDOUT',
        canceled: false,
        stdoutHash: result.stdoutHash,
        stderrHash: result.stderrHash || hash(result.error?.message),
        testedHead: action.contractSnapshot?.source?.commitSha || action.sourceCommit,
        environmentFingerprint: `local-test-provider;sandbox=${result.sandboxMode};node=${process.versions.node};platform=${process.platform}-${process.arch}`,
      })
    }
  } finally { await rm(sandboxHome, { recursive: true, force: true }).catch(() => {}) }
  const total = receipts.length
  const failed = total - passed
  const onlyEnvironment = failures.length > 0 && failures.every(item => item === 'ENV_BLOCKED')
  return {
    testedHead: action.contractSnapshot?.source?.commitSha || action.sourceCommit,
    receipts,
    summary: { total, passed, failed, skipped: 0 },
    outcome: failed === 0 && total > 0 ? 'PASS' : onlyEnvironment ? 'ENV_BLOCKED' : 'CODE_FAILED',
    category: failed === 0 ? 'runner_test_passed' : onlyEnvironment ? 'dependency_unavailable' : 'runner_test_failed',
    artifactRefs: [],
    finishedAt: new Date().toISOString(),
  }
}

async function main() {
  const repo = resolve(process.argv[2] || '')
  const actionId = String(process.argv[3] || '').trim()
  if (!repo || !existsSync(join(repo, '.git'))) throw new Error('必须传入本地 Git 仓库路径')
  if (!/^action_[a-zA-Z0-9-]+$/.test(actionId)) throw new Error('必须传入精确 Harness Action ID')
  if (await effectiveMode() === 'local') throw new Error('显式本地模式禁止连接平台或领取 Harness Action')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (!config.serverUrl || !config.runnerId || !config.runnerCredential) throw new Error('本地 Test Provider 尚未完成 setup')
  const remote = run('git', ['-C', repo, 'remote', 'get-url', 'origin'])
  if (remote.status !== 0) throw new Error('当前仓库没有 origin')
  const repoUrl = sanitizeRepoUrl(String(remote.stdout || '').trim())
  await post(config, '/api/execution/runner/heartbeat', {
    hostname: hostname(), version: config.runtimeVersion || 'skills-local-test-provider',
    capabilities: { test: true, patch: false, repositories: [repoUrl], runtimes: [`node${process.versions.node.split('.')[0]}`], networkZones: ['local', 'enterprise'], maxConcurrency: 1 },
  })
  const claim = await post(config, '/api/execution/runner/harness/actions/claim', { actionId })
  if (!claim?.action) throw new Error('指定 Test Action 当前不可领取')
  if (claim.action.actionType !== 'test') throw new Error('本地 Provider 只允许执行 test Action')
  const source = claim.action.contractSnapshot?.source || {}
  if (normalizeRepo(source.repoUrl) !== normalizeRepo(repoUrl)) throw new Error('Action 仓库与当前本地仓库不一致')
  const commit = String(source.commitSha || claim.action.sourceCommit || '').trim()
  let found = run('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`])
  if (found.status !== 0 && source.branch) {
    run('git', ['-C', repo, 'fetch', '--no-tags', 'origin', String(source.branch)])
    found = run('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`])
  }
  if (found.status !== 0) throw new Error(`本地仓库找不到待验证 Commit ${commit.slice(0, 12)}`)
  const worktreeRoot = join(homedir(), '.capital-agent', 'runner', 'worktrees')
  const worktree = join(worktreeRoot, actionId.replace(/[^a-zA-Z0-9_-]/g, '-'))
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 })
  if (existsSync(worktree)) run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree])
  const created = run('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, commit])
  if (created.status !== 0) throw new Error(String(created.stderr || created.stdout || '创建独立 worktree 失败').trim())
  try {
    await post(config, `/api/execution/runner/harness/actions/${actionId}/start`, { leaseId: claim.lease?.leaseId })
    const leaseState = { activeChild: null, failures: 0, lost: false, error: '' }
    const renewalIntervalMs = Math.max(50, Number(process.env.CAPITAL_AGENT_LOCAL_PROVIDER_HEARTBEAT_MS) || 60_000)
    const renewal = setInterval(async () => {
      try {
        await post(config, `/api/execution/runner/harness/actions/${actionId}/heartbeat`, { leaseId: claim.lease?.leaseId })
        leaseState.failures = 0
      } catch (error) {
        leaseState.failures += 1
        leaseState.error = String(error?.message || error)
        if (leaseState.failures >= 3) {
          leaseState.lost = true
          if (leaseState.activeChild) terminateChild(leaseState.activeChild)
        }
      }
    }, renewalIntervalMs)
    renewal.unref?.()
    const evidence = {
      ...await commandEvidence(claim.action, worktree, leaseState),
      executorRunId: `runner:${config.runnerId}:${actionId}`,
      independence: { mode: 'separate_run', verifierRunId: `runner:${config.runnerId}:${actionId}` },
    }
    clearInterval(renewal)
    if (leaseState.lost) throw new Error(`Test Action 续租失败，已停止执行：${leaseState.error}`)
    const finished = await post(config, `/api/execution/runner/harness/actions/${actionId}/evidence`, { leaseId: claim.lease?.leaseId, evidence })
    process.stdout.write(`${JSON.stringify({ ok: true, actionId, status: finished.status, outcome: evidence.outcome, summary: evidence.summary }, null, 2)}\n`)
  } finally {
    run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree])
    run('git', ['-C', repo, 'worktree', 'prune'])
    await rm(worktree, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`)
  process.exit(1)
})
