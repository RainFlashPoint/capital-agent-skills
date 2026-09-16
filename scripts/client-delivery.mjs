import { readFile, rename, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { acknowledgeOutboxEvent, enqueueOutboxEvent, inspectOutbox, markOutboxAttempt, outboxEventTaskRef } from './cap-outbox.mjs'

const text = value => String(value || '').trim()
const git = (repo, args) => { try { return text(execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })) } catch { return '' } }
const field = (markdown, name) => text(String(markdown || '').match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]).replace(/\s+#.*$/, '')

export function sanitizeRepositoryUrl(value = '') {
  const raw = text(value)
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return raw.replace(/(https?:\/\/)[^@\s/]+@/i, '$1')
  }
}

export function repositoryUrlHasEmbeddedCredentials(value = '') {
  const raw = text(value)
  if (/^[^\s/@]+@[^\s/:]+:[^\s]*[?#]/.test(raw)) return true
  try {
    const parsed = new URL(raw)
    if (parsed.search || parsed.hash || parsed.password) return true
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.username)
  } catch {
    return /https?:\/\/[^@\s/]+@/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#]/i.test(raw)
  }
}

export async function readHarnessMode(repoRoot) {
  const profile = await readFile(join(repoRoot, '.cap/PROFILE.md'), 'utf8').catch(() => '')
  return field(profile, 'harness-mode').toLowerCase() === 'local-only' ? 'local-only' : 'server'
}

export async function readClientConfig(homeDir = homedir()) {
  const raw = await readFile(join(homeDir, '.config/capital-agent/env'), 'utf8').catch(() => '')
  return Object.fromEntries(raw.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
}

export async function buildCommitDelivery(repoRoot) {
  const state = await readFile(join(repoRoot, '.cap/STATE.md'), 'utf8').catch(() => '')
  const taskId = field(state, 'task-id') || field(state, 'task_id')
  const commitSha = git(repoRoot, ['rev-parse', 'HEAD'])
  if (!taskId || !commitSha) return null
  const parent = git(repoRoot, ['rev-parse', `${commitSha}^`])
  const changedFiles = git(repoRoot, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commitSha]).split(/\r?\n/).filter(Boolean)
  return {
    taskId,
    payload: {
      session_id: field(state, 'session-id') || field(state, 'session_id'),
      idempotency_key: `client-commit:${taskId}:${commitSha}`,
      base_commit: parent,
      commit_sha: commitSha,
      branch: git(repoRoot, ['branch', '--show-current']),
      changed_files: changedFiles,
      delivery_candidate: false,
      verification: { source: 'client_post_commit', pending: true },
    },
  }
}

export function buildPushAuthorizationFingerprint({ repoUrl = '', pushUrl = repoUrl, taskId = '', branch = '', commitSha = '' } = {}) {
  const safeRepoUrl = sanitizeRepositoryUrl(repoUrl)
  const safePushUrl = sanitizeRepositoryUrl(pushUrl)
  const identity = [safeRepoUrl, safePushUrl, text(taskId), text(branch), text(commitSha)].join('\n')
  return createHash('sha256').update(identity).digest('hex')
}

function remoteHead(repoRoot, remoteUrl, branch) {
  if (!remoteUrl || !branch) return ''
  const ref = `refs/heads/${branch}`
  const output = git(repoRoot, ['ls-remote', '--exit-code', '--refs', remoteUrl, ref])
  const match = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === ref)
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(match?.[0] || '') ? match[0].toLowerCase() : ''
}

const VERIFICATION_FIELDS = new Set(['passed', 'status', 'outcome', 'sourceCommit', 'source_commit', 'commitSha', 'commit_sha', 'executedAt', 'executed_at', 'environmentFingerprint', 'environment_fingerprint', 'commands', 'qualityAssetIds', 'quality_asset_ids'])
const PASS_OUTCOMES = new Set(['PASS', 'PASSED', 'SUCCESS'])
const ENVIRONMENT_KEYS = new Set(['os', 'node', 'python', 'jdk', 'runtime', 'lock'])
const QUALITY_ASSET_ID = /^(?:qa|quality_asset)_[A-Za-z0-9][A-Za-z0-9._:-]{0,196}$/

function singleAlias(object, keys) {
  const present = keys.filter(key => Object.hasOwn(object, key))
  return present.length > 1 ? { ok: false } : { ok: true, value: present.length ? object[present[0]] : undefined }
}

function normalizeEnvironmentFingerprint(value = '') {
  const raw = text(value)
  if (!raw) return { ok: true, value: '' }
  if (raw.length > 500 || /[\r\n\x00-\x1f]/.test(raw)) return { ok: false }
  const pairs = raw.split(';')
  const seen = new Set()
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    const key = pair.slice(0, index).trim().toLowerCase()
    const item = pair.slice(index + 1).trim()
    if (index < 1 || !ENVIRONMENT_KEYS.has(key) || seen.has(key) || !/^[A-Za-z0-9._:+-]{1,128}$/.test(item)) return { ok: false }
    seen.add(key)
  }
  return { ok: true, value: `sha256:${createHash('sha256').update(pairs.join(';')).digest('hex')}` }
}

