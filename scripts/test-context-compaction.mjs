import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkpointDigest,
  classifyPressure,
  planContext,
  validateCheckpoint,
  validateCheckpointTransition,
  createManifest,
  validateManifest,
  validateAtomLog,
  contextReplay,
} from './cap-context-checkpoint.mjs'

const script = fileURLToPath(new URL('./cap-context-checkpoint.mjs', import.meta.url))
const commit = 'a'.repeat(40)

function atom(overrides = {}) {
  return {
    id: 'intent-1',
    type: 'intent',
    assertion: 'Implement priority-aware semantic compaction',
    protection: 'P0',
    priority: 100,
    scope: { taskId: 'task-1', repo: 'example/repo', branch: 'feature/context', commit },
    sourceRefs: ['user-message:42'],
    trust: 'user-authorized',
    status: 'active',
    certainty: 'confirmed',
    recoverability: 'irrecoverable',
    invalidation: ['task identity changes'],
    supersedes: [],
    ...overrides,
  }
}

function checkpoint(atoms = [atom()], overrides = {}) {
  return {
    schemaVersion: 1,
    identity: {
      taskId: 'task-1',
      repo: 'example/repo',
      branch: 'feature/context',
      commit,
      stage: 'implement',
    },
    atoms,
    ...overrides,
  }
}

function codes(result) {
  return result.errors.map(error => error.code)
}

test('replay coalesces exact semantic duplicates while retaining every audit atom and source', () => {
  const assertion = 'Preserve the approved task boundary. '.repeat(80)
  const original = checkpoint([
    atom({ id: 'a', assertion }),
    atom({ id: 'b', assertion, sourceRefs: ['user-message:43'] }),
  ])
  const before = JSON.stringify(original)
  const legacy = planContext(original, { budgetTokens: 10000, replayVersion: 0 })
  const plan = planContext(original, { budgetTokens: 10000 })
  assert.equal(plan.valid, true)
  assert.deepEqual(plan.hot.map(a => a.id), ['a', 'b'])
  assert.ok(plan.hotTokens < legacy.hotTokens)
  assert.equal(planContext(original, { budgetTokens: plan.hotTokens }).valid, true)
  assert.equal(planContext(original, { budgetTokens: plan.hotTokens - 1 }).valid, false)
  const replay = contextReplay(original, { replayVersion: 1, hot: ['a', 'b'], warm: [] })
  assert.equal(replay.hot.length, 1)
  assert.deepEqual(replay.hot[0].coveredAtomIds, ['a', 'b'])
  assert.deepEqual(replay.hot[0].sourceRefs, ['user-message:42', 'user-message:43'])
  assert.equal(contextReplay(original, { hot: ['a', 'b'], warm: [] }).hot.length, 2)
  assert.equal(JSON.stringify(original), before)
})

test('replay never coalesces changed authority, scope, certainty, lineage or protection', () => {
  for (const change of [
    { trust: 'user-stated' }, { protection: 'P1', type: 'decision' },
    { invalidation: ['another boundary'] }, { certainty: 'unknown' },
    { scopeBinding: 'task' }, { assertion: 'Do NOT implement the approved behavior' },
    { supersedes: ['ancestor'] }, { recoverability: 'source-backed' },
  ]) {
    const original = checkpoint([atom({ id: 'a' }), atom({ id: 'b', ...change })])
    assert.equal(contextReplay(original, { replayVersion: 1, hot: ['a', 'b'], warm: [] }).hot.length, 2, JSON.stringify(change))
  }
})

test('legacy duplicate manifests validate with their original token budget and unknown replay versions fail', () => {
  const value = checkpoint([atom({ id: 'a' }), atom({ id: 'b' })])
  const log = value.atoms.map(atom => JSON.stringify(atom)).join('\n') + '\n'
  const manifest = createManifest(value, { checkpointPath: 'checkpoint.json', atomLogPath: 'atoms.jsonl', atomLogContent: log, budgetTokens: 10000, trigger: 'handoff', pressure: 'unknown' })
  const legacy = planContext(value, { budgetTokens: 10000, replayVersion: 0 })
  manifest.plan = { digest: legacy.digest, currentActionIds: [], hotTokens: legacy.hotTokens, ...Object.fromEntries(['hot', 'warm', 'cold', 'dropped'].map(tier => [tier, legacy[tier].map(atom => atom.id)])) }
  assert.equal(validateManifest(manifest, { checkpoint: value, atomLogContent: log }).valid, true)
  manifest.plan.replayVersion = 2
  assert.ok(codes(validateManifest(manifest, { checkpoint: value, atomLogContent: log })).includes('manifest_replay_version_invalid'))
})

