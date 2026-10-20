#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureContextBinding, inspectSemanticContext, loadContextManifest, readContained, validateRecoveryReceipt } from './cap-context-gate.mjs'
import { prepareContext } from './cap-context-preparation.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { checkpointDigest } from './cap-context-checkpoint.mjs'

const field = (text, name) => text.match(new RegExp(`^(?:- )?${name}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || ''
const noop = () => ({ continue: true, suppressOutput: true })
const blocked = code => ({ continue: false, stopReason: `Capital Agent context recovery blocked: ${code}. Refresh the reviewed checkpoint before continuing.`, systemMessage: `cap-context: ${code}` })
const keys = ['taskId', 'sessionId', 'runtimeSessionId', 'repo', 'branch', 'commit', 'stage']
const matches = (left, right) => keys.every(key => left?.[key] === right?.[key])
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

export function codexHooksConfig() {
  if (process.platform === 'win32') return { supported: false, reason: 'Configure the native Windows hook command with the host shell; POSIX registration is not portable to Windows.' }
  const command = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))}`
  const events = ['PreCompact', 'PostCompact', 'PreToolUse', 'PostToolUse']
  return { command, toml: events.map(event => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`).join('\n') }
}

// This is a native stdin callback, not a transcript watcher. The host's trust
// mechanism decides whether to execute it. Local receipts are not Server Gates.
export async function handleContextHook(input, { environment = process.env } = {}) {
  let lock, repo, recordPath
  try {
    const event = input?.hook_event_name
    if (!['PreCompact', 'PostCompact', 'PreToolUse', 'PostToolUse'].includes(event)) throw new Error('hook_event_invalid')
    if (!isAbsolute(input.cwd || '') || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input.session_id || '')) throw new Error('hook_identity_invalid')
    const inherited = environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID
    if (inherited && inherited !== input.session_id) throw new Error('hook_session_mismatch')
    const env = { ...environment, CODEX_THREAD_ID: input.session_id, CODEX_SESSION_ID: input.session_id }
    try { repo = await realpath(execFileSync('git', ['-C', input.cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
    catch { return noop() }
    // Global hooks must not intercept non-cap repositories or prevent bootstrap.
    try { await lstat(join(repo, '.cap', 'STATE.md')) }
    catch (cause) { if (cause.code === 'ENOENT') return noop(); throw cause }
    let state = await readContained(repo, '.cap/STATE.md')
    if (!field(state, 'task-id') || field(state, 'stage') === 'done') return noop()
    const rootBinding = await inspectSessionRoot({ repoRoot: repo, environment: env, capture: false, requireExisting: true })
    if (rootBinding.blocked) throw new Error(rootBinding.code)
    recordPath = `.cap/context/codex-hook-${createHash('sha256').update(input.session_id).digest('hex')}.json`
    let record
    try { record = JSON.parse(await readContained(repo, recordPath)) }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    if ((event === 'PreToolUse' || event === 'PostToolUse') && (!record || record.phase === 'delivered')) return noop()
    lock = await open(join(repo, '.cap/.context-hook.lock'), 'wx', 0o600)
    await lock.writeFile(`${process.pid}\n`)
    try { record = JSON.parse(await readContained(repo, recordPath)) }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    state = await readContained(repo, '.cap/STATE.md')
    // Acknowledgment proves delivery of the pre-tool payload, not freshness
    // after a tool that may legitimately edit sources, commit, or change stage.
    if (event === 'PostToolUse') {
      if (record?.phase === 'recovered' && record.injectingToolId === input.tool_use_id &&
        record.identity.runtimeSessionId === input.session_id && record.identity.taskId === field(state, 'task-id') && record.identity.sessionId === field(state, 'session-id')) {
        const receipt = JSON.parse(await readContained(repo, record.injectingReceiptPath))
        if (checkpointDigest(receipt) !== record.injectingReceiptDigest) throw new Error('hook_injected_receipt_changed')
        record.phase = 'delivered'
        await publishRecord(repo, recordPath, record)
      }
      return noop()
    }
    const { inspectBoundary } = await import('./cap-runtime.mjs')
    repo = (await inspectBoundary(input.cwd, { environment: env })).repo
    const binding = await captureContextBinding(repo, { environment: env })
    const snapshot = await loadContextManifest(repo, field(state, 'context-manifest'))
    if (snapshot.manifest.entry?.runtimeSessionId !== input.session_id) throw new Error('hook_checkpoint_session_unbound')
    if (event === 'PreCompact') {
      const gate = await inspectSemanticContext(repo, { environment: env })
      if (!gate.passed) throw new Error(gate.reason)
      record = { schemaVersion: 1, identity: Object.fromEntries(keys.map(key => [key, binding[key]])), event: `codex-native:${randomUUID()}`, turnId: input.turn_id, digest: snapshot.manifest.digest, phase: 'prepared' }
      const pending = await prepareContext(repo, { event: record.event, deferRecovery: true, environment: env })
      if (!pending.valid) throw new Error(pending.errors?.[0]?.code || 'hook_recovery_pending_failed')
      await publishRecord(repo, recordPath, record)
      return noop()
    }
    if (event === 'PostCompact' && (!record || record.phase === 'delivered' || record.turnId !== input.turn_id)) {
      // A real PostCompact callback is sufficient even if PreCompact was not
      // installed. The normal prepare preflight still checks the full snapshot.
      record = { schemaVersion: 1, identity: Object.fromEntries(keys.map(key => [key, binding[key]])), event: `codex-native:${randomUUID()}`, turnId: input.turn_id, digest: snapshot.manifest.digest, phase: 'prepared' }
      await publishRecord(repo, recordPath, record)
    }
    if (record && event === 'PreToolUse' &&
      (record.identity.taskId !== binding.taskId || record.identity.sessionId !== binding.sessionId)) throw new Error('hook_compaction_binding_mismatch')
    if (!record || !matches(record.identity, binding)) throw new Error('hook_compaction_binding_mismatch')
    if (event === 'PostCompact') {
      if (record.phase === 'prepared') {
        const result = await prepareContext(repo, { event: record.event, budgetTokens: snapshot.manifest.hotBudgetTokens, environment: env })
        if (!result.valid) throw new Error(result.errors?.[0]?.code || 'hook_recovery_failed')
        record.phase = 'recovered'
        await publishRecord(repo, recordPath, record)
      } else if (binding.recoveryEvent !== record.event || !(await inspectSemanticContext(repo, { environment: env })).passed) throw new Error('hook_recovery_stale')
      return { ...noop(), systemMessage: `Capital Agent restored ${record.event}; protected context will be injected before the next tool call.` }
    }
    if (record.phase === 'prepared') throw new Error('hook_postcompact_missing')
    if (record.phase === 'delivered') return noop()
    if (binding.recoveryEvent !== record.event || !(await inspectSemanticContext(repo, { environment: env })).passed) throw new Error('hook_recovery_stale')
    const receipt = JSON.parse(await readContained(repo, binding.recoveryReceipt))
    if (!validateRecoveryReceipt(receipt, snapshot.manifest, snapshot.checkpoint, binding)) throw new Error('hook_receipt_invalid')
    if (!input.tool_use_id) throw new Error('hook_tool_identity_missing')
    record.injectingToolId = input.tool_use_id
    record.injectingReceiptPath = binding.recoveryReceipt
    record.injectingReceiptDigest = checkpointDigest(receipt)
    await publishRecord(repo, recordPath, record)
    return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: JSON.stringify({ instruction: 'Read restored hot atoms and needed warm sources before continuing. Native compact state is opaque; this receipt is local replay evidence only.', event: record.event, hot: receipt.hot, warmRefs: receipt.warmRefs }) } }
  } catch (cause) {
    const code = cause.code === 'EEXIST' ? 'hook_writer_busy' : /^[a-z][a-z0-9_]+$/.test(cause.message) ? cause.message : /^[a-z][a-z0-9_]+$/.test(cause.code || '') ? cause.code : 'hook_internal_error'
    // PreToolUse is a security boundary: recovery failures must deny the
    // original tool. Repair happens through a subsequent trusted lifecycle
    // callback, never by allowing an arbitrary shell/write tool to continue.
    return blocked(code)
  } finally {
    if (lock) { await lock.close(); await rm(join(repo, '.cap/.context-hook.lock'), { force: true }) }
  }
}

async function publishRecord(repo, path, value) {
  const target = join(repo, path)
  try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('hook_record_unsafe') }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  const temporary = `${target}.${randomUUID()}.tmp`
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, target) }
  finally { await rm(temporary, { force: true }) }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'config') process.stdout.write(`${JSON.stringify(codexHooksConfig(), null, 2)}\n`)
  else {
    let raw = ''
    try {
      for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('hook_input_too_large') }
      process.stdout.write(`${JSON.stringify(await handleContextHook(JSON.parse(raw)))}\n`)
    } catch { process.stdout.write(`${JSON.stringify(blocked('hook_input_invalid'))}\n`) }
  }
}