export function normalizeCandidateVerification(verification = {}, commitSha = '') {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return { ok: false, reason: 'verification_fields_invalid' }
  if (Object.keys(verification).some(key => !VERIFICATION_FIELDS.has(key))) return { ok: false, reason: 'verification_fields_invalid' }
  const source = singleAlias(verification, ['sourceCommit', 'source_commit', 'commitSha', 'commit_sha'])
  const executionTime = singleAlias(verification, ['executedAt', 'executed_at'])
  const environmentValue = singleAlias(verification, ['environmentFingerprint', 'environment_fingerprint'])
  const assets = singleAlias(verification, ['qualityAssetIds', 'quality_asset_ids'])
  if (![source, executionTime, environmentValue, assets].every(alias => alias.ok)) return { ok: false, reason: 'verification_fields_invalid' }
  const sourceCommit = text(source.value).toLowerCase()
  if (!sourceCommit || sourceCommit !== text(commitSha).toLowerCase()) return { ok: false, reason: 'verification_commit_mismatch' }
  const declaredOutcomes = [verification.status, verification.outcome].filter(value => value !== undefined).map(value => text(value).toUpperCase())
  if (verification.passed !== true || !declaredOutcomes.length || declaredOutcomes.some(value => !PASS_OUTCOMES.has(value))) return { ok: false, reason: 'local_verification_not_passed' }
  let commands
  if (verification.commands !== undefined) {
    if (!Array.isArray(verification.commands) || verification.commands.length > 50) return { ok: false, reason: 'verification_fields_invalid' }
    commands = []
    for (const item of verification.commands) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['command', 'exitCode', 'exit_code'].includes(key))) return { ok: false, reason: 'verification_fields_invalid' }
      const commandExit = singleAlias(item, ['exitCode', 'exit_code'])
      if (!commandExit.ok) return { ok: false, reason: 'verification_fields_invalid' }
      const command = text(item.command)
      const exitCode = commandExit.value
      if (!command || command.length > 500 || /[\r\n\x00-\x1f]/.test(command) || !Number.isSafeInteger(exitCode)) return { ok: false, reason: 'verification_fields_invalid' }
      if (exitCode !== 0) return { ok: false, reason: 'verification_command_failed' }
      commands.push({ commandHash: `sha256:${createHash('sha256').update(command).digest('hex')}`, exitCode })
    }
  }
  const executedAt = text(executionTime.value)
  const environment = normalizeEnvironmentFingerprint(environmentValue.value)
  const qualityAssetIds = assets.value
  if ((executedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(executedAt) || !Number.isFinite(Date.parse(executedAt)))) || !environment.ok || (qualityAssetIds !== undefined && (!Array.isArray(qualityAssetIds) || qualityAssetIds.length > 100 || qualityAssetIds.some(value => typeof value !== 'string' || !QUALITY_ASSET_ID.test(value))))) return { ok: false, reason: 'verification_fields_invalid' }
  if (!(commands?.length)) return { ok: false, reason: 'verification_evidence_missing' }
  return { ok: true, verification: { passed: true, status: 'PASS', outcome: 'PASS', sourceCommit, ...(executedAt ? { executedAt } : {}), ...(environment.value ? { environmentFingerprint: environment.value } : {}), ...(commands?.length ? { commands } : {}), ...(qualityAssetIds?.length ? { qualityAssetIds } : {}) } }
}

export async function buildCandidateDelivery(repoRoot, { verification = {}, authorizedFingerprint = '', remoteName = 'origin', pushUrl = '' } = {}) {
  const harnessMode = await readHarnessMode(repoRoot)
  if (harnessMode === 'local-only') return { ok: false, reason: 'repository_harness_local_only', harnessMode }
  const item = await buildCommitDelivery(repoRoot)
  if (!item) return { ok: false, reason: 'delivery_identity_missing' }
  const repoUrl = git(repoRoot, ['remote', 'get-url', remoteName])
  if (!repoUrl) return { ok: false, reason: 'remote_missing', remoteName, item }
  const targetUrl = pushUrl || repoUrl
  const remoteCommitSha = remoteHead(repoRoot, targetUrl, item.payload.branch)
  const expectedFingerprint = buildPushAuthorizationFingerprint({ repoUrl, pushUrl: targetUrl, taskId: item.taskId, branch: item.payload.branch, commitSha: item.payload.commit_sha })
  if (!remoteCommitSha || remoteCommitSha !== item.payload.commit_sha) return { ok: false, reason: 'source_commit_not_remote', expectedFingerprint, remoteCommitSha, item }
  if (!authorizedFingerprint || authorizedFingerprint !== expectedFingerprint) return { ok: false, reason: 'push_authorization_required', expectedFingerprint, item }
  const normalized = normalizeCandidateVerification(verification, item.payload.commit_sha)
  if (!normalized.ok) return { ...normalized, expectedFingerprint, item }
  return {
    ok: true,
    expectedFingerprint,
    remoteCommitSha,
    item: { ...item, payload: { ...item.payload, idempotency_key: `delivery-candidate:${item.taskId}:${item.payload.commit_sha}:${expectedFingerprint}`, delivery_candidate: true, verification: { ...normalized.verification, authorizationFingerprint: expectedFingerprint, remoteReadbackSha: remoteCommitSha } } },
  }
}

