import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContextBinding, captureCoverageRequirements, inspectSemanticContext } from './cap-context-gate.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { prepareContext } from './cap-context-preparation.mjs'
import { inspectTaskContext } from './cap-runtime.mjs'
import { handleContextHook } from './cap-context-hooks.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const environment = { CAPITAL_AGENT_MODE: 'local', PATH: process.env.PATH, HOME: process.env.HOME }
async function fixture(t, stage = 'implement') {
  const repo = mkdtempSync(join(tmpdir(), 'cap-prepare-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(join(repo, '.cap/context'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), '.cap/\n')
  writeFileSync(join(repo, 'source.js'), 'export const value = 1\n')
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: repo })
  writeFileSync(join(repo, '.cap/STATE.md'), `stage: ${stage}\nstatus: in-progress\ntask-id: local-fixture\nsession-id: local-session\nbranch: main\ncontext-pressure: unknown\nprovider-compaction: unavailable\n\n## External operation authorization\n- scope: local changes only; no push\n- invalidates-on: target changes\n\n## Next action\n-> Implement the approved change\n`)
  const f = await inspectContextFingerprint(repo)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, '.cap/task-context.md'), `- intent: Preserve behavior\n- branch: main\n- head: ${head}\n- index-fingerprint: ${f.index}\n- worktree-fingerprint: ${f.worktree}\n- untracked-fingerprint: ${f.untracked}\n- profile-used-as: index-only\n\n## Entry points\n- \`source.js\`\n## Call chain and data flow\n- source to consumer\n## Similar implementations\n- current implementation\n## History usage\n- candidates: none\n- outcome: not_used\n- reason: no matches\n- plan-impact: none\n- verification-impact: none\n## Tests and environment\n- \`source.js\`\n## Evidence sources\n- \`source.js\`\n## External operation boundary\n- environment: local\n- authorization: local only\n- minimum-impact: source.js\n- recovery: Git\n- invalidates-on: target changes\n## Impact surface\n- modify: \`source.js\`\n## Profile drift\n- none\n`)
  const binding = await captureContextBinding(repo, { environment })
  const identity = Object.fromEntries(['taskId', 'repo', 'branch', 'commit', 'stage'].map(k => [k, binding[k]]))
  const requirements = await captureCoverageRequirements(repo, { environment })
  const atoms = requirements.map((r, i) => ({ id: `fact-${i}`, type: r.types[0], assertion: `Keep fixture ${r.label}`, protection: r.minProtection, priority: 90, scope: identity, sourceRefs: [r.sourceRef], trust: 'repository-observed', status: 'active', certainty: 'confirmed', recoverability: 'source-backed', invalidation: [], supersedes: [] }))
  atoms.push({ ...atoms[0], id: 'acceptance', type: 'acceptance_criterion', protection: 'P1', assertion: 'Keep source behavior' })
  const checkpoint = { schemaVersion: 1, identity, atoms, coverage: requirements.map((r, i) => ({ id: r.id, atomIds: [`fact-${i}`] })) }
  const path = '.cap/context/checkpoint-one.json'
  writeFileSync(join(repo, path), JSON.stringify(checkpoint))
  return { repo, checkpoint, path }
}

test('prepare duplicate replay keeps exact coverage and rejects edited alias/source bindings', async t => {
  const { repo, path, checkpoint } = await fixture(t)
  const original = checkpoint.atoms[0]
  checkpoint.atoms.push({ ...original, id: 'duplicate-intent', sourceRefs: [...original.sourceRefs, 'user-message:duplicate'] })
  writeFileSync(join(repo, path), JSON.stringify(checkpoint))
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'host:duplicates', environment })
  assert.equal(result.valid, true, JSON.stringify(result))
  const group = result.recovery.hot.find(atom => atom.coveredAtomIds?.includes('duplicate-intent'))
  assert.deepEqual(group.coveredAtomIds, ['duplicate-intent', original.id].sort())
  assert.ok(group.sourceRefs.includes('user-message:duplicate'))
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const receiptPath = join(repo, state.match(/^context-recovery-receipt: (.+)$/m)[1])
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  receipt.hot.find(atom => atom.coveredAtomIds).coveredAtomIds.pop()
  writeFileSync(receiptPath, JSON.stringify(receipt))
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, false)
})

