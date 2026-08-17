#!/usr/bin/env node
import { existsSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'

function fail(message, detail = '') {
  process.stdout.write(`${JSON.stringify({ ok: false, code: message, detail }, null, 2)}\n`)
  process.exitCode = 1
}

const repo = resolve(process.argv[2] || process.cwd())
const actionId = String(process.argv[3] || '').trim()
if (!existsSync(resolve(repo, '.git'))) {
  fail('repo_not_found', repo)
} else if (!/^action_[a-zA-Z0-9-]+$/.test(actionId)) {
  fail('action_id_required', '必须传入本次 create_task_action 返回的精确 Action ID。')
} else {
  let repoUrl = ''
  try {
    repoUrl = sanitizeRepositoryUrl(execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
  } catch {
    fail('repo_remote_missing', repo)
  }

  if (repoUrl) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const candidates = [
      process.env.CAPITAL_AGENT_RUNNER_BIN,
      resolve(process.env.HOME || '', '.capital-agent', 'runner', 'local-test-provider.mjs'),
      resolve(packageRoot, '..', 'capital-agent-runner', 'bin', 'capital-loop-runner.mjs'),
      resolve(packageRoot, '..', '..', 'capital-agent-runner', 'bin', 'capital-loop-runner.mjs'),
    ].filter(Boolean)
    const runnerBin = candidates.find(candidate => existsSync(candidate)) || ''
    const installedRuntime = runnerBin.endsWith('local-test-provider.mjs')
    const command = runnerBin ? process.execPath : 'capital-loop-runner'
    const args = installedRuntime
      ? [runnerBin, repo, actionId]
      : runnerBin
      ? [runnerBin, 'once', '--harness-only', '--harness-action-id', actionId, '--repo-map', `${repoUrl}=${repo}|`]
      : ['once', '--harness-only', '--harness-action-id', actionId, '--repo-map', `${repoUrl}=${repo}|`]
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', env: process.env })
    if (result.error?.code === 'ENOENT') {
      fail('local_runner_missing', '安装或配置 capital-agent-runner 后重试；不会回退到 Server 测试环境。')
    } else if (result.status !== 0) {
      fail('local_runner_failed', String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 2000))
    } else {
      process.stdout.write(String(result.stdout || '').trim() + '\n')
    }
  }
}
