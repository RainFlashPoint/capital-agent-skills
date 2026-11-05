import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch, mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContextBinding, captureCoverageRequirements, inspectSemanticContext } from './cap-context-gate.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { prepareContext } from './cap-context-preparation.mjs'
import { recoveryPages } from './cap-context-recovery-pages.mjs'
import { inspectTaskContext } from './cap-runtime.mjs'
import { handleContextHook, recoverContextHook, codexHooksConfig } from './cap-context-hooks.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const environment = { CAPITAL_AGENT_MODE: 'local', PATH: process.env.PATH, HOME: process.env.HOME }

test('large Unicode receipts split into complete bounded UTF-8 pages', () => {
  const content = '授权来源：用户确认。'.repeat(4000)
  const pages = recoveryPages(content)
  assert.ok(pages.length > 1)
  assert.ok(pages.every(page => Buffer.byteLength(page) <= 4096))
  assert.equal(pages.join(''), content)
})

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

async function refreshTaskContextFingerprints(repo) {
  const fingerprints = await inspectContextFingerprint(repo)
  const taskContextPath = join(repo, '.cap/task-context.md')
  let taskContext = readFileSync(taskContextPath, 'utf8')
  taskContext = taskContext
    .replace(/^- index-fingerprint:.*$/m, `- index-fingerprint: ${fingerprints.index}`)
    .replace(/^- worktree-fingerprint:.*$/m, `- worktree-fingerprint: ${fingerprints.worktree}`)
    .replace(/^- untracked-fingerprint:.*$/m, `- untracked-fingerprint: ${fingerprints.untracked}`)
  writeFileSync(taskContextPath, taskContext)
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
    if (!event) {
      assert.equal(first.outputMode, 'compact')
      assert.equal(first.recovery, null)
      assert.match(first.nextAction, /No recovery replay is required/)
    }
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

test('prepare canonicalizes a content-identical checkpoint instead of publishing a duplicate snapshot', async t => {
  const { repo, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const duplicatePath = '.cap/context/checkpoint-implement-duplicate.json'
  writeFileSync(join(repo, duplicatePath), readFileSync(join(repo, path), 'utf8'))
  const snapshot = () => [join(repo, '.cap/STATE.md'), ...readdirSync(join(repo, '.cap/context')).sort().map(name => join(repo, '.cap/context', name))]
    .map(file => ({ file, content: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs }))
  const before = snapshot()

  const reused = await prepareContext(repo, { checkpointPath: duplicatePath, budgetTokens: 20000, environment })

  assert.equal(reused.valid, true, JSON.stringify(reused))
  assert.equal(reused.reused, true)
  assert.equal(reused.outputMode, 'compact')
  assert.equal(reused.checkpoint, path)
  assert.equal(reused.ignoredCheckpoint, duplicatePath)
  assert.equal(reused.manifest, first.manifest)
  assert.equal(Object.hasOwn(reused, 'recovery'), false)
  assert.deepEqual(snapshot(), before)
})

for (const [name, mutate, reason] of [
  ['identity', manifest => { manifest.identity.taskId = 'forged-task' }, 'context_manifest_invalid'],
  ['predecessor pointer', manifest => { manifest.entry.previousManifest = '.cap/context/forged.json' }, 'context_manifest_invalid'],
  ['source projection', manifest => { manifest.sources.find(source => source.path === '.cap/task-context.md').projection = 'forged-projection' }, 'context_manifest_invalid'],
]) {
  test(`prepare cannot replace a published manifest with tampered ${name}`, async t => {
    const { repo, checkpoint, path } = await fixture(t)
    const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
    assert.equal(first.valid, true, JSON.stringify(first))
    const manifestPath = join(repo, first.manifest)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    mutate(manifest)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.equal((await inspectSemanticContext(repo, { environment })).reason, reason)
    const duplicatePath = `.cap/context/checkpoint-tampered-${name.replaceAll(' ', '-')}.json`
    writeFileSync(join(repo, duplicatePath), readFileSync(join(repo, path), 'utf8'))

    const blocked = await prepareContext(repo, { checkpointPath: duplicatePath, budgetTokens: 20000, environment })

    assert.equal(blocked.valid, false, JSON.stringify(blocked))
    assert.ok(blocked.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(blocked))
    assert.equal((await inspectSemanticContext(repo, { environment })).reason, reason)

    const successor = structuredClone(checkpoint)
    successor.atoms.push({ ...successor.atoms[0], id: `successor-${name.replaceAll(' ', '-')}`, type: 'constraint', protection: 'P2', assertion: 'A legitimate successor cannot repair damaged predecessor evidence' })
    const successorPath = `.cap/context/checkpoint-successor-${name.replaceAll(' ', '-')}.json`
    writeFileSync(join(repo, successorPath), JSON.stringify(successor))
    const successorResult = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, environment })
    assert.equal(successorResult.valid, false, JSON.stringify(successorResult))
    assert.ok(successorResult.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(successorResult))
  })
}

