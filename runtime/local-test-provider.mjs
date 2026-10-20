#!/usr/bin/env node
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'fs/promises'
import { homedir, hostname, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'

const hash = value => createHash('sha256').update(String(value || '')).digest('hex')
const configPath = process.env.CAPITAL_AGENT_LOCAL_PROVIDER_CONFIG || join(homedir(), '.capital-agent', 'runner', 'config.json')
const providerUnavailable = message => Object.assign(new Error(message), { code: 'LOCAL_PROVIDER_UNAVAILABLE' })
const environmentFailures = [
  /could not transfer artifact|non-resolvable parent pom|failed to read artifact descriptor|dependency resolution failed/i,
  /unknown host|name or service not known|temporary failure in name resolution/i,
  /connection (?:refused|reset|timed out)|connect timed out|read timed out/i,
  /pkix path building failed|unable to find valid certification path/i,
  /(?:401|403).*(?:repository|artifact)|not authorized.*(?:repository|artifact)/i,
  /(?:EPERM|operation not permitted).*(?:lstat|\/private|sandbox)|(?:lstat|\/private|sandbox).*(?:EPERM|operation not permitted)/i,
  /(?:could not create shared memory segment|shmget|semget).*(?:operation not permitted|permission denied)/i,
  /bwrap:.*(?:creating new namespace failed|operation not permitted|permission denied)/i,
  /(?:sandbox-exec|bwrap).*(?:EACCES|ENOEXEC|operation not permitted|permission denied)/i,
]

export const isEnvironmentFailure = diagnostic => environmentFailures.some(pattern => pattern.test(diagnostic))

function sandboxProbeArgs(platform, pathExists) {
  if (platform === 'darwin') return ['-p', '(version 1)(deny default)(allow process*)(allow file-read*)', '/usr/bin/true']
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--proc', '/proc', '--dev', '/dev']
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) if (pathExists(path)) args.push('--ro-bind', path, path)
  return [...args, '/bin/true']
}

