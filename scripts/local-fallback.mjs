import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const markerPath = repoRoot => join(resolve(repoRoot), '.cap/local-fallback.json')
const text = value => String(value || '').trim()
const sessionKeys = ['CAPITAL_AGENT_RUNTIME_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']

function sessionIdentity(environment = process.env) {
  for (const key of sessionKeys) {
    const value = text(environment?.[key])
    if (value) return `${key}:${value}`
  }
  return ''
}

export async function activateLocalFallback(repoRoot = '.', { branch = '', taskId = '', environment = process.env } = {}) {
  const path = markerPath(repoRoot)
  const identity = sessionIdentity(environment)
  if (!identity) return null
  const marker = {
    mode: 'local_fallback_explicit',
    branch: text(branch),
    taskId: text(taskId),
    sessionIdentity: identity,
    selectedAt: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  return marker
}

export async function revokeLocalFallback(repoRoot = '.') {
  await rm(markerPath(repoRoot), { force: true })
}

export async function isLocalFallbackActive(repoRoot = '.', { branch = '', taskId = '', environment = process.env } = {}) {
  const marker = await readFile(markerPath(repoRoot), 'utf8').then(JSON.parse).catch(() => null)
  if (marker?.mode !== 'local_fallback_explicit') return false
  const currentSession = sessionIdentity(environment)
  if (!currentSession || !marker.sessionIdentity) return false
  const sessionMatches = marker.sessionIdentity === currentSession
  return text(marker.branch) === text(branch) && text(marker.taskId) === text(taskId) && sessionMatches
}