test('prepare does not silently replace a damaged recovery receipt without an observed event', async t => {
  const { repo, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:receipt', environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const receiptPath = state.match(/^context-recovery-receipt: (.+)$/m)[1]
  writeFileSync(join(repo, receiptPath), JSON.stringify({ ...first.recovery, digest: 'tampered' }))
  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_recovery_required')

  const blocked = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })

  assert.equal(blocked.valid, false, JSON.stringify(blocked))
  assert.ok(blocked.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(blocked))
})

for (const damage of ['tampered', 'missing']) {
  test(`prepare cannot rebuild a ${damage} recovery receipt with the same visible event`, async t => {
    const { repo, path } = await fixture(t)
    const event = 'visible-resume:same-event'
    const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event, environment })
    assert.equal(first.valid, true, JSON.stringify(first))
    const state = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
    const receiptPath = state.match(/^context-recovery-receipt: (.+)$/m)[1]
    if (damage === 'missing') rmSync(join(repo, receiptPath))
    else writeFileSync(join(repo, receiptPath), JSON.stringify({ ...first.recovery, digest: 'tampered' }))
    assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_recovery_required')

    const blocked = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event, environment })

    assert.equal(blocked.valid, false, JSON.stringify(blocked))
    assert.ok(blocked.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(blocked))
  })
}

test('manifest source-hash tampering cannot be hidden by real source drift or a low-level successor', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const manifestPath = join(repo, first.manifest)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.sources.find(source => source.path === '.cap/task-context.md').sha256 = '0'.repeat(64)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  await refreshTaskContextFingerprints(repo)

  const same = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(same.valid, false, JSON.stringify(same))
  assert.ok(same.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(same))

  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'source-drift-successor', type: 'constraint', protection: 'P2', assertion: 'Real source drift cannot repair manifest tampering' })
  const successorPath = '.cap/context/checkpoint-source-drift-successor.json'
  const atomLogPath = '.cap/context/atoms-source-drift-successor.jsonl'
  writeFileSync(join(repo, successorPath), JSON.stringify(successor))
  writeFileSync(join(repo, atomLogPath), `${successor.atoms.map(atom => JSON.stringify(atom)).join('\n')}\n`)
  const next = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, environment })
  assert.equal(next.valid, false, JSON.stringify(next))
  assert.ok(next.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(next))

  const lowLevel = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-context-checkpoint.mjs'),
    'create-manifest', join(repo, successorPath), '--bind-entry', repo, '--previous', join(repo, path),
    '--atom-log', join(repo, atomLogPath), '--budget-tokens', '20000', '--trigger', 'stage-entry',
    '--pressure', 'unknown', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none',
    '--output', join(repo, '.cap/context/manifest-low-level-successor.json'),
  ], { cwd: repo, env: environment, encoding: 'utf8' })
  assert.equal(lowLevel.status, 1, lowLevel.stdout + lowLevel.stderr)
  assert.equal(JSON.parse(lowLevel.stdout).valid, false, lowLevel.stdout)
  assert.throws(() => readFileSync(join(repo, '.cap/context/manifest-low-level-successor.json')), /ENOENT/)
})

test('same-event receipt pointer loss plus source drift cannot mint a replacement receipt', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const event = 'visible-resume:pointer-loss'
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/^context-recovery-receipt: .*$/m, 'context-recovery-receipt: none'))
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  await refreshTaskContextFingerprints(repo)

  const same = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event, environment })
  assert.equal(same.valid, false, JSON.stringify(same))
  assert.ok(same.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(same))

  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'receipt-pointer-successor', type: 'constraint', protection: 'P2', assertion: 'Source drift cannot replace a same-event receipt pointer' })
  const successorPath = '.cap/context/checkpoint-receipt-pointer-successor.json'
  writeFileSync(join(repo, successorPath), JSON.stringify(successor))
  const next = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, event, environment })
  assert.equal(next.valid, false, JSON.stringify(next))
  assert.ok(next.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(next))
})

