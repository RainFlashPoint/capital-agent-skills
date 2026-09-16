#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCandidateDelivery, buildPushAuthorizationFingerprint, readClientConfig, readHarnessMode, sendCandidateDelivery } from './client-delivery.mjs'

const text = value => String(value || '').trim()
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const field = (markdown, name) => text(String(markdown || '').match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]).replace(/\s+#.*$/, '')

function requiredValue(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`push_candidate_${name}_invalid`)
  return value
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = { repo: '.', remote: 'origin' }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--json') { options.json = true; continue }
    if (key === '--help' || key === '-h') { options.help = true; continue }
    const names = { '--repo': 'repo', '--remote': 'remote', '--task': 'taskId', '--branch': 'branch', '--commit': 'commitSha', '--authorization-fingerprint': 'authorizedFingerprint', '--verification-json': 'verificationPath' }
    const name = names[key]
    if (!name) throw new Error('push_candidate_unknown_option')
    if (Object.hasOwn(options, name) && !(name === 'repo' || name === 'remote')) throw new Error(`push_candidate_${name}_duplicate`)
    options[name] = requiredValue(argv, index, name === 'taskId' ? 'task' : name)
    index += 1
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text(options.remote))) throw new Error('push_candidate_remote_invalid')
  return options
}

async function requestJson(url, { method = 'GET', userKey, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method, headers: { 'content-type': 'application/json', 'x-user-key': userKey }, signal: controller.signal })
    const body = await response.json().catch(() => ({}))
    return response.ok && Number(body?.code ?? 0) === 0
      ? { ok: true, status: response.status, data: body.data ?? body }
      : { ok: false, status: response.status, detail: text(body?.msg || body?.message || `HTTP ${response.status}`).slice(0, 500) }
  } catch (error) {
    return { ok: false, status: 0, detail: text(error?.message).slice(0, 500) }
  } finally { clearTimeout(timer) }
}

function identityFailure(actual, expected, reason) {
  return actual === expected ? null : { ok: false, stage: 'preflight', reason, expected, actual }
}

export async function runPushCandidateDelivery(repoRoot, options = {}) {
  const repo = resolve(repoRoot)
  const remoteName = text(options.remote || 'origin')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteName)) return { ok: false, stage: 'preflight', reason: 'remote_invalid' }
  let root
  try { root = git(repo, ['rev-parse', '--show-toplevel']) } catch { return { ok: false, stage: 'preflight', reason: 'repository_invalid' } }
  if (await realpath(root).catch(() => resolve(root)) !== await realpath(repo).catch(() => repo)) return { ok: false, stage: 'preflight', reason: 'repository_root_mismatch' }
  const state = await readFile(`${repo}/.cap/STATE.md`, 'utf8').catch(() => '')
  if (await readHarnessMode(repo) === 'local-only') return { ok: false, stage: 'preflight', reason: 'repository_harness_local_only' }
  if (!text(options.serverUrl) || !text(options.userKey)) return { ok: false, stage: 'preflight', reason: 'platform_config_missing' }
  const taskId = field(state, 'task-id') || field(state, 'task_id')
  const branch = git(repo, ['branch', '--show-current'])
  const commitSha = git(repo, ['rev-parse', 'HEAD'])
  for (const failure of [
    identityFailure(taskId, text(options.taskId), 'task_identity_changed'),
    identityFailure(branch, text(options.branch), 'branch_identity_changed'),
    identityFailure(commitSha, text(options.commitSha), 'commit_identity_changed'),
  ]) if (failure) return failure
  try { git(repo, ['check-ref-format', '--branch', branch]) } catch { return { ok: false, stage: 'preflight', reason: 'branch_invalid' } }
  let repoUrl
  try { repoUrl = git(repo, ['remote', 'get-url', remoteName]) } catch { return { ok: false, stage: 'preflight', reason: 'remote_missing' } }
  const expectedFingerprint = buildPushAuthorizationFingerprint({ repoUrl, taskId, branch, commitSha })
  if (!options.authorizedFingerprint || options.authorizedFingerprint !== expectedFingerprint) {
    return { ok: false, stage: 'preflight', reason: 'push_authorization_required', expectedFingerprint }
  }
  const outcome = text(options.verification?.outcome || options.verification?.status).toUpperCase()
  if (options.verification?.passed !== true || !['PASS', 'PASSED', 'SUCCESS'].includes(outcome)) {
    return { ok: false, stage: 'preflight', reason: 'local_verification_not_passed', expectedFingerprint }
  }
  try {
    git(repo, ['push', '--porcelain', '--', remoteName, `${commitSha}:refs/heads/${branch}`])
  } catch (error) {
    return { ok: false, stage: 'push', reason: 'git_push_failed', detail: text(error?.stderr || error?.message).slice(0, 1000) }
  }
  const postPushState = await readFile(`${repo}/.cap/STATE.md`, 'utf8').catch(() => '')
  for (const failure of [
    identityFailure(field(postPushState, 'task-id') || field(postPushState, 'task_id'), taskId, 'task_identity_changed'),
    identityFailure(git(repo, ['branch', '--show-current']), branch, 'branch_identity_changed'),
    identityFailure(git(repo, ['rev-parse', 'HEAD']), commitSha, 'commit_identity_changed'),
    identityFailure(git(repo, ['remote', 'get-url', remoteName]), repoUrl, 'repository_identity_changed'),
  ]) if (failure) return { ...failure, stage: 'remote_readback' }
  const candidate = await buildCandidateDelivery(repo, { verification: options.verification, authorizedFingerprint: expectedFingerprint, remoteName })
  if (!candidate.ok) return { ok: false, stage: 'remote_readback', ...candidate }
  const candidateResult = await sendCandidateDelivery({ serverUrl: options.serverUrl, userKey: options.userKey, taskId, payload: candidate.item.payload, fetchImpl: options.fetchImpl })
  if (!candidateResult.ok) return { ok: false, stage: 'candidate_delivery', ...candidateResult, expectedFingerprint }
  const baseUrl = String(options.serverUrl || '').replace(/\/+$/, '')
  const refresh = await requestJson(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/ci/refresh`, { method: 'POST', userKey: options.userKey, fetchImpl: options.fetchImpl })
  const canonical = await requestJson(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { userKey: options.userKey, fetchImpl: options.fetchImpl })
  if (!refresh.ok) return { ok: false, partial: true, candidateAccepted: true, stage: 'ci_refresh', reason: 'ci_refresh_failed', detail: refresh.detail, canonical: canonical.ok ? canonical.data : null }
  if (!canonical.ok) return { ok: false, partial: true, candidateAccepted: true, ciRefreshAccepted: true, stage: 'canonical_readback', reason: 'canonical_task_read_failed', detail: canonical.detail }
  return { ok: true, candidateAccepted: true, ciRefreshAccepted: true, expectedFingerprint, remoteCommitSha: candidate.remoteCommitSha, task: canonical.data }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv)
    if (options.help) {
      process.stdout.write('Usage: node scripts/cap-push-candidate.mjs --repo <repo> --task <id> --branch <branch> --commit <sha> --authorization-fingerprint <sha256> --verification-json <path> [--remote origin] [--json]\n')
      return 0
    }
    const config = await readClientConfig(homedir())
    const verification = JSON.parse(await readFile(resolve(options.verificationPath || ''), 'utf8'))
    const result = await runPushCandidateDelivery(resolve(options.repo), { ...options, verification, serverUrl: config.CAPITAL_AGENT_SERVER_URL, userKey: config.CAPITAL_AGENT_USER_KEY })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: text(error?.message || error) }, null, 2)}\n`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main()
