import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContextBinding as captureBinding, inspectSemanticContext as inspectContext } from './cap-context-gate.mjs'
import { createManifest } from './cap-context-checkpoint.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { inspectCapStatus, compactCapStatus, statusDecisionSignature } from './cap-status.mjs'
import { captureCoverageRequirements } from './cap-context-gate.mjs'
import { observeContextResume } from './cap-context-recovery.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env, CAPITAL_AGENT_MODE: 'local' }
for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CAPITAL_AGENT_RUNTIME_SESSION_ID']) delete env[key]
const captureContextBinding = (repo, options = {}) => captureBinding(repo, { environment: env, ...options })
const inspectSemanticContext = (repo, options = {}) => inspectContext(repo, { environment: env, ...options })

function writeRuleComparison(repo, assessment = 'unresolved') {
  const path = join(repo, '.cap/task-context.md')
  const original = readFileSync(path, 'utf8').split('## Historical rule check')[0].replace('- candidates: none', '- candidates: knowledge:kn-contract')
  const report = { schemaVersion: 1, repo: realpathSync(repo), taskId: 'local-fixture', intent: 'Preserve the public contract', candidateSet: 'knowledge:kn-contract', comparisons: [{ id: 'public-contract', historyRef: 'knowledge:kn-contract', currentRef: 'user-message:current-request', scope: 'Same project, environment and API version', historicalRule: 'Reject unsettled cancellation', currentRule: 'Allow unsettled cancellation', assessment, rationale: 'Opposite behavior in the same conditions', impact: 'Account lifecycle', ...(assessment === 'change_authorized' ? { decisionRef: 'user-message:explicit-replacement' } : {}) }] }
  writeFileSync(path, `${original}\n## Historical rule check\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`)
}

test('history rule conflict is visible in status and blocks Node/POSIX/execution before a command starts', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  writeRuleComparison(repo)
  const gate = await inspectSemanticContext(repo)
  assert.equal(gate.reason, 'history_rule_conflict_unresolved')
  const status = await inspectCapStatus({ repoRoot: repo, homeDir: join(repo, 'home'), environment: env, offline: true })
  assert.equal(status.workflow.action, '核对历史规则与本次需求')
  const compact = compactCapStatus(status)
  assert.deepEqual(statusDecisionSignature(compact), statusDecisionSignature(status))
  assert.equal(compact.contextGate.nextActions[0].requiresUser, true)
  assert.match(JSON.stringify(compact.contextGate.errors), /Reject unsettled cancellation/)
  for (const [cmd, args] of [[process.execPath, [join(root, 'scripts/cap-runtime.mjs'), 'context', repo, '--stage', 'implement']], ['bash', [join(root, 'skills/cap-flow/scripts/cap-context-guard'), '--stage', 'implement', repo]]]) {
    const r = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(r.status, 1); assert.match(r.stderr, /history_rule_conflict_unresolved/)
  }
  const blocked = spawnSync(process.execPath, [join(root, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--stage', 'implement', '--compact', '--', process.execPath, '-e', 'require("fs").writeFileSync(".cap/unexpected-rule-execution", "ran")'], { cwd: repo, env, encoding: 'utf8' })
  assert.equal(blocked.status, 1)
  const output = JSON.parse(blocked.stdout)
  assert.equal(output.nextActions[0].requiresUser, true)
  assert.throws(() => readFileSync(join(repo, '.cap/unexpected-rule-execution')), /ENOENT/)
  // A new valid manifest cannot itself resolve an undecided business rule.
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo)).reason, 'history_rule_conflict_unresolved')
  writeRuleComparison(repo, 'change_authorized')
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  const passed = spawnSync(process.execPath, [join(root, 'scripts/cap-runtime.mjs'), 'context', repo, '--stage', 'implement'], { cwd: repo, env, encoding: 'utf8' })
  assert.equal(passed.status, 0, passed.stderr)
})

test('requirements-stage history conflicts are visible before any semantic checkpoint is due', async t => {
  const { repo } = await fixture(t)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8').replace('stage: implement', 'stage: define'))
  writeRuleComparison(repo)
  const gate = await inspectSemanticContext(repo)
  assert.equal(gate.reason, 'history_rule_conflict_unresolved')
  const status = await inspectCapStatus({ repoRoot: repo, homeDir: join(repo, 'home'), environment: env, offline: true })
  assert.equal(status.contextGate.reason, 'history_rule_conflict_unresolved')
  writeRuleComparison(repo, 'change_authorized')
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_not_required')
})

