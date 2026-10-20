#!/usr/bin/env node
import { existsSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'
import { localTestProviderLaunchPolicy } from './setup-lib.mjs'

const failure = (code, detail = '') => ({ exitCode: 1, body: { ok: false, code, detail } })
const skipped = (code, detail) => ({ exitCode: 0, body: { ok: true, skipped: true, mode: 'remote-only', code, detail } })

export function launchLocalTestProvider({
  repo = resolve(process.argv[2] || process.cwd()),
  actionId = String(process.argv[3] || '').trim(),
  launchPolicy = localTestProviderLaunchPolicy(process.platform),
  environment = process.env,
  pathExists = existsSync,
  readOrigin = target => execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(),
  spawnProcess = spawnSync,
} = {}) {
  repo = resolve(repo)
  if (!launchPolicy.allowed) return skipped(launchPolicy.code, `${launchPolicy.detail}；未查询或领取本机 Action，客户端应继续等待远端 Runner。`)
  if (!pathExists(resolve(repo, '.git'))) return failure('repo_not_found', repo)
  if (!/^action_[a-zA-Z0-9-]+$/.test(actionId)) return failure('action_id_required', '必须传入本次 create_task_action 返回的精确 Action ID。')
  let repoUrl = ''
  try {
    repoUrl = sanitizeRepositoryUrl(readOrigin(repo))
  } catch {
    return failure('repo_remote_missing', repo)
  }

  if (repoUrl) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const candidates = [
      environment.CAPITAL_AGENT_RUNNER_BIN,
      resolve(environment.HOME || '', '.capital-agent', 'runner', 'local-test-provider.mjs'),
      resolve(packageRoot, '..', 'capital-agent-runner', 'bin', 'capital-loop-runner.mjs'),
      resolve(packageRoot, '..', '..', 'capital-agent-runner', 'bin', 'capital-loop-runner.mjs'),
    ].filter(Boolean)
    const runnerBin = candidates.find(candidate => pathExists(candidate)) || ''
    const installedRuntime = runnerBin.endsWith('local-test-provider.mjs')
    const command = runnerBin ? process.execPath : 'capital-loop-runner'
    const args = installedRuntime
      ? [runnerBin, repo, actionId]
      : runnerBin
      ? [runnerBin, 'once', '--harness-only', '--harness-action-id', actionId, '--repo-map', `${repoUrl}=${repo}|`]
      : ['once', '--harness-only', '--harness-action-id', actionId, '--repo-map', `${repoUrl}=${repo}|`]
    const result = spawnProcess(command, args, { encoding: 'utf8', stdio: 'pipe', env: environment })
    if (result.error?.code === 'ENOENT') {
      return skipped('local_provider_unavailable', '本机 Test Provider 未安装或不可执行；未查询或领取本机 Action，客户端应继续等待远端 Runner。')
    } else if (result.status !== 0) {
      return failure('local_runner_failed', String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 2000))
    } else {
      return { exitCode: 0, raw: String(result.stdout || '').trim() }
    }
  }
  return failure('repo_remote_missing', repo)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = launchLocalTestProvider()
  process.stdout.write(`${result.raw || JSON.stringify(result.body, null, 2)}\n`)
  process.exitCode = result.exitCode
}
