#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureContextBinding, inspectSemanticContext, loadContextManifest, nativeHookPaths, readContained, validateNativeRecovery } from './cap-context-gate.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { checkpointDigest, contextReplay } from './cap-context-checkpoint.mjs'

const field = (text, name) => text.match(new RegExp(`^(?:- )?${name}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const noop = () => ({ continue: true })
const keys = ['taskId', 'sessionId', 'runtimeSessionId', 'repo', 'branch', 'commit', 'stage', 'sourceFingerprint', 'semanticsHash']
const stableKeys = ['taskId', 'sessionId', 'runtimeSessionId', 'repo', 'branch']
const matches = (left, right, fields = keys) => fields.every(key => left?.[key] === right?.[key])
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const scriptPath = fileURLToPath(import.meta.url)
const codeOf = cause => cause.code === 'EEXIST' ? 'hook_writer_busy' : /^[a-z][a-z0-9_]+$/.test(cause.message) ? cause.message : /^[a-z][a-z0-9_]+$/.test(cause.code || '') ? cause.code : 'hook_internal_error'
const recoveryCommand = (repo, sessionId, manifestPath) => `${quote(process.execPath)} ${quote(scriptPath)} recover ${quote(repo)} --session-id ${quote(sessionId)} --reviewed-manifest ${quote(manifestPath)}`

function feedback(code, input = {}, repo = '', manifestPath = '') {
  const phase = input.hook_event_name === 'PreCompact' ? 'preparation' : input.hook_event_name === 'PreToolUse' ? 'tool gate' : 'recovery'
  const recovery = code === 'hook_checkpoint_owned_by_other_session' || code === 'hook_compaction_binding_mismatch'
    ? 'This checkpoint belongs to another runtime/Task. Use that owning chat, or a separate worktree with a reviewed handoff and its own Task. Do not rebind shared STATE.'
    : `After reviewing the original sources, run the exact scoped recovery command (also supported through the tool gate): ${recoveryCommand(repo || input.cwd || '.', input.session_id || '', manifestPath || '<current .cap/context/manifest path>')}. Stale/invalid sources must first be repaired by the owning STATE writer; do not overwrite another session's checkpoint.`
  return `Capital Agent context ${phase} blocked: ${code}. Chat and native compaction remain available; business tools remain denied until recovery is validated. ${recovery}`
}

function failure(code, input, repo, manifestPath) {
  const message = feedback(code, input, repo, manifestPath)
  // continue:false cancels compact before the model can explain or recover.
  // Tool denial has its own supported contract and must not cancel the chat.
  if (input?.hook_event_name === 'PreToolUse') return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  }
  return { continue: true, systemMessage: message }
}