test('a successor binds the direct predecessor manifest bytes and rejects later ancestor tampering', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'bound-ancestor', type: 'constraint', protection: 'P2', assertion: 'Bind the direct predecessor manifest bytes' })
  const successorPath = '.cap/context/checkpoint-bound-ancestor.json'
  writeFileSync(join(repo, successorPath), JSON.stringify(successor))
  const second = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, environment })
  assert.equal(second.valid, true, JSON.stringify(second))
  const secondManifest = JSON.parse(readFileSync(join(repo, second.manifest), 'utf8'))
  assert.match(secondManifest.entry.previousManifestSha256, /^[a-f0-9]{64}$/)

  const firstManifestPath = join(repo, first.manifest)
  const firstManifest = JSON.parse(readFileSync(firstManifestPath, 'utf8'))
  firstManifest.identity.taskId = 'forged-ancestor-task'
  writeFileSync(firstManifestPath, JSON.stringify(firstManifest))
  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_manifest_invalid')

  const third = structuredClone(successor)
  third.atoms.push({ ...third.atoms[0], id: 'third-snapshot', type: 'constraint', protection: 'P2', assertion: 'A later snapshot cannot wash the ancestor' })
  const thirdPath = '.cap/context/checkpoint-third.json'
  writeFileSync(join(repo, thirdPath), JSON.stringify(third))
  const blocked = await prepareContext(repo, { checkpointPath: thirdPath, budgetTokens: 20000, environment })
  assert.equal(blocked.valid, false, JSON.stringify(blocked))
  assert.ok(blocked.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(blocked))
})

test('recursive integrity rejects a split checkpoint and manifest predecessor chain', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))

  const alternate = structuredClone(checkpoint)
  alternate.atoms.push({ ...alternate.atoms[0], id: 'alternate-predecessor', type: 'constraint', protection: 'P2', assertion: 'Alternate predecessor branch' })
  const alternatePath = '.cap/context/checkpoint-alternate-predecessor.json'
  const alternateLogPath = '.cap/context/atoms-alternate-predecessor.jsonl'
  const alternateManifestPath = '.cap/context/manifest-alternate-predecessor.json'
  writeFileSync(join(repo, alternatePath), JSON.stringify(alternate))
  writeFileSync(join(repo, alternateLogPath), `${alternate.atoms.map(atom => JSON.stringify(atom)).join('\n')}\n`)
  const alternateResult = spawnSync(process.execPath, [
    join(packageRoot, 'scripts/cap-context-checkpoint.mjs'), 'create-manifest', alternatePath, '--bind-entry', repo, '--previous', path,
    '--atom-log', alternateLogPath, '--budget-tokens', '20000', '--trigger', 'stage-entry',
    '--pressure', 'unknown', '--provider-kind', 'none', '--provider-status', 'unavailable', '--provider-event', 'none',
    '--output', alternateManifestPath,
  ], { cwd: repo, env: environment, encoding: 'utf8' })
  assert.equal(alternateResult.status, 0, alternateResult.stdout + alternateResult.stderr)

  const middle = structuredClone(checkpoint)
  middle.atoms.push({ ...middle.atoms[0], id: 'middle-predecessor', type: 'constraint', protection: 'P2', assertion: 'Middle predecessor branch' })
  const middlePath = '.cap/context/checkpoint-middle-predecessor.json'
  writeFileSync(join(repo, middlePath), JSON.stringify(middle))
  const second = await prepareContext(repo, { checkpointPath: middlePath, budgetTokens: 20000, environment })
  assert.equal(second.valid, true, JSON.stringify(second))

  const current = structuredClone(middle)
  current.atoms.push({ ...current.atoms[0], id: 'current-predecessor', type: 'constraint', protection: 'P2', assertion: 'Current predecessor branch' })
  const currentPath = '.cap/context/checkpoint-current-predecessor.json'
  writeFileSync(join(repo, currentPath), JSON.stringify(current))
  const third = await prepareContext(repo, { checkpointPath: currentPath, budgetTokens: 20000, environment })
  assert.equal(third.valid, true, JSON.stringify(third))

  const alternateManifestText = readFileSync(join(repo, alternateManifestPath), 'utf8')
  const alternateManifest = JSON.parse(alternateManifestText)
  const middleManifestPath = join(repo, second.manifest)
  const middleManifest = JSON.parse(readFileSync(middleManifestPath, 'utf8'))
  middleManifest.entry.previousManifest = alternateManifestPath
  middleManifest.entry.previousDigest = alternateManifest.digest
  middleManifest.entry.previousManifestSha256 = createHash('sha256').update(alternateManifestText).digest('hex')
  const middleManifestText = JSON.stringify(middleManifest)
  writeFileSync(middleManifestPath, middleManifestText)

  const currentManifestPath = join(repo, third.manifest)
  const currentManifest = JSON.parse(readFileSync(currentManifestPath, 'utf8'))
  currentManifest.entry.previousManifestSha256 = createHash('sha256').update(middleManifestText).digest('hex')
  const currentManifestText = JSON.stringify(currentManifest)
  writeFileSync(currentManifestPath, currentManifestText)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/^context-manifest-sha256:.*$/m, `context-manifest-sha256: ${createHash('sha256').update(currentManifestText).digest('hex')}`))

  const blocked = await inspectSemanticContext(repo, { environment })
  assert.equal(blocked.reason, 'context_manifest_invalid', JSON.stringify(blocked))
})