async function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'cap-context-gate-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(join(repo, '.cap/context'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), '.cap/\n')
  writeFileSync(join(repo, 'source.js'), 'export const value = 1\n')
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: repo })
  const state = `stage: implement\nstatus: in-progress\ntask-id: local-fixture\nsession-id: session-fixture\nbranch: main\ncontext-pressure: unknown\n\n## External operation authorization\n- scope: local changes only; no push\n- invalidates-on: target changes\n\n## Decisions log\n- Keep the public contract\n\n## Next action\n-> Implement the approved change\n`
  writeFileSync(join(repo, '.cap/STATE.md'), state)
  await refreshContext(repo)
  return { repo, state }
}

async function refreshContext(repo) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const f = await inspectContextFingerprint(repo)
  writeFileSync(join(repo, '.cap/task-context.md'), `- intent: Preserve the public contract\n- branch: main\n- head: ${head}\n- index-fingerprint: ${f.index}\n- worktree-fingerprint: ${f.worktree}\n- untracked-fingerprint: ${f.untracked}\n- profile-used-as: index-only\n\n## Entry points\n- \`source.js\`\n## Call chain and data flow\n- bounded fixture\n## Similar implementations\n- current source\n## History usage\n- candidates: none\n- outcome: not_used\n- reason: no candidates\n- plan-impact: none\n- verification-impact: none\n## Tests and environment\n- \`source.js\`\n## Evidence sources\n- \`source.js\`\n## External operation boundary\n- environment: local\n- authorization: local only\n- minimum-impact: source.js\n- recovery: Git\n- invalidates-on: scope changes\n## Impact surface\n- modify: \`source.js\`\n## Profile drift\n- none\n`)
}

async function publish(repo, stage = 'implement', extra = {}) {
  const binding = await captureContextBinding(repo, { stage })
  const scope = { taskId: binding.taskId, repo: binding.repo, branch: binding.branch, commit: binding.commit }
  const atom = { id: 'intent-1', type: 'intent', assertion: 'Preserve the public contract', protection: 'P0', priority: 100, scope, scopeBinding: 'task', sourceRefs: ['user-message:fixture'], trust: 'user-stated', certainty: 'confirmed', status: 'active', recoverability: 'irrecoverable', invalidation: ['task changes'], supersedes: [] }
  const requirements = await captureCoverageRequirements(repo, { environment: env })
  const atoms = requirements.map((requirement, index) => ({ ...atom, id: `covered-${index}`, type: requirement.types[0], assertion: `Retain ${requirement.label}: ${requirement.id}`, protection: requirement.minProtection, priority: index === 0 ? 100 : 80, sourceRefs: [requirement.sourceRef], trust: 'repository-observed' }))
  atoms.push({ ...atom, id: 'acceptance-criterion', type: 'acceptance_criterion', assertion: 'Preserve public behavior', protection: 'P1', priority: 90 })
  const checkpoint = { schemaVersion: 1, identity: { ...scope, stage }, atoms, coverage: requirements.map((requirement, index) => ({ id: requirement.id, atomIds: [`covered-${index}`] })) }
  const log = atoms.map(item => JSON.stringify(item)).join('\n') + '\n'
  const sourceContents = Object.fromEntries(['.cap/task-context.md', '.cap/STATE.md', '.cap/spec.md', '.cap/plan.md'].filter(path => { try { readFileSync(join(repo, path)); return true } catch { return false } }).map(path => [path, readFileSync(join(repo, path), 'utf8')]))
  const manifest = createManifest(checkpoint, { checkpointPath: 'checkpoint.json', atomLogPath: 'atoms.jsonl', atomLogContent: log, sourceContents, budgetTokens: 20000, trigger: 'stage-entry', pressure: 'low', ...extra })
  manifest.entry = binding
  manifest.entry.previousManifest = 'none'
  manifest.entry.previousDigest = null
  writeFileSync(join(repo, '.cap/context/checkpoint.json'), JSON.stringify(checkpoint))
  writeFileSync(join(repo, '.cap/context/atoms.jsonl'), log)
  writeFileSync(join(repo, '.cap/context/manifest.json'), JSON.stringify(manifest))
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  writeFileSync(join(repo, '.cap/STATE.md'), `${state}\ncontext-manifest: .cap/context/manifest.json\ncontext-checkpoint: .cap/context/checkpoint.json\ncontext-checkpoint-digest: ${manifest.digest}\ncontext-previous-manifest: none\ncontext-previous-digest: none\n`)
  return manifest
}

