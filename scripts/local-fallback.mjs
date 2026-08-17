import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const markerPath = repoRoot => join(resolve(repoRoot), '.cap/local-fallback.json')
const text = value => String(value || '').trim()

export async function activateLocalFallback(repoRoot = '.', { branch = '', taskId = '' } = {}) {
  const path = markerPath(repoRoot)
  const marker = {
    mode: 'local_fallback_explicit',
    branch: text(branch),
    taskId: text(taskId),
    selectedAt: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  return marker
}

export async function isLocalFallbackActive(repoRoot = '.', { branch = '', taskId = '' } = {}) {
  const marker = await readFile(markerPath(repoRoot), 'utf8').then(JSON.parse).catch(() => null)
  if (marker?.mode !== 'local_fallback_explicit') return false
  return text(marker.branch) === text(branch) && text(marker.taskId) === text(taskId)
}