test('empty checkpoints cannot validate or produce a usable context plan', () => {
  assert.equal(validateCheckpoint(checkpoint([])).valid, false)
  assert.equal(planContext(checkpoint([]), { budgetTokens: 2000 }).valid, false)
})

test('checkpoint chain rejects Task/repository/branch swaps and stale active scopes', () => {
  const before = checkpoint()
  for (const field of ['taskId', 'repo', 'branch']) {
    const identity = { ...before.identity, [field]: 'another' }
    const scope = { ...before.atoms[0].scope, [field]: 'another' }
    const after = checkpoint([atom({ scope })], { identity })
    assert.ok(codes(validateCheckpointTransition(before, after)).includes('checkpoint_identity_changed'))
    assert.ok(codes(validateCheckpoint(checkpoint(undefined, { identity }))).includes('atom_scope_identity_mismatch'))
  }
})

test('task-scoped intent survives Commit changes while Commit-scoped authorization expires', () => {
  const old = checkpoint([
    atom({ scopeBinding: 'task' }),
    atom({ id: 'auth-commit', type: 'authorization', assertion: 'Deploy this exact commit' }),
  ])
  const nextCommit = 'c'.repeat(40)
  const auth = old.atoms[1]
  const current = checkpoint([
    old.atoms[0],
    { ...auth, status: 'invalidated' },
  ], { identity: { ...old.identity, commit: nextCommit } })
  assert.equal(validateCheckpointTransition(old, current).valid, true)
})

test('authoritative revocation preserves P0 history and permits invalidation', () => {
  const auth = atom({ type: 'authorization' })
  const before = checkpoint([auth])
  const after = checkpoint([{ ...auth, status: 'invalidated', sourceRefs: [...auth.sourceRefs, 'user-message:revoke'] }])
  assert.equal(validateCheckpointTransition(before, after).valid, true)
})

test('revoked and superseded authorization cannot reactivate in checkpoint or log', () => {
  for (const status of ['invalidated', 'superseded']) {
    const terminal = atom({ id: 'auth-1', type: 'authorization', status, sourceRefs: ['user-message:grant', 'user-message:revoke'] })
    const revived = { ...terminal, status: 'active' }
    assert.ok(codes(validateCheckpointTransition(checkpoint([terminal]), checkpoint([revived]))).includes('terminal_atom_reactivated'))
    const log = [terminal, revived].map(atom => JSON.stringify(atom)).join('\n') + '\n'
    assert.ok(codes({ errors: validateAtomLog(log, checkpoint([revived])) }).includes('terminal_atom_reactivated'))
    const successor = { ...revived, id: 'auth-2', sourceRefs: [...revived.sourceRefs, 'user-message:regrant'], supersedes: ['auth-1'] }
    assert.equal(validateCheckpointTransition(checkpoint([terminal]), checkpoint([terminal, successor])).valid, true)
    const unauthorised = { ...successor, sourceRefs: terminal.sourceRefs }
    assert.ok(codes(validateCheckpointTransition(checkpoint([terminal]), checkpoint([terminal, unauthorised]))).includes('supersedes_authority_missing'))
  }
})

test('successor graph rejects dangling, ambiguous and cyclic lineage', () => {
  const before = checkpoint()
  assert.ok(codes(validateCheckpointTransition(before, checkpoint([atom({ supersedes: ['missing'] })]))).includes('supersedes_target_missing'))
  const successor = atom({ id: 'new-1', sourceRefs: ['user-message:new'], supersedes: ['intent-1'] })
  assert.ok(codes(validateCheckpointTransition(before, checkpoint([successor, { ...successor, id: 'new-2' }]))).includes('supersedes_target_ambiguous'))
  const cycle = checkpoint([atom({ id: 'a', supersedes: ['b'] }), atom({ id: 'b', supersedes: ['a'] })])
  assert.ok(codes(validateCheckpointTransition(before, cycle)).includes('supersedes_cycle'))
})