test('missing checkpoint routes active stage to creation, not a permission question', async t => {
  const { repo } = await fixture(t)
  const result = await inspectSemanticContext(repo)
  assert.equal(result.passed, false)
  assert.equal(result.reason, 'context_checkpoint_missing')
  assert.equal(result.nextActions[0].kind, 'create_context_checkpoint')
  assert.equal(result.nextActions[0].requiresUser, false)
})

test('bound checkpoint rejects an empty or partially mapped semantic inventory', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const current = JSON.parse(readFileSync(join(repo, '.cap/context/checkpoint.json'), 'utf8'))
  assert.ok(current.coverage.length > 3)
  current.coverage.pop()
  const log = current.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n'
  const sources = Object.fromEntries(['.cap/task-context.md', '.cap/STATE.md'].map(path => [path, readFileSync(join(repo, path), 'utf8')]))
  const manifest = createManifest(current, { checkpointPath: 'checkpoint-new.json', atomLogPath: 'atoms-new.jsonl', atomLogContent: log, sourceContents: sources, budgetTokens: 20000, trigger: 'stage-entry', pressure: 'unknown' })
  manifest.entry = await captureContextBinding(repo)
  manifest.entry.previousManifest = 'none'
  manifest.entry.previousDigest = null
  const { validateManifest } = await import('./cap-context-checkpoint.mjs')
  assert.ok(validateManifest(manifest, { checkpoint: current, atomLogContent: log, sourceContents: sources }).errors.some(error => error.code === 'semantic_source_uncovered'))
})

test('valid current checkpoint is reusable; publication pointers do not invalidate binding', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8') + '\nupdated: 2026-10-14T00:00:00Z\n')
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  assert.equal((await inspectSemanticContext(repo, { stage: 'test' })).reason, 'context_stage_changed')
})

test('authorization and decision corrections invalidate same-Commit checkpoints', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8').replace('local changes only; no push', 'local changes only; revoke all writes'))
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_semantics_changed')
})

test('new Commit and Session require new bindings, even if files remain valid', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'new identity'], { cwd: repo })
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_identity_changed')
})

test('task-context authorization changes invalidate the bound semantic inputs', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const path = join(repo, '.cap/task-context.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace('authorization: local only', 'authorization: read only; all writes revoked'))
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_semantics_changed')
})

test('STATE-backed checkpoint survives cursor publication but preserves provider and decision drift', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const checkpoint = JSON.parse(readFileSync(join(repo, '.cap/context/checkpoint.json'), 'utf8'))
  const log = checkpoint.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n'
  const path = join(repo, '.cap/STATE.md'), state = readFileSync(path, 'utf8')
  const manifest = createManifest(checkpoint, { checkpointPath: 'checkpoint.json', atomLogPath: 'atoms.jsonl', atomLogContent: log, sourceContents: { '.cap/STATE.md': state, '.cap/task-context.md': readFileSync(join(repo, '.cap/task-context.md'), 'utf8') }, budgetTokens: 20000, trigger: 'stage-entry', pressure: 'unknown' })
  manifest.entry = await captureContextBinding(repo)
  manifest.entry.previousManifest = '.cap/context/manifest.json'
  manifest.entry.previousDigest = manifest.digest
  writeFileSync(join(repo, '.cap/context/checkpoint.json'), JSON.stringify(checkpoint))
  writeFileSync(join(repo, '.cap/context/atoms.jsonl'), log)
  writeFileSync(join(repo, '.cap/context/state-manifest.json'), JSON.stringify(manifest))
  const published = state.replace('context-manifest: .cap/context/manifest.json', 'context-manifest: .cap/context/state-manifest.json').replace(/context-checkpoint-digest: .*/, `context-checkpoint-digest: ${manifest.digest}`).replace('context-previous-manifest: none', 'context-previous-manifest: .cap/context/manifest.json').replace('context-previous-digest: none', `context-previous-digest: ${manifest.digest}`) + '\nupdated: now\n'
  writeFileSync(path, published)
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  for (const [change, reason] of [['provider-compaction: running', 'context_provider_pending'], ['provider-compaction-event: newer', 'context_manifest_invalid'], ['context-pressure: high', 'context_pressure_increased']]) {
    writeFileSync(path, change === 'context-pressure: high' ? published.replace('context-pressure: unknown', change) : published + `\n${change}\n`)
    assert.equal((await inspectSemanticContext(repo)).reason, reason)
  }
  writeFileSync(path, published.replace('Keep the public contract', 'Revoke prior decision'))
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_semantics_changed')
})