test('recursive integrity rejects lexical traversal in an ancestor manifest pointer', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const middle = structuredClone(checkpoint)
  middle.atoms.push({ ...middle.atoms[0], id: 'ancestor-traversal-middle', type: 'constraint', protection: 'P2', assertion: 'Middle snapshot' })
  const middlePath = '.cap/context/checkpoint-ancestor-traversal-middle.json'
  writeFileSync(join(repo, middlePath), JSON.stringify(middle))
  const second = await prepareContext(repo, { checkpointPath: middlePath, budgetTokens: 20000, environment })
  assert.equal(second.valid, true, JSON.stringify(second))
  const current = structuredClone(middle)
  current.atoms.push({ ...current.atoms[0], id: 'ancestor-traversal-current', type: 'constraint', protection: 'P2', assertion: 'Current snapshot' })
  const currentPath = '.cap/context/checkpoint-ancestor-traversal-current.json'
  writeFileSync(join(repo, currentPath), JSON.stringify(current))
  const third = await prepareContext(repo, { checkpointPath: currentPath, budgetTokens: 20000, environment })
  assert.equal(third.valid, true, JSON.stringify(third))

  const middleManifestPath = join(repo, second.manifest)
  const middleManifest = JSON.parse(readFileSync(middleManifestPath, 'utf8'))
  middleManifest.entry.previousManifest = middleManifest.entry.previousManifest.replace('.cap/context/', '.cap/context/unused/../')
  const middleManifestText = JSON.stringify(middleManifest)
  writeFileSync(middleManifestPath, middleManifestText)
  const currentManifestPath = join(repo, third.manifest)
  const currentManifest = JSON.parse(readFileSync(currentManifestPath, 'utf8'))
  currentManifest.entry.previousManifestSha256 = createHash('sha256').update(middleManifestText).digest('hex')
  const currentManifestText = JSON.stringify(currentManifest)
  writeFileSync(currentManifestPath, currentManifestText)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/^context-manifest-sha256:.*$/m, `context-manifest-sha256: ${createHash('sha256').update(currentManifestText).digest('hex')}`))

  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_manifest_invalid')
})

test('recovery receipt pointers cannot traverse outside the context directory', async t => {
  const { repo, path } = await fixture(t)
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:receipt-traversal', environment })
  assert.equal(result.valid, true, JSON.stringify(result))
  const statePath = join(repo, '.cap/STATE.md')
  const state = readFileSync(statePath, 'utf8')
  const receiptPath = state.match(/^context-recovery-receipt: (.+)$/m)[1]
  mkdirSync(join(repo, '.cap/escaped'), { recursive: true })
  const escapedReceipt = '.cap/context/../escaped/recovery.json'
  writeFileSync(join(repo, '.cap/escaped/recovery.json'), readFileSync(join(repo, receiptPath), 'utf8'))
  const manifestPath = join(repo, result.manifest)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.entry.recoveryReceipt = escapedReceipt
  const manifestText = JSON.stringify(manifest)
  writeFileSync(manifestPath, manifestText)
  writeFileSync(statePath, state
    .replace(/^context-recovery-receipt:.*$/m, `context-recovery-receipt: ${escapedReceipt}`)
    .replace(/^context-manifest-sha256:.*$/m, `context-manifest-sha256: ${createHash('sha256').update(manifestText).digest('hex')}`))

  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_recovery_required')
})