test('multi-checkpoint supersedes history remains valid and cannot be erased', () => {
  const a = atom({ id: 'decision-a', type: 'decision', protection: 'P1', priority: 80, assertion: 'Decision A', recoverability: 'source-backed' })
  const b = atom({ id: 'decision-b', type: 'decision', protection: 'P1', priority: 85, assertion: 'Decision B', recoverability: 'source-backed', supersedes: ['decision-a'], sourceRefs: ['user-message:decision-b'] })
  const first = checkpoint([a])
  const second = checkpoint([{ ...a, status: 'superseded' }, b])
  assert.equal(validateCheckpointTransition(first, second).valid, true)
  assert.equal(validateCheckpointTransition(second, checkpoint(second.atoms)).valid, true)
  const c = atom({ id: 'decision-c', type: 'decision', protection: 'P1', priority: 90, assertion: 'Decision C', recoverability: 'source-backed', supersedes: ['decision-b'], sourceRefs: ['user-message:decision-c'] })
  const third = checkpoint([{ ...a, status: 'superseded' }, { ...b, status: 'superseded' }, c])
  assert.equal(validateCheckpointTransition(second, third).valid, true)
  const erased = checkpoint([{ ...a, status: 'superseded' }, { ...b, supersedes: [] }])
  assert.ok(codes(validateCheckpointTransition(second, erased)).includes('supersedes_lineage_removed'))
})

test('a historical inactive successor can lead to one active successor on the current Commit', () => {
  const decisionA = atom({
    id: 'decision-a', type: 'decision', protection: 'P1', priority: 80,
    assertion: 'Decision A', recoverability: 'source-backed',
  })
  const previous = checkpoint([decisionA])
  const nextCommit = 'b'.repeat(40)
  const decisionB = atom({
    id: 'decision-b', type: 'decision', protection: 'P1', priority: 85,
    assertion: 'Decision B', recoverability: 'source-backed', status: 'superseded',
    supersedes: ['decision-a'], sourceRefs: ['user-message:decision-b'],
  })
  const decisionC = atom({
    id: 'decision-c', type: 'decision', protection: 'P1', priority: 90,
    assertion: 'Decision C', recoverability: 'source-backed',
    scope: { ...decisionA.scope, commit: nextCommit },
    supersedes: ['decision-b'], sourceRefs: ['user-message:decision-c'],
  })
  const current = checkpoint([
    { ...decisionA, status: 'superseded' },
    decisionB,
    decisionC,
  ], { identity: { ...previous.identity, commit: nextCommit } })

  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, true, JSON.stringify(result.errors))
})

test('a historical inactive successor cannot hide two active current branches', () => {
  const decisionA = atom({
    id: 'decision-a', type: 'decision', protection: 'P1', priority: 80,
    assertion: 'Decision A', recoverability: 'source-backed',
  })
  const previous = checkpoint([decisionA])
  const nextCommit = 'b'.repeat(40)
  const decisionB = atom({
    id: 'decision-b', type: 'decision', protection: 'P1', priority: 85,
    assertion: 'Decision B', recoverability: 'source-backed', status: 'superseded',
    supersedes: ['decision-a'], sourceRefs: ['user-message:decision-b'],
  })
  const branch = id => atom({
    id, type: 'decision', protection: 'P1', priority: 90,
    assertion: `Decision ${id}`, recoverability: 'source-backed',
    scope: { ...decisionA.scope, commit: nextCommit },
    supersedes: ['decision-b'], sourceRefs: [`user-message:${id}`],
  })
  const current = checkpoint([
    { ...decisionA, status: 'superseded' },
    decisionB,
    branch('decision-c'),
    branch('decision-d'),
  ], { identity: { ...previous.identity, commit: nextCommit } })

  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('supersedes_target_ambiguous'))
})

test('atom log is parsed and latest complete revisions reproduce the checkpoint', () => {
  const value = checkpoint()
  assert.deepEqual(validateAtomLog(`${JSON.stringify(value.atoms[0])}\n`, value), [])
  assert.ok(codes({ errors: validateAtomLog('not a semantic atom\n', value) }).includes('atom_log_invalid'))
  assert.ok(codes({ errors: validateAtomLog(`${JSON.stringify({ id: 'intent-1' })}\n`, value) }).includes('atom_log_projection_mismatch'))
})

