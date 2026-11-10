import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, linkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planContextGarbage, applyContextGarbage } from './cap-context-gc.mjs'

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'cap-context-gc-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(join(repo, '.cap/context'), { recursive: true })
  mkdirSync(join(repo, '.cap/local-state'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, '.cap/STATE.md'), [
    'task-id: gc-fixture',
    'context-manifest: .cap/context/manifest-current.json',
    'context-checkpoint: .cap/context/checkpoint-current.json',
    'context-checkpoint-digest: fixture',
    'context-recovery-receipt: .cap/context/recovery-current.json',
    'context-previous-manifest: .cap/context/manifest-previous.json',
  ].join('\n') + '\n')
  writeFileSync(join(repo, '.cap/context/checkpoint-current.json'), '{}\n')
  writeFileSync(join(repo, '.cap/context/recovery-current.json'), '{}\n')
  writeFileSync(join(repo, '.cap/context/atoms-current.jsonl'), '{}\n')
  writeFileSync(join(repo, '.cap/context/checkpoint-previous.json'), '{}\n')
  writeFileSync(join(repo, '.cap/context/atoms-previous.jsonl'), '{}\n')
  writeFileSync(join(repo, '.cap/context/manifest-previous.json'), JSON.stringify({
    checkpoint: 'checkpoint-previous.json',
    atomLog: 'atoms-previous.jsonl',
    entry: { previousManifest: 'none' },
  }) + '\n')
  writeFileSync(join(repo, '.cap/context/manifest-current.json'), JSON.stringify({
    checkpoint: 'checkpoint-current.json',
    atomLog: 'atoms-current.jsonl',
    entry: {
      previousManifest: '.cap/context/manifest-previous.json',
      recoveryReceipt: '.cap/context/recovery-current.json',
    },
  }) + '\n')
  writeFileSync(join(repo, '.cap/context/checkpoint-duplicate.json'), '{}\n')
  writeFileSync(join(repo, '.cap/context/failed-manifest.json'), '{}\n')
  writeFileSync(join(repo, '.cap/context/checkpoint-old.json'), '{"task":"old"}\n')
  writeFileSync(join(repo, '.cap/context/atoms-old.jsonl'), '{"task":"old"}\n')
  writeFileSync(join(repo, '.cap/context/recovery-old.json'), '{"task":"old"}\n')
  writeFileSync(join(repo, '.cap/context/manifest-old.json'), JSON.stringify({
    checkpoint: 'checkpoint-old.json', atomLog: 'atoms-old.jsonl',
    entry: { taskId: 'old', previousManifest: 'none', recoveryReceipt: '.cap/context/recovery-old.json' },
  }) + '\n')
  writeFileSync(join(repo, '.cap/context/checkpoint-unselected.json'), '{"task":"gc-fixture"}\n')
  writeFileSync(join(repo, '.cap/context/legacy-manifest-unselected.json'), JSON.stringify({
    checkpoint: 'checkpoint-unselected.json', atomLog: 'atoms-old.jsonl',
    entry: { taskId: 'gc-fixture', previousManifest: 'none' },
  }) + '\n')
  return repo
}

test('cleanup retains the published lineage and reports unreferenced files', async t => {
  const repo = fixture(t)
  const plan = await planContextGarbage(repo)
  assert.equal(plan.safeToApply, true)
  assert.ok(plan.retainedFiles.includes('.cap/context/manifest-current.json'))
  assert.ok(plan.retainedFiles.includes('.cap/context/manifest-previous.json'))
  assert.ok(plan.historicalFiles.includes('.cap/context/manifest-old.json'))
  assert.ok(plan.historicalFiles.includes('.cap/context/checkpoint-old.json'))
  assert.ok(plan.historicalFiles.includes('.cap/context/recovery-old.json'))
  assert.ok(plan.historicalFiles.includes('.cap/context/legacy-manifest-unselected.json'))
  assert.ok(plan.historicalFiles.includes('.cap/context/checkpoint-unselected.json'))
  assert.ok(plan.candidates.some(item => item.path.endsWith('/checkpoint-duplicate.json')))
  assert.ok(plan.candidates.some(item => item.path.endsWith('/failed-manifest.json')))
  assert.equal(existsSync(join(repo, '.cap/context/failed-manifest.json')), true)
})

test('apply quarantines candidates and never deletes canonical evidence', async t => {
  const repo = fixture(t)
  const result = await applyContextGarbage(repo)
  assert.equal(result.applied, true)
  assert.equal(existsSync(join(repo, '.cap/context/manifest-current.json')), true)
  assert.equal(existsSync(join(repo, '.cap/context/manifest-previous.json')), true)
  assert.equal(existsSync(join(repo, '.cap/context/failed-manifest.json')), false)
  assert.equal(result.moved.length, 2)
  assert.equal(result.deduplicatedBytes, 3)
  assert.ok(result.moved.every(item => item.quarantinedPath.startsWith('.cap/local-state/garbage/context/')))
  assert.equal(statSync(join(repo, result.moved[0].quarantinedPath)).ino, statSync(join(repo, result.moved[1].quarantinedPath)).ino)
  assert.equal(existsSync(join(repo, '.cap/context/manifest-old.json')), true)
  assert.equal(existsSync(join(repo, '.cap/context/legacy-manifest-unselected.json')), true)
  assert.match(readFileSync(join(repo, '.cap/STATE.md'), 'utf8'), /context-manifest/)
})