test('unindexed spec and plan changes still require semantic reconciliation', async t => {
  const { repo } = await fixture(t)
  for (const name of ['spec', 'plan']) {
    await publish(repo)
    writeFileSync(join(repo, `.cap/${name}.md`), 'Approved scope changed\n')
    assert.equal((await inspectSemanticContext(repo)).reason, 'context_semantics_changed')
  }
})

test('higher observed pressure triggers refresh once, unknown pressure uses stage fallback', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo, { pressure: 'high' })).reason, 'context_pressure_increased')
  await publish(repo, 'implement', { pressure: 'high' })
  assert.equal((await inspectSemanticContext(repo, { pressure: 'high' })).passed, true)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8') + '\ncontext-used-tokens: 850\ncontext-window-tokens: 1000\n')
  assert.equal((await inspectSemanticContext(repo)).pressure, 'critical')
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_pressure_increased')
})

test('same-Commit source edits expire checkpoints even after refreshing reconnaissance', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  await refreshContext(repo)
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_sources_changed')
})

test('tampered log and escaped or symlinked manifest cannot unlock a stage', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  writeFileSync(join(repo, '.cap/context/atoms.jsonl'), '{}\n')
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_manifest_invalid')
  rmSync(join(repo, '.cap/context/manifest.json'))
  symlinkSync(join(repo, 'source.js'), join(repo, '.cap/context/manifest.json'))
  assert.equal((await inspectSemanticContext(repo)).passed, false)
})

test('observed recovery event requires an explicit recovered binding; request is not success', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const recovered = await observeContextResume(repo, { event: 'runtime-event:round-2', environment: env })
  assert.equal(recovered.valid, true, JSON.stringify(recovered.errors))
  assert.ok(recovered.recovery.hot.length)
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'requested', eventRef: 'runtime-event:round-2' } })
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_provider_pending')
})

test('STATE provider lifecycle cannot reuse an unavailable manifest or a different success event', async t => {
  const { repo } = await fixture(t)
  const path = join(repo, '.cap/STATE.md')
  await publish(repo)
  const state = readFileSync(path, 'utf8')
  for (const status of ['requested', 'running', 'failed']) {
    writeFileSync(path, state + `\nprovider-compaction: ${status}\nprovider-compaction-event: event:new\n`)
    assert.equal((await inspectSemanticContext(repo)).reason, 'context_provider_pending')
  }
  writeFileSync(path, state + '\nprovider-compaction: succeeded\nprovider-compaction-kind: codex-app-server\nprovider-compaction-event: event:new\n')
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:old' } })
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:new' } })
  assert.equal((await inspectSemanticContext(repo)).passed, false)
  // A host success does not by itself prove that hot facts were reloaded.
  const recovery = await observeContextResume(repo, { event: 'event:new', environment: env })
  assert.equal(recovery.valid, true, JSON.stringify(recovery.errors))
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:new' } })
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  writeFileSync(path, readFileSync(path, 'utf8').replace('provider-compaction-kind: codex-app-server', 'provider-compaction-kind: responses-api'))
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
})

test('a manifest cannot claim provider success without a matching observed STATE event', async t => {
  const { repo } = await fixture(t)
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:unobserved' } })
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
})

test('a newer visible resume cannot reuse an older provider success event', async t => {
  const { repo } = await fixture(t)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8') + '\nprovider-compaction: succeeded\nprovider-compaction-kind: codex-app-server\nprovider-compaction-event: event:A\n')
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:A' } })
  assert.equal((await observeContextResume(repo, { event: 'event:A', environment: env })).valid, true)
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:A' } })
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  const newer = await observeContextResume(repo, { event: 'event:B', environment: env })
  assert.equal(newer.valid, false)
  assert.ok(newer.errors.some(error => error.code === 'context_provider_event_mismatch'))
  await publish(repo, 'implement', { provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'event:A' } })
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
})