test('dynamic score uses focus, freshness, recoverability and duplicate penalties', () => {
  const make = (id, extra = {}) => atom({ id, type: 'constraint', assertion: id, protection: 'P2', priority: 50, tokenEstimate: 10, recoverability: 'source-backed', ...extra })
  const result = planContext(checkpoint([
    make('focused'), make('normal'), make('stale', { freshness: 'stale' }),
    make('unique', { recoverability: 'irrecoverable' }), make('recompute', { recoverability: 'recomputable' }),
    make('dup-a', { assertion: 'duplicate' }), make('dup-b', { assertion: 'duplicate' }),
  ]), { budgetTokens: 100, currentActionIds: ['focused'], replayVersion: 0 })
  const scores = Object.fromEntries(result.hot.map(item => [item.id, item.effectivePriority]))
  assert.ok(scores.focused > scores.normal)
  assert.ok(scores.normal > scores.stale)
  assert.ok(scores.unique > scores.recompute)
  assert.ok(scores.normal > scores['dup-a'])
  assert.equal(scores['dup-a'], scores['dup-b'])
})

test('manifest file CLI binds source files, logs, plan and recovery status', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-context-cli-'))
  try {
    mkdirSync(join(root, 'context'))
    writeFileSync(join(root, 'source.md'), 'source evidence')
    const value = checkpoint([atom({ sourceRefs: ['file:source.md#evidence'], trust: 'repository-observed' })])
    writeFileSync(join(root, 'context/checkpoint.json'), JSON.stringify(value))
    const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
    const logResult = run(['create-atom-log', 'context/checkpoint.json', '--output', 'context/atoms.jsonl'])
    assert.equal(logResult.status, 0, logResult.stdout)
    assert.equal(run(['create-atom-log', 'context/checkpoint.json', '--output', 'context/atoms.jsonl']).status, 1)
    const creation = run(['create-manifest', 'context/checkpoint.json', '--atom-log', 'context/atoms.jsonl', '--budget-tokens', '2000', '--trigger', 'handoff', '--pressure', 'high', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none', '--output', 'context/manifest.json'])
    assert.equal(creation.status, 0, creation.stdout)
    assert.equal(run(['create-manifest', 'context/checkpoint.json', '--atom-log', 'context/atoms.jsonl', '--budget-tokens', '2000', '--trigger', 'handoff', '--pressure', 'high', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none', '--output', 'context/manifest.json']).status, 1, 'immutable manifest must not be overwritten')
    const manifest = JSON.parse(creation.stdout)
    const publish = candidate => writeFileSync(join(root, 'context/manifest.json'), JSON.stringify(candidate), { flag: 'w' })
    publish(manifest)
    assert.equal(run(['validate-manifest', 'context/manifest.json']).status, 0)
    assert.equal(run(['validate-manifest', 'context/manifest.json', '--require-recovery']).status, 1)
    const lifecycle = (checkpointPath, logPath, outputPath, status, previousPath) => run([
      'create-manifest', checkpointPath, '--atom-log', logPath, '--budget-tokens', '2000',
      '--trigger', 'native-compaction', '--pressure', 'critical', '--provider-kind', 'codex-app-server',
      '--provider-status', status, '--provider-event', `turn:${outputPath}`, '--output', outputPath,
      ...(previousPath ? ['--previous', previousPath] : []),
    ])
    assert.equal(lifecycle('context/checkpoint.json', 'context/atoms.jsonl', 'context/manifest-1-requested.json', 'requested').status, 0)
    assert.equal(lifecycle('context/checkpoint.json', 'context/atoms.jsonl', 'context/manifest-1-succeeded.json', 'succeeded').status, 0)
    assert.equal(run(['validate-manifest', 'context/manifest-1-succeeded.json', '--require-recovery']).status, 0)
    const second = { ...value, identity: { ...value.identity, stage: 'review' } }
    writeFileSync(join(root, 'context/checkpoint-2.json'), JSON.stringify(second))
    assert.equal(run(['create-atom-log', 'context/checkpoint-2.json', '--output', 'context/atoms-2.jsonl']).status, 0)
    assert.equal(lifecycle('context/checkpoint-2.json', 'context/atoms-2.jsonl', 'context/manifest-2-requested.json', 'requested', 'context/checkpoint.json').status, 0)
    assert.equal(lifecycle('context/checkpoint-2.json', 'context/atoms-2.jsonl', 'context/manifest-2-succeeded.json', 'succeeded', 'context/checkpoint.json').status, 0)
    assert.equal(run(['validate-manifest', 'context/manifest-2-succeeded.json', '--require-recovery']).status, 0)
    publish({ ...manifest, sources: [] })
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('manifest_source_missing'))
    publish({ ...manifest, plan: { ...manifest.plan, hot: [] } })
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('manifest_plan_tier_mismatch'))
    publish({ ...manifest, provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: null } })
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('manifest_provider_event_missing'))
    publish(manifest)
    writeFileSync(join(root, 'source.md'), 'changed source')
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('manifest_source_hash_mismatch'))
    writeFileSync(join(root, 'source.md'), 'source evidence')
    writeFileSync(join(root, 'context/atoms.jsonl'), 'changed log')
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('manifest_atom_log_mismatch'))
    publish({ ...manifest, checkpoint: '../source.md' })
    assert.ok(codes(JSON.parse(run(['validate-manifest', 'context/manifest.json']).stdout)).includes('input_invalid'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('valid checkpoint has a deterministic digest', () => {
  const value = checkpoint()
  const first = validateCheckpoint(value)
  const second = validateCheckpoint(JSON.parse(JSON.stringify(value)))
  assert.equal(first.valid, true)
  assert.equal(first.digest, second.digest)
  assert.equal(first.digest, checkpointDigest(value))
  assert.match(first.digest, /^[a-f0-9]{64}$/)
})

test('malformed checkpoint structure reports stable validation errors', () => {
  assert.deepEqual(codes(validateCheckpoint(null)), ['checkpoint_invalid'])
  const result = validateCheckpoint({
    schemaVersion: 2,
    identity: null,
    atoms: [null, {
      id: 'duplicate', type: '', assertion: '', protection: 'P9', priority: 101,
      sourceRefs: [], invalidation: 'never', supersedes: 'none',
    }, {
      id: 'duplicate', type: 'narrative', assertion: 'duplicate id', protection: 'P4', priority: 0,
      sourceRefs: ['artifact:note'], invalidation: [], supersedes: [],
    }],
  })
  assert.equal(result.valid, false)
  for (const code of ['schema_version_unsupported', 'identity_missing', 'atom_invalid', 'atom_id_duplicate', 'atom_type_missing', 'atom_assertion_missing', 'protection_invalid', 'priority_invalid', 'source_refs_missing', 'invalidation_invalid', 'supersedes_invalid']) {
    assert.ok(codes(result).includes(code), code)
  }
})

test('protected atoms cannot disappear across checkpoints', () => {
  const previous = checkpoint([atom()])
  const current = checkpoint([])
  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('protected_atom_missing'))
})

test('unknown cannot become confirmed without a new authoritative source', () => {
  const previous = checkpoint([atom({
    id: 'unknown-1', type: 'unknown', assertion: 'Server review status is unknown',
    certainty: 'unknown', trust: 'unknown', sourceRefs: ['state:.cap/STATE.md'],
  })])
  const current = checkpoint([atom({
    id: 'unknown-1', type: 'unknown', assertion: 'Server review passed',
    certainty: 'confirmed', trust: 'unknown', sourceRefs: ['state:.cap/STATE.md'],
  })])
  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('unknown_upgraded_without_evidence'))
})

test('unknown can be superseded by a newly sourced confirmed atom', () => {
  const previous = checkpoint([atom({
    id: 'unknown-1', type: 'unknown', assertion: 'Server review status is unknown',
    certainty: 'unknown', trust: 'unknown', sourceRefs: ['state:.cap/STATE.md'],
  })])
  const current = checkpoint([atom({
    id: 'evidence-2', type: 'evidence', protection: 'P0',
    assertion: 'Server review passed', trust: 'server-observed',
    sourceRefs: ['server-action:action-1'], recoverability: 'source-backed',
    supersedes: ['unknown-1'],
  })])
  current.atoms.unshift({ ...previous.atoms[0], status: 'superseded' })
  assert.equal(validateCheckpointTransition(previous, current).valid, true)
})

test('local evidence cannot be mutated into server evidence', () => {
  const previous = checkpoint([atom({
    id: 'evidence-1', type: 'evidence', protection: 'P1', trust: 'local-observed',
    assertion: 'Local tests passed', sourceRefs: ['artifact:.cap/verify/local.json'],
    recoverability: 'source-backed',
  })])
  const current = checkpoint([atom({
    id: 'evidence-1', type: 'evidence', protection: 'P1', trust: 'server-observed',
    assertion: 'Server tests passed', sourceRefs: ['server-action:action-1'],
    recoverability: 'source-backed',
  })])
  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('evidence_trust_escalation'))
})