test('prepare rejects a noncanonical STATE receipt before publishing a successor', async t => {
  const { repo, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:receipt-original', environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const statePath = join(repo, '.cap/STATE.md')
  const state = readFileSync(statePath, 'utf8')
  const receiptPath = state.match(/^context-recovery-receipt: (.+)$/m)[1]
  mkdirSync(join(repo, '.cap/escaped'), { recursive: true })
  writeFileSync(join(repo, '.cap/escaped/recovery-valid.json'), readFileSync(join(repo, receiptPath), 'utf8'))
  const escapedReceipt = '.cap/context/../escaped/recovery-valid.json'
  writeFileSync(statePath, state
    .replace(/^context-recovery-event:.*$/m, 'context-recovery-event: visible-resume:receipt-next')
    .replace(/^context-recovery-receipt:.*$/m, `context-recovery-receipt: ${escapedReceipt}`))
  const manifestsBefore = readdirSync(join(repo, '.cap/context')).filter(name => name.startsWith('manifest-')).sort()

  const blocked = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible-resume:receipt-next', environment })

  assert.equal(blocked.valid, false, JSON.stringify(blocked))
  assert.ok(blocked.errors.some(error => error.code === 'context_recovery_receipt_path_invalid'), JSON.stringify(blocked))
  assert.deepEqual(readdirSync(join(repo, '.cap/context')).filter(name => name.startsWith('manifest-')).sort(), manifestsBefore)
  assert.equal(readFileSync(statePath, 'utf8').match(/^context-manifest: (.+)$/m)[1], first.manifest)
})

test('prepare accepts a newly added optional spec source when the successor covers it', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  writeFileSync(join(repo, '.cap/spec.md'), '## Acceptance criteria\n- Preserve the documented behavior\n')
  const requirements = await captureCoverageRequirements(repo, { environment })
  const successor = structuredClone(checkpoint)
  const covered = new Set(successor.coverage.map(item => item.id))
  for (const [index, requirement] of requirements.entries()) {
    if (covered.has(requirement.id)) continue
    const atomId = `new-spec-${index}`
    successor.atoms.push({ id: atomId, type: requirement.types[0], assertion: `Cover ${requirement.label}`, protection: requirement.minProtection, priority: 90, scope: successor.identity, sourceRefs: [requirement.sourceRef], trust: 'repository-observed', status: 'active', certainty: 'confirmed', recoverability: 'source-backed', invalidation: [], supersedes: [] })
    successor.coverage.push({ id: requirement.id, atomIds: [atomId] })
  }
  const successorPath = '.cap/context/checkpoint-new-spec.json'
  writeFileSync(join(repo, successorPath), JSON.stringify(successor))

  const result = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, environment })

  assert.equal(result.valid, true, JSON.stringify(result))
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
})

test('a versioned manifest cannot downgrade to legacy when the STATE manifest SHA is removed', async t => {
  const { repo, checkpoint, path } = await fixture(t)
  const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const manifestPath = join(repo, first.manifest)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.integrityVersion, 1)
  const statePath = join(repo, '.cap/STATE.md')
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/^context-manifest-sha256:.*\n?/m, ''))
  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_manifest_invalid')

  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_manifest_invalid')
  const successor = structuredClone(checkpoint)
  successor.atoms.push({ ...successor.atoms[0], id: 'no-integrity-downgrade', type: 'constraint', protection: 'P2', assertion: 'Missing STATE SHA cannot downgrade a versioned manifest' })
  const successorPath = '.cap/context/checkpoint-no-integrity-downgrade.json'
  writeFileSync(join(repo, successorPath), JSON.stringify(successor))
  const blocked = await prepareContext(repo, { checkpointPath: successorPath, budgetTokens: 20000, environment })
  assert.equal(blocked.valid, false, JSON.stringify(blocked))
  assert.ok(blocked.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(blocked))
})

for (const field of ['sessionId', 'runtimeSessionId']) {
  test(`prepare cannot treat a tampered entry ${field} as a legitimate session handoff`, async t => {
    const { repo, path } = await fixture(t)
    const first = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
    assert.equal(first.valid, true, JSON.stringify(first))
    const manifestPath = join(repo, first.manifest)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.entry[field] = `forged-${field}`
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.equal((await inspectSemanticContext(repo, { environment })).reason, 'context_identity_changed')

    const samePath = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment })
    assert.equal(samePath.valid, false, JSON.stringify(samePath))
    assert.ok(samePath.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(samePath))

    const duplicatePath = `.cap/context/checkpoint-tampered-${field}.json`
    writeFileSync(join(repo, duplicatePath), readFileSync(join(repo, path), 'utf8'))
    const duplicate = await prepareContext(repo, { checkpointPath: duplicatePath, budgetTokens: 20000, environment })
    assert.equal(duplicate.valid, false, JSON.stringify(duplicate))
    assert.ok(duplicate.errors.some(error => error.code === 'context_published_predecessor_invalid'), JSON.stringify(duplicate))
  })
}

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
  await refreshTaskContextFingerprints(repo)

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