export async function sendCandidateDelivery({ serverUrl, userKey, taskId, payload, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${String(serverUrl).replace(/\/+$/, '')}/api/tasks/${encodeURIComponent(taskId)}/commit-reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-key': userKey }, body: JSON.stringify(payload), signal: controller.signal,
    })
    const body = await response.json().catch(() => ({}))
    return response.ok && Number(body?.code ?? 0) === 0
      ? { ok: true, status: response.status, data: body.data || {} }
      : { ok: false, status: response.status, reason: 'candidate_request_failed', detail: text(body?.msg || body?.message || `HTTP ${response.status}`).slice(0, 500) }
  } catch (error) {
    return { ok: false, status: 0, reason: error?.name === 'AbortError' ? 'candidate_request_timeout' : 'candidate_request_failed', detail: text(error?.message).slice(0, 500) }
  } finally { clearTimeout(timer) }
}

export async function sendCommitDelivery({ serverUrl, userKey, taskId, payload, fetchImpl = fetch }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500)
  try {
    const response = await fetchImpl(`${String(serverUrl).replace(/\/+$/, '')}/api/tasks/${encodeURIComponent(taskId)}/commit-reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-key': userKey }, body: JSON.stringify(payload), signal: controller.signal,
    })
    return response.ok
  } catch { return false } finally { clearTimeout(timer) }
}

export async function queueCommitDelivery(repoRoot, item) {
  if (item?.payload?.delivery_candidate === true) throw new Error('candidate_delivery_requires_live_authorization')
  return enqueueOutboxEvent(repoRoot, {
    type: 'delivery.record',
    idempotencyKey: item?.payload?.idempotency_key || `delivery:${item?.taskId || 'unknown'}:${item?.payload?.commit_sha || 'unknown'}`,
    localTaskRef: item?.taskId || '',
    payload: item,
  })
}

function canonicalDeliveryKeys(task = {}) {
  if (!task || !Array.isArray(task.evidence)) return new Set()
  return new Set(task.evidence
    .filter(item => ['delivery', 'local_delivery'].includes(text(item?.type).toLowerCase()))
    .map(item => text(item?.idempotencyKey || item?.idempotency_key))
    .filter(Boolean))
}

export async function flushPendingDeliveries(repoRoot, { activeTaskRef = '', canonicalTask = null, fetchImpl = fetch, homeDir = homedir() } = {}) {
  const path = join(repoRoot, '.cap/pending-deliveries.jsonl')
  const raw = await readFile(path, 'utf8').catch(() => '')
  const rows = raw.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  for (const row of rows) await queueCommitDelivery(repoRoot, row)
  if (rows.length) {
    const temp = `${path}.tmp`
    await writeFile(temp, '')
    await rename(temp, path)
  }
  const config = await readClientConfig(homeDir)
  let plan = await inspectOutbox(repoRoot, { activeTaskRef })
  const deliveredKeys = canonicalDeliveryKeys(canonicalTask)
  let confirmed = 0
  if (deliveredKeys.size) {
    for (const event of plan.events) {
      if (event.type !== 'delivery.record' || event?.payload?.payload?.delivery_candidate === true) continue
      const key = text(event?.payload?.payload?.idempotency_key || event.idempotencyKey)
      if (!key || !deliveredKeys.has(key)) continue
      const result = await acknowledgeOutboxEvent(repoRoot, event.id)
      if (result.acknowledged) confirmed += 1
    }
    if (confirmed) plan = await inspectOutbox(repoRoot, { activeTaskRef })
  }
  const pendingIds = new Set(plan.events.map(item => item.id))
  const deliveries = plan.events.filter(item => item.type === 'delivery.record'
    && item.replayStatus === 'ready'
    && !(item.dependsOn || []).some(dependencyId => pendingIds.has(dependencyId))
    && (!activeTaskRef || outboxEventTaskRef(item) === text(activeTaskRef)))
  let sent = 0
  for (const event of deliveries) {
    const item = event.payload || {}
    if (item?.payload?.delivery_candidate === true) {
      await markOutboxAttempt(repoRoot, event.id, 'candidate_delivery_requires_fresh_authorization')
      continue
    }
    const ok = await sendCommitDelivery({ serverUrl: config.CAPITAL_AGENT_SERVER_URL, userKey: config.CAPITAL_AGENT_USER_KEY, taskId: item.taskId, payload: item.payload, fetchImpl })
    if (ok) { await acknowledgeOutboxEvent(repoRoot, event.id); sent += 1 }
    else await markOutboxAttempt(repoRoot, event.id, 'delivery_replay_failed')
  }
  const after = await inspectOutbox(repoRoot, { activeTaskRef })
  const pending = after.events.filter(item => item.type === 'delivery.record'
    && (!activeTaskRef || outboxEventTaskRef(item) === text(activeTaskRef))).length
  return { total: deliveries.length + confirmed, migrated: rows.length, sent, ...(confirmed ? { confirmed } : {}), pending }
}