test('active evidence from another commit is stale', () => {
  const value = checkpoint([atom({
    id: 'evidence-1', type: 'evidence', protection: 'P1', trust: 'local-observed',
    assertion: 'Tests passed on the previous commit', recoverability: 'source-backed',
    scope: { taskId: 'task-1', repo: 'example/repo', branch: 'feature/context', commit: 'b'.repeat(40) },
    sourceRefs: ['artifact:.cap/verify/local.json'],
  })])
  const result = validateCheckpoint(value)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('stale_commit_evidence'))
})

test('authorization retains scope and invalidation conditions', () => {
  const value = checkpoint([atom({
    id: 'auth-1', type: 'authorization', assertion: 'Push the candidate commit',
    invalidation: [], sourceRefs: ['user-message:51'],
  })])
  const result = validateCheckpoint(value)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('authorization_invalidation_missing'))
})

test('superseded decisions retain explicit lineage', () => {
  const previous = checkpoint([atom({
    id: 'decision-1', type: 'decision', protection: 'P1', priority: 85,
    assertion: 'Use summary-only compaction', recoverability: 'source-backed',
  })])
  const current = checkpoint([atom({
    id: 'decision-2', type: 'decision', protection: 'P1', priority: 95,
    assertion: 'Use hybrid compaction', recoverability: 'source-backed', supersedes: [],
  })])
  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('decision_lineage_broken'))
})