test('prepare publishes a reviewed initial snapshot and reuses an unchanged binding', async t => {
  for (const event of [undefined, 'visible-resume:unchanged']) {
    const { repo, path } = await fixture(t)
    const options = { budgetTokens: 20000, environment, event }
    const first = await prepareContext(repo, { checkpointPath: path, ...options })
    assert.equal(first.valid, true, JSON.stringify(first))
    assert.equal(first.reused, false)
    assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
    const snapshot = () => [join(repo, '.cap/STATE.md'), ...readdirSync(join(repo, '.cap/context')).sort().map(name => join(repo, '.cap/context', name))]
      .map(file => ({ file, content: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs }))
    const before = snapshot()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Omitting the path exercises reuse of the checkpoint published in STATE.
      const next = await prepareContext(repo, options)
      assert.equal(next.valid, true, JSON.stringify(next))
      assert.equal(next.reused, true)
      assert.equal(next.manifest, first.manifest)
      assert.equal(next.digest, first.digest)
      assert.deepEqual(snapshot(), before)
    }
  }
})

test('unbound legacy runtime accepts a host while a bound runtime rejects another session', async t => {
  const { repo, path } = await fixture(t)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })).valid, true)
  const host = { ...environment, CODEX_THREAD_ID: 'host-one', CAPITAL_AGENT_SESSION_LOCK_DIR: join(repo, '.cap/session-locks') }
  await inspectSessionRoot({ repoRoot: repo, environment: host, capture: true })
  assert.equal((await inspectSemanticContext(repo, { environment: host })).passed, true)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment: host })).valid, true)
  const otherHost = { ...host, CODEX_THREAD_ID: 'host-two' }
  await inspectSessionRoot({ repoRoot: repo, environment: otherHost, capture: true })
  const changedHost = await inspectSemanticContext(repo, { environment: otherHost })
  assert.equal(changedHost.passed, false)
  assert.equal(changedHost.reason, 'context_identity_changed')
})

test('prepare reuses content-identical atoms when only the source binding changes', async t => {
  const { repo, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))

  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  const fingerprints = await inspectContextFingerprint(repo)
  const taskContextPath = join(repo, '.cap/task-context.md')
  let taskContext = readFileSync(taskContextPath, 'utf8')
  taskContext = taskContext
    .replace(/^- index-fingerprint:.*$/m, `- index-fingerprint: ${fingerprints.index}`)
    .replace(/^- worktree-fingerprint:.*$/m, `- worktree-fingerprint: ${fingerprints.worktree}`)
    .replace(/^- untracked-fingerprint:.*$/m, `- untracked-fingerprint: ${fingerprints.untracked}`)
  writeFileSync(taskContextPath, taskContext)

  const second = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(second.valid, true, JSON.stringify(second))
  assert.notEqual(second.manifest, first.manifest)
  const firstManifest = JSON.parse(readFileSync(join(repo, first.manifest), 'utf8'))
  const secondManifest = JSON.parse(readFileSync(join(repo, second.manifest), 'utf8'))
  assert.equal(secondManifest.atomLog.path, firstManifest.atomLog.path)
  assert.equal(readdirSync(join(repo, '.cap/context')).filter(name => name.startsWith('atoms-')).length, 1)
})

test('one prepare call replays a visible resume and binds its exact receipt', async t => {
  const { repo, path } = await fixture(t)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })).valid, true)
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:one', environment })
  assert.equal(result.valid, true, JSON.stringify(result))
  assert.ok(result.recovery.hot.length)
  assert.equal(result.recovery.event, 'visible-resume:one')
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
  // Receipt tampering cannot be hidden by cursor publication.
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const receiptPath = state.match(/^context-recovery-receipt: (.+)$/m)[1]
  const receipt = JSON.parse(readFileSync(join(repo, receiptPath), 'utf8'))
  receipt.hot[0].assertion = 'tampered replay'
  writeFileSync(join(repo, receiptPath), JSON.stringify(receipt))
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, false)
})