test('a competing cleanup lock is never removed by a failed apply', async t => {
  const repo = fixture(t)
  const lock = join(repo, '.cap/.context-gc.lock')
  writeFileSync(lock, 'other writer\n')
  await assert.rejects(applyContextGarbage(repo), /EEXIST/)
  assert.equal(existsSync(lock), true)
})

test('an idempotent empty apply does not create a garbage directory', async t => {
  const repo = fixture(t)
  const first = await applyContextGarbage(repo)
  assert.equal(first.moved.length, 2)
  const rootsBefore = await (await import('node:fs/promises')).readdir(join(repo, '.cap/local-state/garbage/context'))
  const second = await applyContextGarbage(repo)
  assert.deepEqual(second.moved, [])
  assert.equal(second.quarantineRoot, '')
  const rootsAfter = await (await import('node:fs/promises')).readdir(join(repo, '.cap/local-state/garbage/context'))
  assert.deepEqual(rootsAfter, rootsBefore)
})

test('apply rejects stale plans and preserves every source file', async t => {
  const repo = fixture(t)
  const plan = await planContextGarbage(repo)
  writeFileSync(join(repo, '.cap/STATE.md'), readFileSync(join(repo, '.cap/STATE.md'), 'utf8') + 'updated: later\n')
  await assert.rejects(applyContextGarbage(repo, plan), /context_gc_plan_changed/)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
  assert.equal(existsSync(join(repo, '.cap/.context-prepare.lock')), false)
})

test('apply rejects drift in retained history before moving candidates', async t => {
  const repo = fixture(t)
  const plan = await planContextGarbage(repo)
  writeFileSync(join(repo, '.cap/context/checkpoint-old.json'), '{"task":"old","edited":true}\n')
  await assert.rejects(applyContextGarbage(repo, plan), /context_gc_plan_changed/)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
})

test('historical lineage gaps fail closed instead of reclassifying evidence as garbage', async t => {
  const repo = fixture(t)
  rmSync(join(repo, '.cap/context/checkpoint-old.json'))
  await assert.rejects(planContextGarbage(repo), /context_gc_referenced_file_missing/)
  assert.equal(existsSync(join(repo, '.cap/context/manifest-old.json')), true)
})

test('a malformed canonical manifest blocks cleanup', async t => {
  const repo = fixture(t)
  writeFileSync(join(repo, '.cap/context/manifest-broken.json'), '{}\n')
  await assert.rejects(planContextGarbage(repo), /context_gc_invalid_manifest/)
  assert.equal(existsSync(join(repo, '.cap/context/manifest-broken.json')), true)
})

test('a changed predecessor hash blocks cleanup of an active versioned chain', async t => {
  const repo = fixture(t)
  const previousPath = join(repo, '.cap/context/manifest-previous.json')
  const currentPath = join(repo, '.cap/context/manifest-current.json')
  const current = JSON.parse(readFileSync(currentPath, 'utf8'))
  current.integrityVersion = 1
  current.entry.previousManifestSha256 = createHash('sha256').update(readFileSync(previousPath)).digest('hex')
  writeFileSync(currentPath, JSON.stringify(current) + '\n')
  writeFileSync(previousPath, readFileSync(previousPath, 'utf8') + ' ')
  await assert.rejects(planContextGarbage(repo), /context_gc_manifest_hash_mismatch/)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
})

test('a preparation writer prevents cleanup from moving files', async t => {
  const repo = fixture(t)
  writeFileSync(join(repo, '.cap/.context-prepare.lock'), 'writer\n')
  await assert.rejects(applyContextGarbage(repo), /EEXIST/)
  assert.equal(existsSync(join(repo, '.cap/.context-prepare.lock')), true)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
})

test('hardlinked candidates cannot claim new physical savings', async t => {
  const repo = fixture(t)
  linkSync(join(repo, '.cap/context/checkpoint-duplicate.json'), join(repo, 'shared-checkpoint.json'))
  await assert.rejects(planContextGarbage(repo), /context_gc_hardlinked_candidate/)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
})

test('a symlinked quarantine parent cannot receive candidate data', async t => {
  const repo = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'cap-context-gc-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  rmSync(join(repo, '.cap/local-state'), { recursive: true })
  symlinkSync(outside, join(repo, '.cap/local-state'))
  await assert.rejects(applyContextGarbage(repo), /context_gc_unsupported_directory/)
  assert.equal(existsSync(join(repo, '.cap/context/checkpoint-duplicate.json')), true)
})