test('a new decision with explicit supersedes lineage is valid', () => {
  const previous = checkpoint([atom({
    id: 'decision-1', type: 'decision', protection: 'P1', priority: 85,
    assertion: 'Use summary-only compaction', recoverability: 'source-backed',
  })])
  const current = checkpoint([atom({
    id: 'decision-2', type: 'decision', protection: 'P1', priority: 95,
    assertion: 'Use hybrid compaction', recoverability: 'source-backed', supersedes: ['decision-1'], sourceRefs: ['user-message:43'],
  })])
  current.atoms.unshift({ ...previous.atoms[0], status: 'superseded' })
  assert.equal(validateCheckpointTransition(previous, current).valid, true)
})

test('P0 cannot be invalidated without authority or replaced by a weaker successor', () => {
  const previous = checkpoint([atom({ id: 'auth-1', type: 'authorization', assertion: 'Push this commit', invalidation: ['commit changes'] })])
  const invalidated = checkpoint([atom({ id: 'auth-1', type: 'authorization', assertion: 'Push this commit', status: 'invalidated', invalidation: ['commit changes'] })])
  assert.ok(codes(validateCheckpointTransition(previous, invalidated)).includes('protected_atom_missing'))

  const weaker = checkpoint([atom({
    id: 'chitchat-1', type: 'chitchat', protection: 'P4', priority: 0,
    assertion: 'Thanks', trust: 'user-stated', sourceRefs: ['user-message:52'],
    recoverability: 'recomputable', supersedes: ['auth-1'],
  })])
  const result = validateCheckpointTransition(previous, weaker)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('supersedes_type_incompatible'))
  assert.ok(codes(result).includes('supersedes_protection_downgraded'))
})

test('checkpoint requires complete scope, status, trust and certainty schema', () => {
  const candidate = checkpoint([atom({ scope: undefined, trust: undefined, status: undefined, certainty: undefined, recoverability: undefined })])
  const result = validateCheckpoint(candidate)
  assert.equal(result.valid, false)
  for (const code of ['scope_missing', 'trust_invalid', 'status_invalid', 'certainty_invalid', 'recoverability_invalid']) assert.ok(codes(result).includes(code))
})