for (const stage of ['understand', 'define']) {
  test(`${stage} prepare replays a visible resume through the full preflight`, async t => {
    const { repo, path } = await fixture(t, stage)
    assert.equal((await inspectTaskContext(repo, { stage, checkSemantic: false, environment })).ok, true)
    const initial = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
    assert.equal(initial.valid, true, JSON.stringify(initial))
    const recovered = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: `visible-resume:${stage}`, environment })
    assert.equal(recovered.valid, true, JSON.stringify(recovered))
    assert.equal(recovered.recovery.event, `visible-resume:${stage}`)
    assert.ok(recovered.recovery.hot.length)
    assert.equal(JSON.parse(readFileSync(join(repo, recovered.manifest), 'utf8')).identity.stage, stage)
    assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
  })
}

for (const [storedStage, canonicalStage] of [['map', 'understand'], ['shape', 'define'], ['cap-define', 'define']]) {
  test(`${storedStage} prepare uses the canonical stage for visible recovery`, async t => {
    const { repo, path } = await fixture(t, storedStage)
    const initial = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
    assert.equal(initial.valid, true, JSON.stringify(initial))
    const recovered = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: `visible-resume:${storedStage}`, environment })
    assert.equal(recovered.valid, true, JSON.stringify(recovered))
    assert.equal(JSON.parse(readFileSync(join(repo, recovered.manifest), 'utf8')).identity.stage, canonicalStage)
    assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
  })
}

test('define recovery cannot reuse a checkpoint after authorization changes', async t => {
  const { repo, path } = await fixture(t, 'define')
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })).valid, true)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace('- scope: local changes only; no push', '- scope: local changes and remote push'))
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:scope-changed', environment })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(error => error.code === 'semantic_coverage_incomplete' || error.code === 'semantic_coverage_stale'), JSON.stringify(result.errors))
  assert.match(readFileSync(statePath, 'utf8'), /context-recovery-event: visible-resume:scope-changed/)
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, false)
})

test('reconnaissance still rejects an unknown lifecycle stage', async t => {
  const { repo } = await fixture(t)
  await assert.rejects(inspectTaskContext(repo, { stage: 'invented', checkSemantic: false, environment }), { code: 'unknown_stage' })
})

test('a normal successor after recovery is replayed and published without manual rebinding', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:two', environment })).valid, true)
  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'extra-detail', type: 'constraint', protection: 'P2', assertion: 'New implementation detail' })
  const nextPath = '.cap/context/checkpoint-two.json'
  writeFileSync(join(repo, nextPath), JSON.stringify(successor))
  const result = await prepareContext(repo, { checkpointPath: nextPath, budgetTokens: 20000, environment })
  assert.equal(result.valid, true, JSON.stringify(result))
  assert.equal(result.recovery.event, 'visible-resume:two')
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
})

test('preflight reports all defects, records visible event and does not publish on failure', async t => {
  const { repo, path } = await fixture(t)
  const contextPath = join(repo, '.cap/task-context.md')
  writeFileSync(contextPath, readFileSync(contextPath, 'utf8').replace(/^- index-fingerprint:.*\n/m, '').replace(/^- worktree-fingerprint:.*\n/m, ''))
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:blocked', environment })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.code === 'index_missing'))
  assert.ok(result.errors.some(e => e.code === 'worktree_missing'))
  assert.match(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), /context-recovery-event: visible-resume:blocked/)
  assert.ok(!readdirSync(join(repo, '.cap/context')).some(p => p.startsWith('manifest-')))
})

test('reconnaissance accepts create-only and delete-only implementation scopes', async t => {
  const { repo } = await fixture(t)
  const path = join(repo, '.cap/task-context.md')
  const initial = readFileSync(path, 'utf8')
  for (const action of ['create', 'delete']) {
    writeFileSync(path, initial.replace('- modify: `source.js`', `- ${action}: \`source.js\``))
    assert.equal((await inspectTaskContext(repo, { stage: 'implement', checkSemantic: false, environment })).ok, true)
  }
})

test('prepare cannot discard the published protected predecessor', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })).valid, true)
  checkpoint.atoms.shift()
  const nextPath = '.cap/context/checkpoint-bad.json'
  writeFileSync(join(repo, nextPath), JSON.stringify(checkpoint))
  const result = await prepareContext(repo, { checkpointPath: nextPath, budgetTokens: 20000, environment })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.code === 'protected_atom_missing'))
})

