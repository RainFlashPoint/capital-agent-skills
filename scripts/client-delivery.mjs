import { readFile, rename, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { acknowledgeOutboxEvent, enqueueOutboxEvent, inspectOutbox, markOutboxAttempt } from './cap-outbox.mjs'

const text = value => String(value || '').trim()
const git = (repo, args) => { try { return text(execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })) } catch { return '' } }
const field = (markdown, name) => text(String(markdown || '').match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]).replace(/\s+#.*$/, '')

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

export function buildPushAuthorizationFingerprint({ repoUrl = '', taskId = '', branch = '', commitSha = '' } = {}) {
  let safeRepoUrl = text(repoUrl)
  try {
    const parsed = new URL(safeRepoUrl)
    parsed.username = ''
    parsed.password = ''
    safeRepoUrl = parsed.toString()
  } catch {
    safeRepoUrl = safeRepoUrl.replace(/(https?:\/\/)[^@\s]+@/i, '$1')
  }
  const identity = [safeRepoUrl, text(taskId), text(branch), text(commitSha)].join('\n')
  return createHash('sha256').update(identity).digest('hex')
}

export async function buildCandidateDelivery(repoRoot, { verification = {}, authorizedFingerprint = '' } = {}) {
  const item = await buildCommitDelivery(repoRoot)
  if (!item) return { ok: false, reason: 'delivery_identity_missing' }
  const repoUrl = git(repoRoot, ['remote', 'get-url', 'origin'])
  const upstream = git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstreamHead = upstream ? git(repoRoot, ['rev-parse', upstream]) : ''
  const expectedFingerprint = buildPushAuthorizationFingerprint({ repoUrl, taskId: item.taskId, branch: item.payload.branch, commitSha: item.payload.commit_sha })
  if (!upstreamHead || upstreamHead !== item.payload.commit_sha) return { ok: false, reason: 'source_commit_not_remote', expectedFingerprint, item }
  if (!authorizedFingerprint || authorizedFingerprint !== expectedFingerprint) return { ok: false, reason: 'push_authorization_required', expectedFingerprint, item }
  const outcome = text(verification.outcome || verification.status).toUpperCase()
  if (verification.passed !== true || !['PASS', 'PASSED', 'SUCCESS'].includes(outcome)) return { ok: false, reason: 'local_verification_not_passed', expectedFingerprint, item }
  return {
    ok: true,
    expectedFingerprint,
    item: { ...item, payload: { ...item.payload, idempotency_key: `delivery-candidate:${item.taskId}:${item.payload.commit_sha}`, delivery_candidate: true, verification } },
  }
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

export async function flushPendingDeliveries(repoRoot, { fetchImpl = fetch, homeDir = homedir() } = {}) {
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
  const plan = await inspectOutbox(repoRoot)
  const deliveries = plan.events.filter(item => item.type === 'delivery.record' && item.replayStatus === 'ready')
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
  const after = await inspectOutbox(repoRoot)
  const pending = after.events.filter(item => item.type === 'delivery.record').length
  return { total: deliveries.length, migrated: rows.length, sent, pending }
}