test('confirmed unknown requires a trust-matched authoritative source', () => {
  const previous = checkpoint([atom({ id: 'unknown-1', type: 'unknown', assertion: 'Review is unknown', certainty: 'unknown', trust: 'unknown', sourceRefs: ['state:.cap/STATE.md'] })])
  const forged = checkpoint([atom({ id: 'unknown-1', type: 'unknown', assertion: 'Review passed', certainty: 'confirmed', trust: 'server-observed', sourceRefs: ['garbage:forged'] })])
  assert.ok(codes(validateCheckpoint(forged)).includes('source_ref_scheme_invalid'))
  assert.equal(validateCheckpointTransition(previous, forged).valid, false)
})

test('a summary cannot certify its own claim', () => {
  const result = validateCheckpoint(checkpoint([atom({ sourceRefs: ['summary:.cap/context/summary.md'] })]))
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('self_certified_atom'))
})

test('an existing protection floor cannot be lowered', () => {
  const previous = checkpoint([atom({ type: 'constraint', protection: 'P1' })])
  const current = checkpoint([atom({ type: 'constraint', protection: 'P2' })])
  const result = validateCheckpointTransition(previous, current)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('protection_downgraded'))
})

test('legacy underprotected predecessors can be repaired but protected intent cannot disappear', () => {
  const previous = checkpoint([atom({ protection: 'P2' })])
  assert.equal(validateCheckpoint(previous).valid, false)
  assert.equal(validateCheckpointTransition(previous, checkpoint([atom()])).valid, true)
  const unrelated = atom({ id: 'another-intent', assertion: 'Different intent' })
  assert.ok(codes(validateCheckpointTransition(previous, checkpoint([unrelated]))).includes('protected_atom_missing'))
})

test('revoked authorization cannot be laundered through an intermediate snapshot that deletes history', () => {
  const authorization = atom({ id: 'approval', type: 'authorization', assertion: 'Local changes only' })
  const before = checkpoint([atom(), authorization])
  const revoked = checkpoint([atom(), { ...authorization, status: 'invalidated', sourceRefs: [...authorization.sourceRefs, 'user-message:revoke'] }])
  assert.equal(validateCheckpointTransition(before, revoked).valid, true)
  const erased = checkpoint([atom()])
  const result = validateCheckpointTransition(revoked, erased)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('atom_history_missing'))
  assert.ok(codes(validateCheckpointTransition(revoked, before)).includes('terminal_atom_reactivated'))
})

test('context plan protects P0 and ranks remaining atoms into tiers', () => {
  const atoms = [
    atom({ tokenEstimate: 40 }),
    atom({ id: 'next-1', type: 'next_action', protection: 'P1', priority: 90, assertion: 'Run tests', recoverability: 'source-backed', tokenEstimate: 20 }),
    atom({ id: 'evidence-1', type: 'evidence', protection: 'P2', priority: 80, assertion: 'Large tool output indexed', trust: 'local-observed', recoverability: 'source-backed', sourceRefs: ['artifact:logs/build.txt'], tokenEstimate: 50 }),
    atom({ id: 'narrative-1', type: 'narrative', protection: 'P3', priority: 30, assertion: 'Repeated exploration', trust: 'model-derived', certainty: 'hypothesis', sourceRefs: ['model:exploration'], recoverability: 'recomputable', tokenEstimate: 30 }),
    atom({ id: 'chat-1', type: 'chitchat', protection: 'P4', priority: 0, assertion: 'Thanks', trust: 'user-stated', recoverability: 'irrecoverable', tokenEstimate: 10 }),
  ]
  const result = planContext(checkpoint(atoms), { budgetTokens: 70 })
  assert.equal(result.valid, true)
  assert.deepEqual(result.hot.map(item => item.id), ['intent-1', 'next-1'])
  assert.deepEqual(result.warm.map(item => item.id), ['evidence-1'])
  assert.deepEqual(result.cold.map(item => item.id), ['narrative-1'])
  assert.deepEqual(result.dropped.map(item => item.id), ['chat-1'])
  assert.ok(result.hot[0].scoreReasons)
})

test('planning excludes inactive P0 from the hot budget', () => {
  const result = planContext(checkpoint([atom({ status: 'invalidated', tokenEstimate: 80 })]), { budgetTokens: 0 })
  assert.equal(result.valid, true)
  assert.equal(result.hot.length, 0)
  assert.deepEqual(result.cold.map(item => item.id), ['intent-1'])
})