test('prepare binds effective token pressure instead of an unknown STATE hint', async t => {
  const { repo, path } = await fixture(t)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8') + '\ncontext-used-tokens: 850\ncontext-window-tokens: 1000\n')
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(result.valid, true, JSON.stringify(result))
  assert.equal(JSON.parse(readFileSync(join(repo, result.manifest), 'utf8')).pressure, 'critical')
})

test('host resume event blocks status, stage guard and execution until replay', async t => {
  const { repo, path } = await fixture(t)
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })).valid, true)
  const env = { ...environment, CAPITAL_AGENT_CONTEXT_RESUME_EVENT: 'host:next' }
  assert.equal((await inspectSemanticContext(repo, { environment: env })).reason, 'context_recovery_required')
  const status = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-status.mjs'), repo, '--compact', '--mcp-runtime', 'missing'], { env, encoding: 'utf8' })
  assert.equal(JSON.parse(status.stdout).contextGate.reason, 'context_recovery_required')
  const guard = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-runtime.mjs'), 'context', repo, '--stage', 'implement'], { env, encoding: 'utf8' })
  assert.notEqual(guard.status, 0)
  const execution = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--action', 'build', '--', process.execPath, '-e', 'process.exit(89)'], { env, encoding: 'utf8' })
  assert.notEqual(execution.status, 89)
  assert.equal(JSON.parse(execution.stdout).contextGate.reason, 'context_recovery_required')
  const recovered = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment: env })
  assert.equal(recovered.valid, true, JSON.stringify(recovered))
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
})

async function nativeFixture(t) {
  const result = await fixture(t)
  const env = { ...environment, CODEX_THREAD_ID: 'fixture-native-thread', CAPITAL_AGENT_SESSION_LOCK_DIR: join(result.repo, '.cap/local-state/session-locks') }
  await inspectSessionRoot({ repoRoot: result.repo, environment: env })
  assert.equal((await prepareContext(result.repo, { checkpointPath: result.path, budgetTokens: 20000, environment: env })).valid, true)
  const payload = { cwd: result.repo, session_id: env.CODEX_THREAD_ID, turn_id: 'turn-one', trigger: 'auto', transcript_path: '/must/not/read/private.jsonl' }
  const invoke = (hook_event_name, extra = {}) => handleContextHook({ ...payload, hook_event_name, ...extra }, { environment: env })
  return { ...result, env, payload, invoke }
}

test('native compact hooks recover once and inject exact context until the matching tool acknowledgment', async t => {
  const { repo, invoke, env } = await nativeFixture(t)
  assert.equal((await invoke('PreCompact')).continue, true)
  assert.equal((await invoke('PostCompact')).continue, true)
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const event = state.match(/^context-recovery-event: (.+)$/m)[1]
  assert.match(event, /^codex-native:/)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
  assert.equal((await invoke('PostCompact')).continue, true)
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), state)
  const replay = await invoke('PreToolUse', { tool_use_id: 'tool-one' })
  assert.ok(JSON.parse(replay.hookSpecificOutput.additionalContext).hot.length)
  assert.equal((await invoke('PostToolUse', { tool_use_id: 'other-tool' })).continue, true)
  assert.ok((await invoke('PreToolUse', { tool_use_id: 'tool-two' })).hookSpecificOutput)
  assert.equal((await invoke('PostToolUse', { tool_use_id: 'tool-two' })).continue, true)
  assert.equal((await invoke('PreToolUse', { tool_use_id: 'tool-three' })).hookSpecificOutput, undefined)
})

test('native callbacks reject another host session and stale source without changing unrelated task state', async t => {
  const { repo, invoke, payload, env } = await nativeFixture(t)
  const before = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const wrong = await handleContextHook({ ...payload, hook_event_name: 'PostCompact', session_id: 'other-host' }, { environment: env })
  assert.equal(wrong.continue, false)
  assert.match(wrong.stopReason, /hook_session_mismatch/)
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), before)
  assert.equal((await invoke('PreCompact')).continue, true)
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  assert.equal((await invoke('PostCompact')).continue, false)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, false)
})