export function codexHooksConfig() {
  if (process.platform === 'win32') return { supported: false, reason: 'Configure the native Windows hook command with the host shell; POSIX registration is not portable to Windows.' }
  const command = `${quote(process.execPath)} ${quote(scriptPath)}`
  const events = ['PreCompact', 'PostCompact', 'PreToolUse', 'PostToolUse']
  return { command, toml: events.map(event => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`).join('\n') }
}

async function optionalRecord(repo, path) {
  try { return JSON.parse(await readContained(repo, path)) }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
}

async function checkSnapshotOwnership(repo, manifestPath, binding) {
  if (!manifestPath || manifestPath === 'none') return
  if (!manifestPath.startsWith('.cap/context/')) throw new Error('context_manifest_path')
  const manifest = JSON.parse(await readContained(repo, manifestPath))
  const entry = manifest.entry
  if (entry?.runtimeSessionId && entry.runtimeSessionId !== 'none' && entry.runtimeSessionId !== binding.runtimeSessionId) throw new Error('hook_checkpoint_owned_by_other_session')
  if (entry && !matches(entry, binding, stableKeys.filter(key => key !== 'runtimeSessionId'))) throw new Error('hook_compaction_binding_mismatch')
}

async function currentSnapshot(repo, state, env, sessionId, { allowLegacy = false } = {}) {
  const manifestPath = field(state, 'context-manifest')
  const snapshot = await loadContextManifest(repo, manifestPath)
  const runtime = snapshot.manifest.entry?.runtimeSessionId
  if (runtime && runtime !== 'none' && runtime !== sessionId) throw new Error('hook_checkpoint_owned_by_other_session')
  if ((!runtime || runtime === 'none') && !allowLegacy) throw new Error('hook_checkpoint_session_unbound')
  const gate = await inspectSemanticContext(repo, { environment: env, skipNativeRecovery: true })
  if (!gate.passed) throw new Error(gate.reason)
  const binding = await captureContextBinding(repo, { environment: env })
  if (gate.manifest !== manifestPath || gate.digest !== snapshot.manifest.digest || await readContained(repo, '.cap/STATE.md') !== state ||
    !matches(snapshot.manifest.entry, binding, keys.filter(key => key !== 'runtimeSessionId'))) throw new Error('hook_recovery_stale')
  return { ...snapshot, manifestPath, binding }
}

function prepared(snapshot, turnId) {
  return { schemaVersion: 2, identity: Object.fromEntries(keys.map(key => [key, snapshot.binding[key]])), event: `codex-native:${randomUUID()}`, turnId, manifestPath: snapshot.manifestPath, manifestDigest: checkpointDigest(snapshot.manifest), digest: snapshot.manifest.digest, phase: 'prepared' }
}

async function publishPending(repo, paths, record) {
  // Publish intent first. A crash before the full record remains fail-closed.
  await publishRecord(repo, paths.pending, { schemaVersion: 2, identity: record.identity, event: record.event })
  await publishRecord(repo, paths.record, record)
}

function recoverRecord(record, snapshot) {
  record.recovery = { schemaVersion: 2, event: record.event, identity: record.identity, manifestPath: record.manifestPath, manifestDigest: record.manifestDigest, digest: record.digest, planDigest: checkpointDigest(snapshot.manifest.plan), ...contextReplay(snapshot.checkpoint, snapshot.manifest.plan) }
  record.recoveryDigest = checkpointDigest(record.recovery)
  record.phase = 'recovered'
  return record
}

function verifyRecord(record, pending, snapshot) {
  if (record?.schemaVersion !== 2 || pending?.schemaVersion !== 2 || pending.event !== record.event || !matches(pending.identity, record.identity) || !matches(record.identity, snapshot.binding)) throw new Error('hook_compaction_binding_mismatch')
  if (record.manifestPath !== snapshot.manifestPath || record.manifestDigest !== checkpointDigest(snapshot.manifest) || record.digest !== snapshot.manifest.digest) throw new Error('hook_recovery_stale')
}

function verifyReplay(record, snapshot) {
  if (!validateNativeRecovery(record, snapshot)) throw new Error('hook_receipt_invalid')
}

// Native lifecycle never writes shared STATE, manifests or recovery pointers.
// Each runtime owns its marker, replay receipt and delivery acknowledgment.
export async function handleContextHook(input, { environment = process.env } = {}) {
  let lock, repo, paths, record, binding, manifestPath, state
  const event = input?.hook_event_name
  try {
    if (!['PreCompact', 'PostCompact', 'PreToolUse', 'PostToolUse'].includes(event)) throw new Error('hook_event_invalid')
    if (!isAbsolute(input.cwd || '') || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input.session_id || '')) throw new Error('hook_identity_invalid')
    const inherited = environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID
    if (inherited && inherited !== input.session_id) throw new Error('hook_session_mismatch')
    const env = { ...environment, CODEX_THREAD_ID: input.session_id, CODEX_SESSION_ID: input.session_id }
    try { repo = await realpath(execFileSync('git', ['-C', input.cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
    catch { return noop() }
    try { await lstat(join(repo, '.cap', 'STATE.md')) }
    catch (cause) { if (cause.code === 'ENOENT') return noop(); throw cause }
    state = await readContained(repo, '.cap/STATE.md')
    if (!field(state, 'task-id') || field(state, 'stage') === 'done') return noop()
    manifestPath = field(state, 'context-manifest')
    const rootBinding = await inspectSessionRoot({ repoRoot: repo, environment: env, capture: false, requireExisting: true })
    if (rootBinding.blocked) throw new Error(rootBinding.code)
    // This bounded read also verifies the context directory before publication.
    binding = await captureContextBinding(repo, { environment: env })
    paths = nativeHookPaths(input.session_id)
    if (event === 'PreToolUse') await checkSnapshotOwnership(repo, manifestPath, binding)
    // Only this exact canonical command is a repair route. No general shell,
    // write tool, flags, suffixes, other session or other manifest are admitted.
    if (event === 'PreToolUse' && input.tool_name === 'Bash' &&
      input.tool_input?.command === recoveryCommand(repo, input.session_id, manifestPath)) {
      await currentSnapshot(repo, state, env, input.session_id, { allowLegacy: true })
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    }
    record = await optionalRecord(repo, paths.record)
    let pending = await optionalRecord(repo, paths.pending)
    if (event === 'PostToolUse' && !record) return noop()
    if ((event === 'PreToolUse' || event === 'PostToolUse') && record?.phase === 'delivered') {
      if (!matches(record.identity, binding, stableKeys)) throw new Error('hook_compaction_binding_mismatch')
      if (record.schemaVersion === 2 && (!pending || pending.event !== record.event || !matches(pending.identity, record.identity))) throw new Error('hook_recovery_marker_invalid')
      return noop()
    }
    if (event === 'PreToolUse' && !record) {
      if (pending) throw new Error('hook_recovery_record_missing')
      const recoveryEvent = field(state, 'context-recovery-event')
      const recoveryReceipt = field(state, 'context-recovery-receipt')
      if (recoveryEvent.startsWith('codex-native:') || (recoveryEvent && recoveryEvent !== 'none' && (!recoveryReceipt || recoveryReceipt === 'none'))) throw new Error('hook_recovery_record_missing')
      return noop()
    }
    // Per-session lock: independent chats cannot steal or stall each other.
    lock = await open(join(repo, `${paths.record}.lock`), 'wx', 0o600)
    await lock.writeFile(`${process.pid}\n`)
    record = await optionalRecord(repo, paths.record)
    pending = await optionalRecord(repo, paths.pending)
    state = await readContained(repo, '.cap/STATE.md')
    binding = await captureContextBinding(repo, { environment: env })
    if (event === 'PostToolUse') {
      if (record?.phase === 'recovered' && record.injectingToolId === input.tool_use_id) {
        if (!matches(record.identity, binding, stableKeys)) throw new Error('hook_compaction_binding_mismatch')
        if (checkpointDigest(record.recovery) !== record.injectingReceiptDigest) throw new Error('hook_injected_receipt_changed')
        record.phase = 'delivered'
        await publishRecord(repo, paths.record, record)
      }
      return noop()
    }
    if (record?.phase === 'blocked' && event === 'PreToolUse') throw new Error(record.failureCode)
    // Legacy entries require explicit review; an admission applies only to this
    // immutable manifest in this session, never to the shared binding.
    const allowLegacy = record?.legacyReviewed === true && record.schemaVersion === 2
    const snapshot = await currentSnapshot(repo, state, env, input.session_id, { allowLegacy })
    if (event === 'PreCompact') {
      const next = prepared(snapshot, input.turn_id)
      if (allowLegacy && record.manifestPath === next.manifestPath && record.manifestDigest === next.manifestDigest && matches(record.identity, snapshot.binding)) next.legacyReviewed = true
      else if (!snapshot.manifest.entry?.runtimeSessionId || snapshot.manifest.entry.runtimeSessionId === 'none') throw new Error('hook_checkpoint_session_unbound')
      await publishPending(repo, paths, next)
      return noop()
    }
    if (event === 'PostCompact' && (!record || record.schemaVersion !== 2 || record.phase === 'delivered' || record.turnId !== input.turn_id)) {
      const next = prepared(snapshot, input.turn_id)
      if (allowLegacy && record.manifestPath === next.manifestPath && record.manifestDigest === next.manifestDigest && matches(record.identity, snapshot.binding)) next.legacyReviewed = true
      else if (!snapshot.manifest.entry?.runtimeSessionId || snapshot.manifest.entry.runtimeSessionId === 'none') throw new Error('hook_checkpoint_session_unbound')
      record = next
      await publishPending(repo, paths, record)
      pending = await optionalRecord(repo, paths.pending)
    }
    verifyRecord(record, pending, snapshot)
    if (event === 'PostCompact') {
      if (record.phase === 'blocked') throw new Error(record.failureCode)
      if (record.phase === 'prepared') {
        recoverRecord(record, snapshot)
        await publishRecord(repo, paths.record, record)
      } else verifyReplay(record, snapshot)
      return { continue: true, systemMessage: `Capital Agent restored ${record.event}; protected context will be injected before the next tool call.` }
    }
    if (record.phase === 'prepared') throw new Error('hook_postcompact_missing')
    if (record.phase !== 'recovered') throw new Error('hook_recovery_stale')
    verifyReplay(record, snapshot)
    if (!input.tool_use_id) throw new Error('hook_tool_identity_missing')
    record.injectingToolId = input.tool_use_id
    record.injectingReceiptDigest = checkpointDigest(record.recovery)
    await publishRecord(repo, paths.record, record)
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: JSON.stringify({ instruction: 'Read restored hot atoms and needed warm sources before continuing. Native compact state is opaque; this receipt is local replay evidence only.', event: record.event, hot: record.recovery.hot, warmRefs: record.recovery.warmRefs }) } }
  } catch (cause) {
    const code = codeOf(cause)
    // Preserve a durable session-only quarantine even when the shared snapshot
    // cannot be prepared. Never publish another runtime's semantics into it.
    if (lock && paths && binding && ['PreCompact', 'PostCompact'].includes(event)) {
      const blockedRecord = { schemaVersion: 2, identity: Object.fromEntries(keys.map(key => [key, binding[key]])), event: record?.schemaVersion === 2 ? record.event : `codex-native:${randomUUID()}`, turnId: input.turn_id, phase: 'blocked', failureCode: code, manifestPath }
      try { await publishPending(repo, paths, blockedRecord) } catch { /* The visible denial still reports failure; no shared pointer is changed. */ }
    }
    return failure(code, input, repo, manifestPath)
  } finally {
    if (lock) { await lock.close(); await rm(join(repo, `${paths.record}.lock`), { force: true }) }
  }
}

// Explicit recovery is run from a trusted terminal after source review. It
// admits legacy snapshots only into this runtime's private replay lifecycle.
export async function recoverContextHook(candidate, { sessionId, reviewedManifest, environment = process.env } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(sessionId || '')) throw new Error('hook_identity_invalid')
  const inherited = environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID
  if (inherited && inherited !== sessionId) throw new Error('hook_session_mismatch')
  const env = { ...environment, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId }
  const { inspectBoundary } = await import('./cap-runtime.mjs')
  const repo = (await inspectBoundary(candidate, { environment: env })).repo
  const state = await readContained(repo, '.cap/STATE.md')
  if (!reviewedManifest || reviewedManifest !== field(state, 'context-manifest')) throw new Error('hook_reviewed_manifest_changed')
  const paths = nativeHookPaths(sessionId)
  // Validate directory containment before opening the writer lock.
  await readContained(repo, reviewedManifest)
  const lock = await open(join(repo, `${paths.record}.lock`), 'wx', 0o600)
  try {
    const snapshot = await currentSnapshot(repo, state, env, sessionId, { allowLegacy: true })
    const record = prepared(snapshot, `reviewed:${randomUUID()}`)
    record.legacyReviewed = !snapshot.manifest.entry?.runtimeSessionId || snapshot.manifest.entry.runtimeSessionId === 'none'
    recoverRecord(record, snapshot)
    await publishPending(repo, paths, record)
    return { valid: true, sessionId, event: record.event, record: paths.record, sharedStateChanged: false, nextAction: 'Retry in the owning chat; exact hot replay will be delivered before the next business tool.' }
  } finally { await lock.close(); await rm(join(repo, `${paths.record}.lock`), { force: true }) }
}

async function publishRecord(repo, path, value) {
  const target = join(repo, path)
  // Verify every parent; a global callback must not write through a symlink.
  await readContained(repo, '.cap/STATE.md')
  const directory = await lstat(join(repo, '.cap/context'))
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('hook_record_unsafe')
  try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('hook_record_unsafe') }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  const temporary = `${target}.${randomUUID()}.tmp`
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, target) }
  finally { await rm(temporary, { force: true }) }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'config') process.stdout.write(`${JSON.stringify(codexHooksConfig(), null, 2)}\n`)
  else if (process.argv[2] === 'recover') {
    const args = process.argv.slice(3)
    const option = key => args[args.indexOf(key) + 1]
    try { process.stdout.write(`${JSON.stringify(await recoverContextHook(args[0], { sessionId: option('--session-id'), reviewedManifest: option('--reviewed-manifest') }), null, 2)}\n`) }
    catch (cause) { process.stdout.write(`${JSON.stringify({ valid: false, code: codeOf(cause), nextAction: feedback(codeOf(cause), { hook_event_name: 'PostCompact', cwd: args[0], session_id: option('--session-id') }, args[0], option('--reviewed-manifest')) })}\n`); process.exitCode = 1 }
  } else {
    let raw = '', input
    try {
      for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('hook_input_too_large') }
      input = JSON.parse(raw)
      process.stdout.write(`${JSON.stringify(await handleContextHook(input))}\n`)
    } catch {
      // Malformed native metadata cannot be safely routed. Exit 2 denies a
      // PreToolUse at the host boundary and reports a visible callback error.
      process.stderr.write('Capital Agent context hook_input_invalid; inspect the native callback payload.\n')
      process.exitCode = 2
    }
  }
}