test('protected budget overflow fails closed', () => {
  const result = planContext(checkpoint([atom({ tokenEstimate: 80 })]), { budgetTokens: 40 })
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('protected_budget_overflow'))
  assert.deepEqual(result.hot.map(item => item.id), ['intent-1'])
})

test('pressure classification uses configurable production defaults', () => {
  assert.equal(classifyPressure(54, 100), 'low')
  assert.equal(classifyPressure(55, 100), 'medium')
  assert.equal(classifyPressure(70, 100), 'high')
  assert.equal(classifyPressure(82, 100), 'critical')
})

test('invalid pressure thresholds and context budgets fail closed', () => {
  assert.throws(() => classifyPressure(-1, 100), /token counts/)
  assert.throws(() => classifyPressure(50, 0), /contextWindow/)
  assert.throws(() => classifyPressure(50, 100, { medium: 0.8, high: 0.7 }), /thresholds/)
  const result = planContext(checkpoint(), { budgetTokens: Number.NaN })
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('budget_invalid'))
})

test('CLI validate reports stable error codes and exits non-zero', () => {
  const invalid = checkpoint([atom({ id: 'auth-1', type: 'authorization', invalidation: [] })])
  const run = spawnSync(process.execPath, [script, 'validate', '-'], {
    input: JSON.stringify(invalid), encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  const result = JSON.parse(run.stdout)
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('authorization_invalidation_missing'))
})

test('CLI plan succeeds and malformed JSON fails with a stable input code', () => {
  const planned = spawnSync(process.execPath, [script, 'plan', '-', '--budget-tokens', '1000'], {
    input: JSON.stringify(checkpoint()), encoding: 'utf8',
  })
  assert.equal(planned.status, 0)
  assert.equal(JSON.parse(planned.stdout).hot[0].id, 'intent-1')

  const malformed = spawnSync(process.execPath, [script, 'validate', '-'], {
    input: '{', encoding: 'utf8',
  })
  assert.equal(malformed.status, 1)
  assert.deepEqual(codes(JSON.parse(malformed.stdout)), ['input_invalid'])

  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(usage.status, 1)
  assert.deepEqual(codes(JSON.parse(usage.stdout)), ['cli_usage_invalid'])
})

test('transition CLI enforces previous/current semantics', () => {
  const previous = checkpoint([atom()])
  const current = checkpoint([])
  const run = spawnSync(process.execPath, [script, 'transition', '-'], {
    input: JSON.stringify({ previous, current }), encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.ok(codes(JSON.parse(run.stdout)).includes('protected_atom_missing'))
})

test('manifest binds checkpoint, previous state, atom log, plan and provider event', () => {
  const previous = checkpoint([atom()])
  const current = checkpoint([atom({ id: 'intent-2', assertion: 'Updated intent', sourceRefs: ['user-message:43'], supersedes: ['intent-1'] })])
  current.atoms.unshift({ ...previous.atoms[0], status: 'superseded' })
  const atomLogContent = `${current.atoms.map(atom => JSON.stringify(atom)).join('\n')}\n`
  const manifest = createManifest(current, {
    checkpointPath: '.cap/context/checkpoint.json', previous, previousPath: '.cap/context/previous.json',
    atomLogPath: '.cap/context/atoms.jsonl', atomLogContent, budgetTokens: 200,
    trigger: 'stage-handoff', pressure: 'high',
    provider: { kind: 'codex-app-server', status: 'succeeded', eventRef: 'turn:42/item:compact-1' },
  })
  const ok = validateManifest(manifest, { checkpoint: current, previous, atomLogContent, requireRecovery: true })
  assert.equal(ok.valid, true)
  const tampered = { ...manifest, digest: '0'.repeat(64) }
  assert.ok(codes(validateManifest(tampered, { checkpoint: current, previous, atomLogContent })).includes('manifest_digest_mismatch'))
  assert.ok(codes(validateManifest({ ...manifest, provider: { ...manifest.provider, status: 'running' } }, { checkpoint: current, previous, atomLogContent, requireRecovery: true })).includes('provider_compaction_not_succeeded'))
})