test('CLI recovery is bounded and every page reconstructs the exact verified receipt', async t => {
  const { repo, path } = await fixture(t)
  const event = 'visible-resume:paged-cli'
  const prepared = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event, environment })
  assert.equal(prepared.valid, true)
  const run = (...args) => spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-context-checkpoint.mjs'), ...args], { cwd: repo, env: environment, encoding: 'utf8' })
  const summaryResult = run('prepare', repo, '--checkpoint', path, '--budget-tokens', '20000', '--event', event)
  assert.equal(summaryResult.status, 0, summaryResult.stdout + summaryResult.stderr)
  const summary = JSON.parse(summaryResult.stdout)
  assert.equal(summary.outputMode, 'compact')
  const resumed = run('resume', repo, '--event', 'visible-resume:paged-cli-next')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  const projected = JSON.parse(resumed.stdout)
  assert.equal(projected.outputMode, 'recovery-paged')
  assert.equal(projected.recovery.hotCount, prepared.recovery.hot.length)
  assert.equal(projected.recovery.hot, undefined)
  assert.ok(Buffer.byteLength(resumed.stdout) < 3000)
  const pages = []
  for (let page = 1; page <= projected.recovery.pageCount; page++) {
    const read = run('read-recovery', repo, '--event', projected.event, '--digest', projected.recovery.digest, '--page', String(page))
    assert.equal(read.status, 0, read.stdout + read.stderr)
    const chunk = JSON.parse(read.stdout)
    assert.equal(chunk.page, page)
    assert.equal(chunk.pageCount, projected.recovery.pageCount)
    assert.equal(createHash('sha256').update(chunk.content).digest('hex'), chunk.pageSha256)
    pages.push(chunk.content)
  }
  assert.equal(createHash('sha256').update(pages.join('')).digest('hex'), projected.recovery.sha256)
  assert.deepEqual(JSON.parse(pages.join('')), JSON.parse(readFileSync(join(repo, projected.recovery.path), 'utf8')))
  const reboundResult = run('prepare', repo, '--checkpoint', path, '--budget-tokens', '20000', '--event', projected.event)
  assert.equal(reboundResult.status, 0, reboundResult.stdout + reboundResult.stderr)
  const rebound = JSON.parse(reboundResult.stdout)
  assert.equal(rebound.valid, true)
  assert.equal(rebound.outputMode, 'compact')
  assert.equal(rebound.recovery, null)
  assert.equal(rebound.recoveryPages.sha256, projected.recovery.sha256)
  const afterBind = run('read-recovery', repo, '--event', projected.event, '--digest', projected.recovery.digest, '--page', '1')
  assert.equal(afterBind.status, 0, afterBind.stdout + afterBind.stderr)
  const wrong = run('read-recovery', repo, '--event', projected.event, '--digest', 'bad', '--page', '1')
  assert.equal(wrong.status, 1)
  assert.match(wrong.stdout, /recovery_digest_mismatch/)
  const missing = run('read-recovery', repo, '--event', projected.event, '--digest', projected.recovery.digest, '--page', String(projected.recovery.pageCount + 1))
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /recovery_page_invalid/)
  writeFileSync(join(repo, 'source.js'), 'export const value = 2\n')
  const drifted = run('read-recovery', repo, '--event', projected.event, '--digest', projected.recovery.digest, '--page', '1')
  assert.equal(drifted.status, 1)
  assert.match(drifted.stdout, /recovery_sources_changed/)
  writeFileSync(join(repo, 'source.js'), 'export const value = 1\n')
  const receipt = JSON.parse(readFileSync(join(repo, projected.recovery.path), 'utf8'))
  receipt.hot[0].assertion = 'tampered'
  writeFileSync(join(repo, projected.recovery.path), JSON.stringify(receipt))
  const damaged = run('read-recovery', repo, '--event', projected.event, '--digest', projected.recovery.digest, '--page', '1')
  assert.equal(damaged.status, 1)
  assert.match(damaged.stdout, /recovery_receipt_invalid|recovery_snapshot_invalid/)
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

test('retired global adapter always continues without touching shared repositories', async t => {
  const { repo, path } = await fixture(t)
  const before = readFileSync(join(repo, '.cap/STATE.md'), 'utf8')
  const files = readdirSync(join(repo, '.cap/context')).sort()
  for (const session_id of ['fresh-runtime', 'foreign-runtime']) {
    for (const hook_event_name of ['PreCompact', 'PostCompact', 'PreToolUse', 'PostToolUse']) {
      assert.deepEqual(await handleContextHook({ cwd: repo, session_id, hook_event_name }), { continue: true })
    }
  }
  assert.deepEqual(await handleContextHook(null), { continue: true })
  assert.deepEqual(await handleContextHook({ cwd: '/missing', session_id: 'invalid /', hook_event_name: 'unknown' }), { continue: true })
  assert.equal((await recoverContextHook(repo, { sessionId: 'fresh-runtime', reviewedManifest: path })).code, 'native_hooks_removed')
  assert.equal(codexHooksConfig().supported, false)
  assert.equal(codexHooksConfig().toml, '')
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), before)
  assert.deepEqual(readdirSync(join(repo, '.cap/context')).sort(), files)
})

