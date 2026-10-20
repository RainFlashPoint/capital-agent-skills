#!/usr/bin/env node
import { existsSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'
import { localTestProviderLaunchPolicy } from './setup-lib.mjs'

const failure = (code, detail = '') => ({ exitCode: 1, body: { ok: false, code, detail } })
const skipped = (code, detail) => ({ exitCode: 0, body: { ok: true, skipped: true, mode: 'remote-only', code, detail } })

function parseRuntimeFailure(result) {
  for (const value of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(String(value || '').trim())
      if (parsed?.code === 'local_provider_unavailable' && parsed?.claimed !== true) return parsed
    } catch {}
  }
  return null
}

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
    // Formal Harness Actions may run only through the installed test-only
    // runtime that implements the current pre-claim sandbox protocol. Legacy
    // loop runners and PATH fallbacks cannot prove that boundary.
    const runnerBin = resolve(environment.HOME || '', '.capital-agent', 'runner', 'local-test-provider.mjs')
    if (!pathExists(runnerBin)) return skipped('local_provider_unavailable', '本机 Test Provider 未安装；未查询或领取本机 Action，客户端应继续等待远端 Runner。')
    const result = spawnProcess(process.execPath, [runnerBin, repo, actionId], { encoding: 'utf8', stdio: 'pipe', env: environment })
    if (result.error?.code === 'ENOENT') {
      return skipped('local_provider_unavailable', '本机 Test Provider 未安装或不可执行；未查询或领取本机 Action，客户端应继续等待远端 Runner。')
    } else if (result.status !== 0) {
      const unavailable = parseRuntimeFailure(result)
      if (unavailable) return skipped('local_provider_unavailable', unavailable.detail || '本机 Test Provider 配置、认证或初始化未就绪；客户端应继续等待远端 Runner。')
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