test('POSIX and Node stage entries block missing checkpoints and pass current bindings', async t => {
  const { repo } = await fixture(t)
  const commands = [[process.execPath, [join(root, 'scripts/cap-runtime.mjs'), 'context', repo, '--stage', 'implement']], ['bash', [join(root, 'skills/cap-flow/scripts/cap-context-guard'), '--stage', 'implement', repo]]]
  for (const [cmd, args] of commands) {
    const r = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /context_checkpoint_missing/)
  }
  await publish(repo)
  for (const [cmd, args] of commands) {
    const r = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }
})

test('execution entry cannot run a command before completing its semantic gate', async t => {
  const { repo } = await fixture(t)
  const args = [join(root, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--stage', 'implement', '--compact', '--', process.execPath, '-e', 'process.exit(0)']
  const blocked = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8' })
  assert.equal(blocked.status, 1)
  assert.equal(JSON.parse(blocked.stdout).contextGate.reason, 'context_checkpoint_missing')
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8').includes('execution/'), false)
  await publish(repo)
  const passed = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8' })
  assert.equal(passed.status, 0, passed.stderr + passed.stdout)
  assert.equal(JSON.parse(passed.stdout).gate.passed, true)
})

test('execution cannot bypass failed reconnaissance with a valid semantic checkpoint', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const context = join(repo, '.cap/task-context.md')
  writeFileSync(context, readFileSync(context, 'utf8').replace(/^- index-fingerprint:.*\n/m, ''))
  const script = [join(root, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--stage', 'implement', '--compact', '--', process.execPath, '-e', 'require("fs").writeFileSync("unexpected", "ran")']
  const result = spawnSync(process.execPath, script, { cwd: repo, env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.ok(JSON.parse(result.stdout).blockers.some(item => item.code === 'index_missing'))
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8').includes('execution/'), false)
})

test('visible resume records a unique receipt and requires rebinding before execution', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const first = await observeContextResume(repo, { event: 'host-event:first', environment: env })
  assert.equal(first.valid, true)
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
  await publish(repo)
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  const second = await observeContextResume(repo, { event: 'host-event:second', environment: env })
  assert.equal(second.valid, true)
  assert.notEqual(first.recovery.event, second.recovery.event)
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_recovery_required')
})

test('manifest CLI binds current inputs and a subsequent source correction invalidates it', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const args = [join(root, 'scripts/cap-context-checkpoint.mjs'), 'create-manifest', '.cap/context/checkpoint.json', '--atom-log', '.cap/context/atoms.jsonl', '--budget-tokens', '2000', '--trigger', 'stage-entry', '--pressure', 'unknown', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none', '--bind-entry', repo, '--output', '.cap/context/bound.json']
  const r = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const m = JSON.parse(readFileSync(join(repo, '.cap/context/bound.json'), 'utf8'))
  assert.equal(m.entry.semanticsHash.length, 64)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8').replace('context-manifest: .cap/context/manifest.json', 'context-manifest: .cap/context/bound.json').replace('context-previous-manifest: none', 'context-previous-manifest: .cap/context/manifest.json').replace('context-previous-digest: none', `context-previous-digest: ${m.digest}`))
  assert.equal((await inspectSemanticContext(repo)).passed, true)
  const detached = JSON.parse(readFileSync(join(repo, '.cap/context/bound.json'), 'utf8'))
  detached.entry.previousManifest = 'none'
  detached.entry.previousDigest = null
  writeFileSync(join(repo, '.cap/context/bound.json'), JSON.stringify(detached))
  assert.equal((await inspectSemanticContext(repo)).reason, 'context_predecessor_invalid')
})

test('bound manifest creation cannot restart an existing P0 checkpoint chain', async t => {
  const { repo } = await fixture(t)
  await publish(repo)
  const existing = JSON.parse(readFileSync(join(repo, '.cap/context/checkpoint.json'), 'utf8'))
  const retained = { ...existing.atoms[0], id: 'protected-extra', assertion: 'Never lose the earlier protected rule', sourceRefs: ['user-message:protected-extra'], protection: 'P0' }
  existing.atoms.push(retained)
  const log = existing.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n'
  const sources = Object.fromEntries(['.cap/STATE.md', '.cap/task-context.md'].map(path => [path, readFileSync(join(repo, path), 'utf8')]))
  const prior = createManifest(existing, { checkpointPath: 'checkpoint-prior.json', atomLogPath: 'atoms-prior.jsonl', atomLogContent: log, sourceContents: sources, budgetTokens: 20000, trigger: 'stage-entry', pressure: 'unknown' })
  prior.entry = await captureContextBinding(repo)
  prior.entry.previousManifest = 'none'
  prior.entry.previousDigest = null
  writeFileSync(join(repo, '.cap/context/checkpoint-prior.json'), JSON.stringify(existing))
  writeFileSync(join(repo, '.cap/context/atoms-prior.jsonl'), log)
  writeFileSync(join(repo, '.cap/context/manifest-prior.json'), JSON.stringify(prior))
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/context-manifest: .*/, 'context-manifest: .cap/context/manifest-prior.json').replace(/context-checkpoint: .*/, 'context-checkpoint: .cap/context/checkpoint-prior.json').replace(/context-checkpoint-digest: .*/, `context-checkpoint-digest: ${prior.digest}`))
  const missing = { ...existing, atoms: existing.atoms.filter(atom => atom.id !== 'protected-extra') }
  writeFileSync(join(repo, '.cap/context/checkpoint-next.json'), JSON.stringify(missing))
  writeFileSync(join(repo, '.cap/context/atoms-next.jsonl'), missing.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n')
  const args = [join(root, 'scripts/cap-context-checkpoint.mjs'), 'create-manifest', '.cap/context/checkpoint-next.json', '--atom-log', '.cap/context/atoms-next.jsonl', '--budget-tokens', '20000', '--trigger', 'stage-entry', '--pressure', 'unknown', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none', '--bind-entry', repo, '--output', '.cap/context/manifest-next.json']
  const attempt = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8' })
  assert.equal(attempt.status, 1)
  assert.ok(JSON.parse(attempt.stdout).errors.some(error => error.code === 'context_predecessor_missing'))
})

test('action-selected execution stages cannot bypass the target checkpoint gate', async t => {
  const { repo, state } = await fixture(t)
  const run = action => spawnSync(process.execPath, [join(root, 'scripts/cap-execute.mjs'), 'run', '--repo', repo, '--action', action, '--compact', '--', process.execPath, '-e', 'require("fs").writeFileSync("unexpected.txt", "ran")'], { cwd: repo, env, encoding: 'utf8' })
  writeFileSync(join(repo, '.cap/STATE.md'), state.replace('stage: implement', 'stage: define'))
  let r = run('test')
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).contextGate.stage, 'test')
  assert.equal(JSON.parse(r.stdout).contextGate.reason, 'context_checkpoint_missing')
  writeFileSync(join(repo, '.cap/STATE.md'), state)
  await publish(repo)
  r = run('package')
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).contextGate.stage, 'release')
  assert.equal(JSON.parse(r.stdout).contextGate.reason, 'context_stage_changed')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '')
})

test('status exposes missing semantic checkpoint before stage advancement and compact preserves the decision', async t => {
  const { repo } = await fixture(t)
  const home = mkdtempSync(join(tmpdir(), 'cap-gate-home-')); t.after(() => rmSync(home, { recursive: true, force: true }))
  const full = await inspectCapStatus({ repoRoot: repo, homeDir: home, environment: env, offline: true })
  assert.equal(full.contextGate.reason, 'context_checkpoint_missing')
  assert.equal(full.workflow.gated, true)
  assert.equal(full.nextActions[0].kind, 'create_context_checkpoint')
  assert.deepEqual(statusDecisionSignature(compactCapStatus(full)), statusDecisionSignature(full))
})

test('ordinary initial tasks with no stage checkpoint obligation remain compatible', async t => {
  const { repo } = await fixture(t)
  writeFileSync(join(repo, '.cap/STATE.md'), 'stage: define\ntask-id: local-fixture\n')
  assert.equal((await inspectSemanticContext(repo)).required, false)
})