test('cached global CLI commands never deny tools even with malformed metadata', () => {
  for (const input of ['', '{broken', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/missing', session_id: 'new' })]) {
    const result = spawnSync(process.execPath, [join(packageRoot, 'scripts/cap-context-hooks.mjs')], { input, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { continue: true })
    assert.equal(result.stderr, '')
  }
})

test('retired private native records cannot block explicit checkpoint recovery gates', async t => {
  const { repo, path } = await fixture(t)
  const env = { ...environment, CODEX_THREAD_ID: 'legacy-native-runtime', CAPITAL_AGENT_SESSION_LOCK_DIR: join(repo, '.cap/session-locks') }
  await inspectSessionRoot({ repoRoot: repo, environment: env })
  assert.equal((await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, environment: env })).valid, true)
  const { createHash } = await import('node:crypto')
  const suffix = createHash('sha256').update(env.CODEX_THREAD_ID).digest('hex')
  writeFileSync(join(repo, `.cap/context/codex-pending-${suffix}.json`), '{broken retired marker')
  writeFileSync(join(repo, `.cap/context/codex-hook-${suffix}.json`), JSON.stringify({ phase: 'blocked', failureCode: 'session_root_uninitialized' }))
  assert.equal((await inspectSemanticContext(repo, { environment: env })).passed, true)
})