test('a missing PostCompact fails closed before any tool can run', async t => {
  const { repo, invoke, env } = await nativeFixture(t)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
  assert.equal((await invoke('PreCompact')).continue, true)
  const notice = await invoke('PreToolUse', { tool_use_id: 'repair-checkpoint' })
  assert.equal(notice.continue, false)
  assert.match(notice.stopReason, /hook_postcompact_missing/)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, false)
  const result = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--stage', 'implement', '--', process.execPath, '-e', 'process.exit(89)'], { env, encoding: 'utf8' })
  assert.notEqual(result.status, 89)
  assert.equal(JSON.parse(result.stdout).contextGate.passed, false)
  assert.equal((await invoke('PostCompact')).continue, true)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
})

test('a missing hook record cannot reopen tools while recovery is pending', async t => {
  const { repo, invoke, env } = await nativeFixture(t)
  assert.equal((await invoke('PreCompact')).continue, true)
  const record = readdirSync(join(repo, '.cap/context')).find(name => name.startsWith('codex-hook-'))
  assert.ok(record)
  rmSync(join(repo, '.cap/context', record))
  const denied = await invoke('PreToolUse', { tool_use_id: 'side-effecting-tool' })
  assert.equal(denied.continue, false)
  assert.match(denied.stopReason, /context_recovery_required|hook_recovery_record_missing/)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, false)
})

test('a missing recovered native hook record cannot skip first-tool replay', async t => {
  const { repo, invoke, env } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
  const record = readdirSync(join(repo, '.cap/context')).find(name => name.startsWith('codex-hook-'))
  assert.ok(record)
  rmSync(join(repo, '.cap/context', record))
  const denied = await invoke('PreToolUse', { tool_use_id: 'side-effecting-tool' })
  assert.equal(denied.continue, false)
  assert.match(denied.stopReason, /hook_recovery_record_missing/)
})

test('native PostCompact without PreCompact still binds a real event; tampered replay stays blocked', async t => {
  const { repo, invoke } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const path = join(repo, state.match(/^context-recovery-receipt: (.+)$/m)[1])
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  receipt.hot[0].assertion = 'unapproved replacement'
  writeFileSync(path, JSON.stringify(receipt))
  const denied = await invoke('PreToolUse', { tool_use_id: 'tool-one' })
  assert.equal(denied.continue, false)
  assert.match(denied.stopReason, /hook_(?:receipt_invalid|recovery_stale)/)
})

test('native PreToolUse rejects a Task or Session mismatch instead of bypassing recovery', async t => {
  const { repo, invoke } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace('task-id: local-fixture', 'task-id: other-task'))
  const denied = await invoke('PreToolUse', { tool_use_id: 'side-effecting-tool' })
  assert.equal(denied.continue, false)
  assert.match(denied.stopReason, /hook_compaction_binding_mismatch/)
})

test('native delivery acknowledgment survives a legitimate source edit and a new PostCompact gets a new event', async t => {
  const { repo, invoke, env } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  const before = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  assert.ok((await invoke('PreToolUse', { tool_use_id: 'edit-source' })).hookSpecificOutput)
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  assert.equal((await invoke('PostToolUse', { tool_use_id: 'edit-source' })).continue, true)
  assert.equal((await invoke('PreToolUse', { tool_use_id: 'refresh-context' })).hookSpecificOutput, undefined)
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, false)
  writeFileSync(join(repo, 'source.js'), 'export const value = 1\n')
  assert.equal((await invoke('PostCompact', { turn_id: 'turn-two' })).continue, true)
  const after = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  assert.notEqual(before.match(/^context-recovery-event: (.+)$/m)[1], after.match(/^context-recovery-event: (.+)$/m)[1])
  assert.ok((await invoke('PreToolUse', { tool_use_id: 'next-tool', turn_id: 'turn-two' })).hookSpecificOutput)
})

test('native global hooks do not intercept pristine Git repositories or bootstrap', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'cap-native-pristine-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const payload = { cwd: repo, session_id: 'new-native-session', hook_event_name: 'PreToolUse', tool_use_id: 'bootstrap' }
  const env = { ...environment, CODEX_THREAD_ID: payload.session_id, CAPITAL_AGENT_SESSION_LOCK_DIR: join(repo, '.cap/local-state/session-locks') }
  assert.deepEqual(await handleContextHook(payload, { environment: env }), { continue: true, suppressOutput: true })
  mkdirSync(join(repo, '.cap'), { recursive: true })
  for (const state of ['stage: understand\ntask-id: \n', 'stage: done\ntask-id: finished-task\n']) {
    writeFileSync(join(repo, '.cap/STATE.md'), state)
    for (const hook_event_name of ['PreToolUse', 'PreCompact', 'PostCompact']) {
      assert.deepEqual(await handleContextHook({ ...payload, hook_event_name }, { environment: env }), { continue: true, suppressOutput: true })
    }
  }
})

