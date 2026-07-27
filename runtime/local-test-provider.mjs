#!/usr/bin/env node
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { homedir, hostname } from 'os'
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

function normalizeRepo(value = '') {
  return String(value || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '').replace(':', '/')
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

function executeCommand(command, cwd, timeoutMs, leaseState) {
  return new Promise(resolvePromise => {
    const stdoutHash = createHash('sha256'); const stderrHash = createHash('sha256')
    let stdoutPreview = ''; let stderrPreview = ''; let timedOut = false
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    leaseState.activeChild = child
    child.stdout.on('data', chunk => { stdoutHash.update(chunk); if (stdoutPreview.length < 100_000) stdoutPreview += String(chunk).slice(0, 100_000 - stdoutPreview.length) })
    child.stderr.on('data', chunk => { stderrHash.update(chunk); if (stderrPreview.length < 100_000) stderrPreview += String(chunk).slice(0, 100_000 - stderrPreview.length) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    let settled = false
    const finish = (status, error) => {
      if (settled) return
      settled = true; clearTimeout(timer); leaseState.activeChild = null
      resolvePromise({ status, error, stdoutPreview, stderrPreview, stdoutHash: stdoutHash.digest('hex'), stderrHash: stderrHash.digest('hex'), timedOut })
    }
    child.on('error', error => finish(1, error))
    child.on('close', status => finish(status, leaseState.lost ? { code: 'LEASE_LOST', message: leaseState.error } : timedOut ? { code: 'ETIMEDOUT' } : null))
  })
}

async function commandEvidence(action, cwd, leaseState) {
  const receipts = []
  const failures = []
  let passed = 0
  for (const check of action.contractSnapshot?.requiredChecks || []) {
    const startedAt = new Date().toISOString()
    const result = await executeCommand(String(check.command || ''), cwd, Math.max(1, Number(check.timeoutSeconds) || 900) * 1000, leaseState)
    const finishedAt = new Date().toISOString()
    const diagnostic = `${result.stderrPreview || ''}\n${result.stdoutPreview || ''}\n${result.error?.message || ''}`
    const ok = result.status === 0 && !result.error
    if (ok) passed += 1
    else failures.push(result.error?.code === 'ETIMEDOUT' || environmentFailures.some(pattern => pattern.test(diagnostic)) ? 'ENV_BLOCKED' : 'CODE_FAILED')
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
      environmentFingerprint: `local-test-provider;node=${process.versions.node};platform=${process.platform}-${process.arch}`,
    })
  }
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
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (!config.serverUrl || !config.runnerId || !config.runnerCredential) throw new Error('本地 Test Provider 尚未完成 setup')
  const remote = run('git', ['-C', repo, 'remote', 'get-url', 'origin'])
  if (remote.status !== 0) throw new Error('当前仓库没有 origin')
  const repoUrl = String(remote.stdout || '').trim()
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
          leaseState.activeChild?.kill('SIGTERM')
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
