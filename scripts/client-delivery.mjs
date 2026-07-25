import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
      verification: { source: 'client_post_commit', pending: true },
    },
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
  await appendFile(join(repoRoot, '.cap/pending-deliveries.jsonl'), `${JSON.stringify(item)}\n`)
}

export async function flushPendingDeliveries(repoRoot, { fetchImpl = fetch, homeDir = homedir() } = {}) {
  const path = join(repoRoot, '.cap/pending-deliveries.jsonl')
  const raw = await readFile(path, 'utf8').catch(() => '')
  const rows = raw.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  if (!rows.length) return { total: 0, sent: 0, pending: 0 }
  const config = await readClientConfig(homeDir); const pending = []; let sent = 0
  for (const row of rows) {
    if (await sendCommitDelivery({ serverUrl: config.CAPITAL_AGENT_SERVER_URL, userKey: config.CAPITAL_AGENT_USER_KEY, taskId: row.taskId, payload: row.payload, fetchImpl })) sent++
    else pending.push(row)
  }
  const temp = `${path}.tmp`
  await writeFile(temp, pending.map(item => JSON.stringify(item)).join('\n') + (pending.length ? '\n' : ''))
  await rename(temp, path)
  return { total: rows.length, sent, pending: pending.length }
}