test('native hook writer contention fails closed and non-Git directories remain unaffected', async t => {
  const { repo, invoke, payload, env } = await nativeFixture(t)
  const before = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const lock = join(repo, '.cap/.context-hook.lock')
  writeFileSync(lock, 'another writer\n')
  assert.match((await invoke('PostCompact')).stopReason, /hook_writer_busy/)
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), before)
  assert.equal(readFileSync(lock, 'utf8'), 'another writer\n')
  rmSync(lock)
  const outside = mkdtempSync(join(tmpdir(), 'cap-native-no-repo-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal((await handleContextHook({ ...payload, hook_event_name: 'PreCompact', cwd: outside }, { environment: env })).continue, true)
})

test('an old delivered record cannot bypass an interrupted second native compaction', async t => {
  const { repo, invoke } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  assert.ok((await invoke('PreToolUse', { tool_use_id: 'first-tool' })).hookSpecificOutput)
  assert.equal((await invoke('PostToolUse', { tool_use_id: 'first-tool' })).continue, true)
  const path = join(repo, '.cap/context', readdirSync(join(repo, '.cap/context')).find(name => name.startsWith('codex-hook-')))
  const delivered = readFileSync(path, 'utf8')
  assert.equal(JSON.parse(delivered).phase, 'delivered')
  assert.equal((await invoke('PreCompact', { turn_id: 'turn-two' })).continue, true)
  // Reproduce failure after pending STATE publication but before replacing the old record.
  writeFileSync(path, delivered)
  const denied = await invoke('PreToolUse', { tool_use_id: 'side-effecting-tool', turn_id: 'turn-two' })
  assert.equal(denied.continue, false)
  assert.match(denied.stopReason, /hook_recovery_stale/)
})

for (const key of ['task-id', 'session-id']) {
  test(`a delivered native hook record cannot authorize another ${key}`, async t => {
    const { repo, invoke } = await nativeFixture(t)
    assert.equal((await invoke('PostCompact')).continue, true)
    assert.ok((await invoke('PreToolUse', { tool_use_id: 'first-tool' })).hookSpecificOutput)
    assert.equal((await invoke('PostToolUse', { tool_use_id: 'first-tool' })).continue, true)
    const statePath = join(repo, '.cap/STATE.md')
    writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: another-binding`))
    const denied = await invoke('PreToolUse', { tool_use_id: 'side-effecting-tool' })
    assert.equal(denied.continue, false)
    assert.match(denied.stopReason, /hook_compaction_binding_mismatch/)
  })
}

test('a delivered native event permits a legitimate successor checkpoint receipt', async t => {
  const { repo, invoke, env, checkpoint } = await nativeFixture(t)
  assert.equal((await invoke('PostCompact')).continue, true)
  assert.ok((await invoke('PreToolUse', { tool_use_id: 'first-tool' })).hookSpecificOutput)
  assert.equal((await invoke('PostToolUse', { tool_use_id: 'first-tool' })).continue, true)
  const before = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'native-successor-detail', type: 'constraint', protection: 'P2', assertion: 'New reviewed implementation detail' })
  const nextPath = '.cap/context/checkpoint-native-successor.json'
  writeFileSync(join(repo, nextPath), JSON.stringify(successor))
  const result = await prepareContext(repo, { checkpointPath: nextPath, budgetTokens: 20000, environment: env })
  assert.equal(result.valid, true, JSON.stringify(result))
  const after = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  assert.equal(before.match(/^context-recovery-event: (.+)$/m)[1], after.match(/^context-recovery-event: (.+)$/m)[1])
  assert.notEqual(before.match(/^context-recovery-receipt: (.+)$/m)[1], after.match(/^context-recovery-receipt: (.+)$/m)[1])
  assert.equal((await invoke('PreToolUse', { tool_use_id: 'next-tool' })).continue, true)
})
