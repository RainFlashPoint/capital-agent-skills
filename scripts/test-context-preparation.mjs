import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContextBinding, captureCoverageRequirements, inspectSemanticContext } from './cap-context-gate.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { prepareContext } from './cap-context-preparation.mjs'
import { inspectTaskContext } from './cap-runtime.mjs'

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

test('prepare publishes a reviewed initial snapshot and reuses an unchanged binding', async t => {
  const { repo, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
  const files = readdirSync(join(repo, '.cap/context'))
  const second = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(second.valid, true, JSON.stringify(second))
  assert.equal(second.reused, true)
  assert.deepEqual(readdirSync(join(repo, '.cap/context')), files)
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
