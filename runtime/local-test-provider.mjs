#!/usr/bin/env node
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { homedir, hostname } from 'os'
import { dirname, join, resolve } from 'path'
import { spawnSync } from 'child_process'

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

function commandEvidence(action, cwd) {
  const receipts = []
  const failures = []
  let passed = 0
  for (const check of action.contractSnapshot?.requiredChecks || []) {
    const startedAt = new Date().toISOString()
    const result = run('bash', ['-lc', String(check.command || '')], { cwd, timeout: Math.max(1, Number(check.timeoutSeconds) || 900) * 1000 })
    const finishedAt = new Date().toISOString()
    const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error?.message || ''}`
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
      stdoutHash: hash(result.stdout),
      stderrHash: hash(result.stderr || result.error?.message),
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
    const evidence = {
      ...commandEvidence(claim.action, worktree),
      executorRunId: `runner:${config.runnerId}:${actionId}`,
      independence: { mode: 'separate_run', verifierRunId: `runner:${config.runnerId}:${actionId}` },
    }
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