export function inspectSandboxCapability(platform = process.platform, { pathExists = existsSync, runCommand = spawnSync } = {}) {
  if (platform === 'win32') return { available: false, code: 'windows_remote_only', executable: '', detail: '' }
  const executable = platform === 'darwin' ? '/usr/bin/sandbox-exec' : platform === 'linux' ? '/usr/bin/bwrap' : ''
  if (!executable) return { available: false, code: 'sandbox_unsupported', executable: '', detail: `unsupported platform: ${platform}` }
  if (!pathExists(executable)) return { available: false, code: 'sandbox_unavailable', executable, detail: '' }
  const result = runCommand(executable, sandboxProbeArgs(platform, pathExists), { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)
  if (result.status !== 0 || result.error) return { available: false, code: 'sandbox_unusable', executable, detail }
  return { available: true, code: '', executable, detail: '' }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

async function clientConfig() {
  const raw = await readFile(join(homedir(), '.config', 'capital-agent', 'env'), 'utf8').catch(() => '')
  return Object.fromEntries(raw.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
}

function normalizeRepo(value = '') {
  const raw = sanitizeRepoUrl(value)
  // Git accepts SCP remotes with or without user@. Parse these before URL(),
  // which otherwise treats a username-less hostname as a custom URL scheme.
  const scp = !raw.includes('://') && raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\/+$/, '').replace(/\.git$/i, '')
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return ''
    return `${parsed.host.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '').replace(/\.git$/i, '')
  } catch { return '' }
}

function sanitizeRepoUrl(value = '') {
  const raw = String(value || '').trim()
  const scp = !raw.includes('://') && raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
  if (scp) return /[?#]/.test(scp[2]) ? '' : `${scp[1]}:${scp[2]}`
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return raw.replace(/(https?:\/\/)[^@\s/]+@/i, '$1').replace(/[?#].*$/, '')
  }
}

function serverAddress(value = '') {
  try {
    const url = new URL(String(value).trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error()
    return url.toString().replace(/\/+$/, '')
  } catch { throw new Error('本地 Provider 的 Server 地址无效或不是安全地址') }
}

function actionSource(action, actionId, repoUrl) {
  if (action?.id !== actionId || action.actionType !== 'test') throw new Error('平台返回的 Action 身份或类型与请求不一致')
  const source = action.contractSnapshot?.source || {}
  if (typeof source.repositoryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(source.repositoryId)) throw new Error('平台 Action 缺少有效仓库 ID')
  const origin = normalizeRepo(repoUrl)
  if (!origin || origin !== normalizeRepo(source.repoUrl)) throw new Error('Action 仓库与当前本地仓库不一致')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.commitSha || '') || (action.sourceCommit && action.sourceCommit !== source.commitSha)) throw new Error('平台 Action 缺少一致的精确 Commit')
  return source
}

async function canonicalAction(config, client, actionId) {
  // Read-only host-controller lookup. Never persist this identity in the runner
  // config or pass it to commands; owner/scope authorization remains at claim.
  let serverUrl, clientServer
  try {
    serverUrl = serverAddress(config.serverUrl)
    clientServer = serverAddress(client.CAPITAL_AGENT_SERVER_URL)
  } catch { throw providerUnavailable('本地 Test Provider 或客户端 Server 配置无效') }
  if (!client.CAPITAL_AGENT_USER_KEY || clientServer !== serverUrl) throw providerUnavailable('本地客户端身份缺失或与 Provider Server 不一致')
  let response
  try {
    response = await fetch(`${serverUrl}/api/harness/actions/${encodeURIComponent(actionId)}`, {
      headers: { 'x-user-key': client.CAPITAL_AGENT_USER_KEY }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
  } catch { throw providerUnavailable('本地 Test Provider 无法连接或认证平台') }
  const payload = await response.json().catch(() => ({}))
  if ([401, 403].includes(response.status)) throw providerUnavailable('本地 Test Provider 平台认证失败')
  if (!response.ok || payload.code !== 0) throw new Error(`平台 Action 查询失败：HTTP ${response.status}`)
  if (payload.data?.status !== 'ready') throw new Error('指定 Test Action 当前不可领取')
  return payload.data
}

async function post(config, path, body = {}, { beforeClaim = false } = {}) {
  let response
  try {
    response = await fetch(`${config.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runner-id': config.runnerId, 'x-runner-token': config.runnerCredential },
      body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (beforeClaim) throw providerUnavailable('本地 Test Provider 无法连接平台 Runner 接口')
    throw error
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.code !== 0) {
    if (beforeClaim) throw providerUnavailable('本地 Test Provider 配置或认证未就绪')
    throw new Error(`${path}: HTTP ${response.status} ${payload.msg || 'request failed'}`)
  }
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

export async function sandboxInvocation(command, cwd, sandboxHome) {
  const canonicalCwd = await realpath(cwd)
  const canonicalHome = await realpath(sandboxHome)
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const readableRoots = ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Java', '/private/etc', '/private/var/select/sh', '/dev'].filter(existsSync)
    const readable = readableRoots.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')
    // realpath(3) needs metadata on ancestors such as /opt, but no content access.
    const metadata = [...new Set([canonicalCwd, canonicalHome, ...readableRoots].flatMap(path => {
      const ancestors = []
      let current = dirname(path)
      while (current && current !== dirname(current)) {
        ancestors.push(current)
        current = dirname(current)
      }
      return ancestors
    }))].filter(existsSync).map(path => `(literal ${JSON.stringify(path)})`).join(' ')
    const profile = `(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow signal (target same-sandbox))
(allow network*)
(allow file-read-metadata ${metadata})
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

const escalationTimers = new WeakMap()

function terminateChildWithEscalation(child, graceMs = 2000) {
  terminateChild(child)
  if (escalationTimers.has(child)) return
  const timer = setTimeout(() => terminateChild(child, 'SIGKILL'), graceMs)
  timer.unref?.()
  escalationTimers.set(child, timer)
}

function clearTerminationEscalation(child) {
  const timer = escalationTimers.get(child)
  if (timer) clearTimeout(timer)
  escalationTimers.delete(child)
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
    const timer = setTimeout(() => { timedOut = true; terminateChildWithEscalation(child) }, timeoutMs)
    let settled = false
    const finish = (status, error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      // The leader closing its pipes does not prove its process group exited.
      // Finish pending termination now, then discard the timer so a later PID
      // reuse cannot receive the delayed signal.
      if (escalationTimers.has(child)) terminateChild(child, 'SIGKILL')
      clearTerminationEscalation(child); leaseState.activeChild = null
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
  const checks = action.contractSnapshot?.requiredChecks || []
  try {
    for (const check of checks) {
      if (leaseState.lost) { failures.push('ENV_BLOCKED'); break }
      const startedAt = new Date().toISOString()
      const result = await executeCommand(String(check.command || ''), cwd, Math.max(1, Number(check.timeoutSeconds) || 900) * 1000, leaseState, sandboxHome)
      const finishedAt = new Date().toISOString()
      const diagnostic = `${result.stderrPreview || ''}\n${result.stdoutPreview || ''}\n${result.error?.message || ''}`
      const ok = result.status === 0 && !result.error
      if (ok) passed += 1
      else failures.push(['ETIMEDOUT', 'SANDBOX_UNAVAILABLE', 'LEASE_LOST', 'EACCES', 'ENOEXEC', 'EPERM'].includes(result.error?.code) || isEnvironmentFailure(diagnostic) ? 'ENV_BLOCKED' : 'CODE_FAILED')
      receipts.push({
        commandId: `command_${hash(`${action.id}:${check.id}:${startedAt}`).slice(0, 16)}`,
        checkId: check.id,
        command: check.command,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        exitCode: Number.isInteger(result.status) ? result.status : 1,
        timedOut: result.error?.code === 'ETIMEDOUT',
        canceled: result.error?.code === 'LEASE_LOST',
        stdoutHash: result.stdoutHash,
        stderrHash: result.stderrHash || hash(result.error?.message),
        testedHead: action.contractSnapshot?.source?.commitSha || action.sourceCommit,
        environmentFingerprint: `local-test-provider;sandbox=${result.sandboxMode};node=${process.versions.node};platform=${process.platform}-${process.arch}`,
      })
      if (leaseState.lost) break
    }
  } finally { await rm(sandboxHome, { recursive: true, force: true }).catch(() => {}) }
  const total = checks.length
  const failed = receipts.length - passed
  const skipped = total - receipts.length
  const onlyEnvironment = failures.length > 0 && failures.every(item => item === 'ENV_BLOCKED')
  return {
    testedHead: action.contractSnapshot?.source?.commitSha || action.sourceCommit,
    receipts,
    summary: { total, passed, failed, skipped },
    outcome: passed === total && total > 0 ? 'PASS' : onlyEnvironment ? 'ENV_BLOCKED' : 'CODE_FAILED',
    category: passed === total && total > 0 ? 'runner_test_passed' : onlyEnvironment ? 'dependency_unavailable' : 'runner_test_failed',
    artifactRefs: [],
    finishedAt: new Date().toISOString(),
  }
}

export async function runLocalTestProviderRuntime({
  repo = resolve(process.argv[2] || ''),
  actionId = String(process.argv[3] || '').trim(),
  platform = process.platform,
  pathExists = existsSync,
  runCommand = spawnSync,
  environment = process.env,
  output = value => process.stdout.write(value),
} = {}) {
  repo = resolve(repo)
  if (!repo || !existsSync(join(repo, '.git'))) throw new Error('必须传入本地 Git 仓库路径')
  if (!/^action_[a-zA-Z0-9-]+$/.test(actionId)) throw new Error('必须传入精确 Harness Action ID')
  if (String(environment.CAPITAL_AGENT_MODE || '').trim().toLowerCase() === 'local') throw new Error('显式本地模式禁止连接平台或领取 Harness Action')
  const sandbox = inspectSandboxCapability(platform, { pathExists, runCommand })
  if (!sandbox.available) {
    const result = { ok: true, skipped: true, mode: 'remote-only', code: sandbox.code, detail: `本机没有可实际运行的 OS 沙箱${sandbox.detail ? `：${sandbox.detail}` : ''}；未查询或领取 Action，客户端继续等待远端 Runner。` }
    output(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const client = await clientConfig()
  if (String(client.CAPITAL_AGENT_MODE || '').trim().toLowerCase() === 'local') throw new Error('显式本地模式禁止连接平台或领取 Harness Action')
  let config
  try { config = JSON.parse(await readFile(configPath, 'utf8')) }
  catch { throw providerUnavailable('本地 Test Provider 配置缺失或损坏') }
  if (!config.serverUrl || !config.runnerId || !config.runnerCredential) throw providerUnavailable('本地 Test Provider 尚未完成 setup')
  try { config.serverUrl = serverAddress(config.serverUrl) }
  catch { throw providerUnavailable('本地 Test Provider Server 配置无效') }
  const remote = run('git', ['-C', repo, 'remote', 'get-url', 'origin'])
  if (remote.status !== 0) throw new Error('当前仓库没有 origin')
  const repoUrl = sanitizeRepoUrl(String(remote.stdout || '').trim())
  if (!repoUrl) throw new Error('当前仓库 origin 不是可安全识别的 Git 远端地址')
  const expectedAction = await canonicalAction(config, client, actionId)
  const expectedSource = actionSource(expectedAction, actionId, repoUrl)
  await post(config, '/api/execution/runner/heartbeat', {
    hostname: hostname(), version: config.runtimeVersion || 'skills-local-test-provider',
    capabilities: { test: true, patch: false, repositoryIds: [expectedSource.repositoryId], repositories: [repoUrl], runtimes: [`node${process.versions.node.split('.')[0]}`], networkZones: ['local', 'public', 'enterprise'], maxConcurrency: 1 },
  }, { beforeClaim: true })
  const claim = await post(config, '/api/execution/runner/harness/actions/claim', { actionId }, { beforeClaim: true })
  if (!claim?.action) throw new Error('指定 Test Action 当前不可领取')
  const source = actionSource(claim.action, actionId, repoUrl)
  if (source.repositoryId !== expectedSource.repositoryId || source.commitSha !== expectedSource.commitSha || source.branch !== expectedSource.branch) throw new Error('领取的 Action 来源与平台预检结果不一致，停止执行')
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
  if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true })
  const cloned = run('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', repo, worktree])
  if (cloned.status !== 0) throw new Error(String(cloned.stderr || cloned.stdout || '创建独立验证 clone 失败').trim())
  const checkedOut = run('git', ['-C', worktree, 'checkout', '--detach', commit])
  if (checkedOut.status !== 0) throw new Error(String(checkedOut.stderr || checkedOut.stdout || '检出待验证 Commit 失败').trim())
  run('git', ['-C', worktree, 'remote', 'set-url', 'origin', repoUrl])
  try {
    await post(config, `/api/execution/runner/harness/actions/${actionId}/start`, { leaseId: claim.lease?.leaseId })
    const leaseState = { activeChild: null, failures: 0, lost: false, error: '' }
    const renewalIntervalMs = Math.max(50, Number(process.env.CAPITAL_AGENT_LOCAL_PROVIDER_HEARTBEAT_MS) || 60_000)
    const renewal = setInterval(async () => {
      if (leaseState.lost) return
      try {
        await post(config, `/api/execution/runner/harness/actions/${actionId}/heartbeat`, { leaseId: claim.lease?.leaseId })
        leaseState.failures = 0
      } catch (error) {
        leaseState.failures += 1
        leaseState.error = String(error?.message || error)
        if (leaseState.failures >= 3) {
          leaseState.lost = true
          clearInterval(renewal)
          if (leaseState.activeChild) terminateChildWithEscalation(leaseState.activeChild)
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
    output(`${JSON.stringify({ ok: true, actionId, status: finished.status, outcome: evidence.outcome, summary: evidence.summary }, null, 2)}\n`)
  } finally {
    await rm(worktree, { recursive: true, force: true }).catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runLocalTestProviderRuntime().catch(error => {
  const unavailable = error?.code === 'LOCAL_PROVIDER_UNAVAILABLE'
  process.stderr.write(`${JSON.stringify({ ok: false, code: unavailable ? 'local_provider_unavailable' : 'local_provider_failed', ...(unavailable ? { claimed: false } : {}), detail: String(error?.message || error) }, null, 2)}\n`)
  process.exit(1)
})