async function legacyChain(t, count = 91) {
  const value = await fixture(t)
  const { checkpointDigest, createManifest } = await import('./cap-context-checkpoint.mjs')
  const first = await prepareContext(value.repo, { checkpointPath: value.path, budgetTokens: 20000, environment })
  assert.equal(first.valid, true, JSON.stringify(first))
  const template = JSON.parse(readFileSync(join(value.repo, first.manifest), 'utf8'))
  const old = structuredClone(value.checkpoint)
  delete old.coverage
  const oldPath = '.cap/context/legacy-checkpoint.json'
  writeFileSync(join(value.repo, oldPath), JSON.stringify(old))
  let previous = 'none'
  for (let i = 0; i < count; i++) {
    const manifest = structuredClone(template)
    delete manifest.integrityVersion
    manifest.checkpoint = 'legacy-checkpoint.json'
    manifest.digest = checkpointDigest(old)
    manifest.plan.digest = createManifest(old, { budgetTokens: 20000 }).plan.digest
    manifest.entry.previousManifest = previous
    manifest.entry.previousDigest = previous === 'none' ? null : manifest.digest
    delete manifest.entry.previousManifestSha256
    manifest.entry.recoveryEvent = 'legacy-event'
    manifest.entry.recoveryReceipt = '.cap/context/legacy-receipt.json'
    previous = `.cap/context/legacy-manifest-${i}.json`
    writeFileSync(join(value.repo, previous), JSON.stringify(manifest))
  }
  writeFileSync(join(value.repo, '.cap/context/legacy-receipt.json'), JSON.stringify({ schemaVersion: 1, event: 'legacy-event' }))
  let state = readFileSync(join(value.repo, '.cap/STATE.md'), 'utf8')
  for (const [key, val] of Object.entries({ 'context-checkpoint': oldPath, 'context-checkpoint-digest': checkpointDigest(old), 'context-manifest': previous, 'context-manifest-sha256': 'none', 'context-previous-manifest': count === 1 ? 'none' : `.cap/context/legacy-manifest-${count - 2}.json`, 'context-previous-digest': count === 1 ? 'none' : checkpointDigest(old) })) state = state.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${val}`)
  writeFileSync(join(value.repo, '.cap/STATE.md'), state)
  writeFileSync(join(value.repo, '.cap/task-context.md'), readFileSync(join(value.repo, '.cap/task-context.md'), 'utf8').replace('source to consumer', 'source to current consumer'))
  const review = '.cap/context/migration-review.md'
  writeFileSync(join(value.repo, review), 'Reviewed current sources and protected atoms; legacy receipts and historical source bytes are unverified. Rebuild current exact replay without granting historical PASS.\n')
  return { ...value, review, legacyManifest: previous, oldPath }
}

test('explicit migration recovers a 91-node legacy chain with source drift and stale receipts', async t => {
  const { repo, path, review, oldPath } = await legacyChain(t)
  const options = { checkpointPath: path, budgetTokens: 20000, event: 'visible:migration', environment }
  const blocked = await prepareContext(repo, options)
  assert.equal(blocked.valid, false)
  const result = await prepareContext(repo, { ...options, migrationReview: review })
  assert.equal(result.valid, true, JSON.stringify(result))
  assert.ok(result.recovery.hot.length)
  const manifest = JSON.parse(readFileSync(join(repo, result.manifest), 'utf8'))
  assert.equal(manifest.entry.previousManifest, 'none')
  assert.ok(manifest.lineageAnchor)
  const audit = JSON.parse(readFileSync(join(repo, manifest.lineageAnchor.path), 'utf8'))
  assert.equal(audit.nodeCount, 91)
  assert.equal(audit.historicalEvidence, 'unverified')
  assert.ok(audit.issues.some(item => item.code === 'published_recovery_receipt_invalid'))
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, true)
  const reused = await prepareContext(repo, options)
  assert.equal(reused.valid, true, JSON.stringify(reused))
  writeFileSync(join(repo, oldPath), '{}')
  assert.equal((await inspectSemanticContext(repo, { environment })).passed, false)
})

for (const [name, mutate] of [
  ['cycle', ({ repo, legacyManifest }) => { const p = join(repo, legacyManifest); const m = JSON.parse(readFileSync(p)); m.entry.previousManifest = legacyManifest; writeFileSync(p, JSON.stringify(m)) }],
  ['escape', ({ repo, legacyManifest }) => { const p = join(repo, legacyManifest); const m = JSON.parse(readFileSync(p)); m.entry.previousManifest = '.cap/context/../../outside.json'; writeFileSync(p, JSON.stringify(m)) }],
  ['modern corruption', ({ repo, legacyManifest }) => { const p = join(repo, legacyManifest); const m = JSON.parse(readFileSync(p)); m.integrityVersion = 1; writeFileSync(p, JSON.stringify(m)) }],
  ['digest corruption', ({ repo, oldPath }) => writeFileSync(join(repo, oldPath), '{}')],
  ['missing coverage', ({ repo, path }) => { const p = join(repo, path); const c = JSON.parse(readFileSync(p)); c.coverage = []; writeFileSync(p, JSON.stringify(c)) }],
  ['protected atom removal', ({ repo, path }) => { const p = join(repo, path); const c = JSON.parse(readFileSync(p)); c.atoms = c.atoms.filter(a => a.id !== 'acceptance'); writeFileSync(p, JSON.stringify(c)) }],
]) test(`migration rejects ${name} without publishing a new root`, async t => {
  const value = await legacyChain(t, 2)
  mutate(value)
  const before = readFileSync(join(value.repo, '.cap/STATE.md'), 'utf8').match(/^context-manifest: (.+)$/m)[1]
  const result = await prepareContext(value.repo, { checkpointPath: value.path, budgetTokens: 20000, event: 'visible:migration', migrationReview: value.review, environment })
  assert.equal(result.valid, false, JSON.stringify(result))
  assert.equal(readFileSync(join(value.repo, '.cap/STATE.md'), 'utf8').match(/^context-manifest: (.+)$/m)[1], before)
})

test('ordinary integrity validation accepts 91 modern nodes without relaxing hashes', async t => {
  const { repo: candidate, legacyManifest } = await legacyChain(t)
  const repo = realpathSync(candidate)
  const { loadContextManifest, validatePublishedSnapshotIntegrity, manifestContentSha256 } = await import('./cap-context-gate.mjs')
  let sha = null
  for (let i = 0; i < 91; i++) {
    const p = join(repo, `.cap/context/legacy-manifest-${i}.json`)
    const m = JSON.parse(readFileSync(p))
    m.integrityVersion = 1
    m.entry.previousManifestSha256 = sha
    m.entry.recoveryEvent = 'none'
    m.entry.recoveryReceipt = 'none'
    const text = JSON.stringify(m)
    sha = manifestContentSha256(text)
    writeFileSync(p, text)
  }
  const snapshot = await loadContextManifest(repo, legacyManifest)
  const binding = await captureContextBinding(repo, { environment })
  const checked = await validatePublishedSnapshotIntegrity(repo, snapshot, binding, { expectedManifestSha256: sha, allowSourceDrift: true, manifestPath: legacyManifest })
  assert.equal(checked.valid, true, JSON.stringify(checked))
  const p = join(repo, '.cap/context/legacy-manifest-0.json')
  writeFileSync(p, readFileSync(p, 'utf8') + ' ')
  const tampered = await validatePublishedSnapshotIntegrity(repo, snapshot, binding, { expectedManifestSha256: sha, allowSourceDrift: true, manifestPath: legacyManifest })
  assert.equal(tampered.valid, false)
  assert.ok(tampered.errors.some(e => e.code === 'published_manifest_sha256_mismatch'))
})


test('migration rechecks sealed history before publishing STATE', async t => {
  const value = await legacyChain(t, 2)
  const { repo, path, review, legacyManifest } = value
  let mutated = false
  const watcher = watch(join(repo, '.cap/context'), (event, filename) => {
    if (!mutated && String(filename).startsWith('lineage-')) {
      mutated = true
      writeFileSync(join(repo, review), 'Changed after audit was sealed; this note has not been reviewed.\n')
    }
  })
  t.after(() => watcher.close())
  const result = await prepareContext(repo, { checkpointPath: path, budgetTokens: 20000, event: 'visible:migration-race', migrationReview: review, environment })
  assert.equal(mutated, true)
  assert.equal(result.valid, false)
  assert.equal(readFileSync(join(repo, '.cap/STATE.md'), 'utf8').match(/^context-manifest: (.+)$/m)[1], legacyManifest)
})
