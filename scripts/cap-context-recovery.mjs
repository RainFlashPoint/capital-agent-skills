import { createHash, randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { captureContextBinding, loadContextManifest, readContained } from './cap-context-gate.mjs'
import { validateManifest } from './cap-context-checkpoint.mjs'

const field = (text, key) => text.match(new RegExp(`^(?:- )?${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const setField = (text, key, value) => new RegExp(`^(?:- )?${key}:.*$`, 'm').test(text) ? text.replace(new RegExp(`^(?:- )?${key}:.*$`, 'm'), `${key}: ${value}`) : `${text.trimEnd()}\n${key}: ${value}\n`

// Called only when the agent receives a visible summary/resume or host event.
// Emitting hot atoms is local replay evidence, never a claim of provider success.
export async function observeContextResume(repo, { event = `visible-resume:${randomUUID()}`, environment = process.env } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(event) || event === 'none') throw new Error('context_recovery_event_invalid')
  const { inspectBoundary } = await import('./cap-runtime.mjs')
  repo = (await inspectBoundary(repo, { environment })).repo
  const state = await readContained(repo, '.cap/STATE.md')
  const binding = await captureContextBinding(repo, { environment })
  let snapshot, errors = []
  try {
    snapshot = await loadContextManifest(repo, field(state, 'context-manifest'))
    errors = validateManifest(snapshot.manifest, snapshot).errors
    for (const key of ['taskId', 'repo', 'branch', 'commit', 'stage']) if (snapshot.manifest.identity[key] !== binding[key]) errors.push({ code: 'context_identity_changed', path: key })
    if (snapshot.manifest.entry?.sessionId !== binding.sessionId) errors.push({ code: 'context_identity_changed', path: 'sessionId' })
    if (snapshot.manifest.entry?.sourceFingerprint !== binding.sourceFingerprint || snapshot.manifest.entry?.semanticsHash !== binding.semanticsHash) errors.push({ code: 'context_sources_changed', path: 'entry' })
    if (field(state, 'provider-compaction') === 'succeeded' && (field(state, 'provider-compaction-event') !== event || snapshot.manifest.provider.eventRef !== event)) errors.push({ code: 'context_provider_event_mismatch', path: 'provider.eventRef' })
    if (['requested', 'running', 'failed'].includes(field(state, 'provider-compaction')) || ['requested', 'running', 'failed'].includes(snapshot.manifest.provider.status)) errors.push({ code: 'context_provider_pending', path: 'provider' })
  } catch { errors.push({ code: 'context_manifest_invalid', path: 'context-manifest' }) }
  let next = setField(setField(state, 'context-recovery-event', event), 'context-recovery-receipt', 'none')
  let receipt = null
  if (!errors.length) {
    const { manifest, checkpoint } = snapshot
    receipt = { schemaVersion: 1, event, taskId: binding.taskId, sessionId: binding.sessionId, repo: binding.repo, branch: binding.branch, commit: binding.commit, digest: manifest.digest, planDigest: hash(manifest.plan), hot: manifest.plan.hot.map(id => checkpoint.atoms.find(atom => atom.id === id)), warmRefs: manifest.plan.warm.flatMap(id => checkpoint.atoms.find(atom => atom.id === id).sourceRefs) }
    const path = `.cap/context/recovery-${randomUUID()}.json`
    // readContained above verified the context directory's no-symlink chain.
    await writeFile(join(repo, path), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    next = setField(next, 'context-recovery-receipt', path)
  }
  const temporary = join(repo, '.cap', `.STATE-resume-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: 0o600 })
    if (await readContained(repo, '.cap/STATE.md') !== state) throw new Error('context_state_changed')
    await rename(temporary, join(repo, '.cap/STATE.md'))
  } finally { await rm(temporary, { force: true }) }
  return { valid: !errors.length, event, errors, recovery: receipt, nextAction: errors.length ? 'repair original sources and manifest, then replay the same event' : 'read hot atoms, resolve required warm sources, bind a new manifest and rerun the full context guard' }
}
