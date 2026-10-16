import test from 'node:test'
import assert from 'node:assert/strict'
import * as coverage from './cap-context-coverage.mjs'

const source = {
  '.cap/task-context.md': '- intent: Repair reminders\n\n## External operation boundary\n- authorization: local testing only\n- invalidates-on: production or live notifications\n- recovery: never send actual notifications\n\n## Impact surface\n- modify: reminders.js\n',
  '.cap/STATE.md': '## External operation authorization\n- scope: no manual charge trigger\n\n## Decisions log\n- Keep the existing API\n\n## Next action\n- Run local tests\n',
  '.cap/spec.md': '## Acceptance criteria\n- tests pass\n\n## Security constraints\n- preserve access controls\n\n## Notifications\n<!-- cap-semantic: prohibition -->\n- Do not send real notifications\n',
  '.cap/plan.md': '## Implementation plan\n- update reminders.js\n',
}

function checkpoint(requirements) {
  const atoms = requirements.map((item, index) => ({ id: `a-${index}`, type: item.types[0], protection: item.minProtection || 'P1', sourceRefs: [item.sourceRef], status: 'active' }))
  atoms.push({ id: 'constraint', type: 'constraint', protection: 'P0', sourceRefs: ['user-message:scope'], status: 'active' })
  return { atoms, coverage: requirements.map((item, index) => ({ id: item.id, atomIds: [`a-${index}`] })) }
}

test('source inventory supplies deterministic category and protection floors', () => {
  const requirements = coverage.semanticCoverageRequirements(source)
  assert.ok(requirements.length > 8)
  for (const item of requirements) assert.ok(item.category && /^P[012]$/.test(item.minProtection), JSON.stringify(item))
  for (const item of requirements.filter(item => ['External operation boundary', 'External operation authorization', 'Security constraints', 'Notifications'].includes(item.label))) assert.equal(item.minProtection, 'P0')
  assert.equal(requirements.find(item => item.label === 'Acceptance criteria').minProtection, 'P1')
  assert.equal(requirements.find(item => item.label === 'Implementation plan').minProtection, 'P2')
  assert.equal(requirements.find(item => item.label === 'Impact surface').minProtection, 'P2')
})

test('real-world authorization and invalidation boundaries cannot be mapped to P2', () => {
  const requirements = coverage.semanticCoverageRequirements(source)
  const value = checkpoint(requirements)
  assert.deepEqual(coverage.validateSemanticCoverage(value, requirements), [])
  for (const atom of value.atoms) if (atom.sourceRefs.some(ref => requirements.some(item => item.minProtection === 'P0' && item.sourceRef === ref))) atom.protection = 'P2'
  const errors = coverage.validateSemanticCoverage(value, requirements)
  assert.ok(errors.some(item => item.code === 'semantic_protection_below_floor'))
})

test('coverage floor checks preserve exact hash-backed source references', () => {
  const requirements = coverage.semanticCoverageRequirements(source)
  const value = checkpoint(requirements)
  value.atoms[0].sourceRefs = ['file:.cap/task-context.md#old']
  assert.ok(coverage.validateSemanticCoverage(value, requirements).some(item => item.code === 'semantic_source_uncovered'))
  const changed = coverage.semanticCoverageRequirements({ ...source, '.cap/task-context.md': source['.cap/task-context.md'].replace('local testing only', 'live testing authorized') })
  assert.ok(coverage.validateSemanticCoverage(checkpoint(requirements), changed).some(item => item.code === 'semantic_coverage_stale'))
})

test('explicit atom categories and known atom types enforce minimum floors', () => {
  for (const atom of [
    { type: 'constraint', semanticCategory: 'prohibition', protection: 'P2' },
    { type: 'constraint', semanticCategory: 'invalidation', protection: 'P1' },
    { type: 'authorization', protection: 'P2' },
    { type: 'identity', protection: 'P1' },
    { type: 'intent', semanticCategory: 'source_detail', protection: 'P2' },
    { type: 'next_action', protection: 'P2' },
  ]) assert.ok(coverage.validateAtomProtection({ atoms: [{ ...atom, id: 'a', status: 'active' }] }).some(item => item.code === 'semantic_protection_below_floor'), JSON.stringify(atom))
  assert.deepEqual(coverage.validateAtomProtection({ atoms: [{ id: 'inactive', type: 'authorization', status: 'invalidated', protection: 'P2' }] }), [])
  assert.ok(coverage.validateAtomProtection({ atoms: [{ id: 'a', type: 'constraint', semanticCategory: 'made-up', protection: 'P0', status: 'active' }] }).some(item => item.code === 'semantic_category_invalid'))
})

test('priority inflation produces actionable advisory without changing safety atoms or lineage', () => {
  const requirements = coverage.semanticCoverageRequirements(source)
  const value = checkpoint(requirements)
  for (const atom of value.atoms) atom.protection = 'P0'
  const before = JSON.stringify(value)
  const warnings = coverage.semanticProtectionAdvisories(value, requirements)
  const inflation = warnings.find(item => item.code === 'semantic_p0_inflation')
  assert.ok(inflation)
  assert.ok(inflation.atomIds.some(id => value.atoms.find(atom => atom.id === id).sourceRefs.some(ref => requirements.some(item => item.label === 'Implementation plan' && item.sourceRef === ref))))
  assert.ok(!inflation.atomIds.some(id => value.atoms.find(atom => atom.id === id).sourceRefs.some(ref => requirements.some(item => item.category === 'authorization' && item.sourceRef === ref))))
  assert.match(inflation.message, /review/i)
  assert.equal(JSON.stringify(value), before)
  assert.deepEqual(coverage.validateSemanticCoverage(value, requirements), [])
})

test('source classification accepts explicit semantic category and rejects unknown annotation', () => {
  const requirements = coverage.semanticCoverageRequirements({ '.cap/spec.md': '## Custom section\n<!-- cap-semantic: safety -->\n- guard service credentials\n' })
  assert.equal(requirements[0].category, 'safety')
  assert.equal(requirements[0].minProtection, 'P0')
  const unknown = coverage.semanticCoverageRequirements({ '.cap/spec.md': '## Custom section\n<!-- cap-semantic: accidental-typo -->\n- a rule\n' })
  assert.equal(unknown[0].category, 'accidental-typo')
  assert.ok(coverage.validateSemanticCoverage(checkpoint(unknown), unknown).some(item => item.code === 'semantic_category_invalid'))
  const weakened = coverage.semanticCoverageRequirements({ '.cap/spec.md': '## Security constraints\n<!-- cap-semantic: source_detail -->\n- preserve access control\n' })
  assert.equal(weakened[0].minProtection, 'P0')
})

test('nested source sections inherit protected categories without leaking into peer plans', () => {
  const requirements = coverage.semanticCoverageRequirements({ '.cap/spec.md': '## Security constraints\n### Credential handling\n- retain restrictions\n## Custom boundary\n<!-- cap-semantic: authorization -->\n### Local execution\n- use approved local environment\n## Implementation plan\n### File changes\n- update file.js\n' })
  assert.equal(requirements.find(item => item.label === 'Credential handling').minProtection, 'P0')
  assert.equal(requirements.find(item => item.label === 'Local execution').minProtection, 'P0')
  assert.equal(requirements.find(item => item.label === 'File changes').minProtection, 'P2')
})

test('malformed atoms and coverage mappings fail closed without crashing helpers', () => {
  const requirements = coverage.semanticCoverageRequirements(source)
  for (const atoms of [null, {}, 'atoms', [null], [1], [[], null]]) {
    const value = { atoms, coverage: [] }
    assert.ok(coverage.validateAtomProtection(value).some(item => ['atoms_invalid', 'atom_invalid'].includes(item.code)))
    assert.ok(Array.isArray(coverage.semanticProtectionAdvisories(value, requirements)))
    assert.ok(coverage.validateSemanticCoverage(value, requirements).length)
  }
  for (const atomIds of ['a-0', { length: 1 }, null, [null]]) {
    const value = checkpoint(requirements)
    value.coverage[0].atomIds = atomIds
    assert.ok(coverage.validateSemanticCoverage(value, requirements).some(item => ['semantic_coverage_invalid', 'semantic_source_uncovered'].includes(item.code)))
  }
  const value = checkpoint(requirements)
  value.atoms[0].sourceRefs = { includes: 'invalid' }
  assert.ok(coverage.validateSemanticCoverage(value, requirements).some(item => item.code === 'semantic_source_uncovered'))
})

test('nested canonical task and STATE sections retain authoritative inventory and floors', () => {
  const sources = {
    '.cap/task-context.md': '- intent: Repair reminders\n## External operation boundary\n- authorization: local only\n### Recovery detail\n- never send live notifications\n### Impact surface\n- production remains forbidden\n## Impact surface\n### Paths\n- modify: local.js\n## Dirty ownership\n### Excluded work\n- keep user changes\n## Unrelated\n- not inventoried\n',
    '.cap/STATE.md': '## External operation authorization\n### Scope\n- no production writes\n## Decisions log\n### Compatibility\n- preserve behavior\n## Next action\n### Verification\n- run tests\n## Gates passed\n### Local evidence\n- previous test receipt\n',
  }
  const requirements = coverage.semanticCoverageRequirements(sources)
  assert.equal(requirements.length, 10)
  for (const label of ['External operation boundary', 'External operation authorization', 'Dirty ownership']) {
    assert.ok(requirements.some(item => item.label === label))
    for (const item of requirements.filter(item => item.label === label)) assert.equal(item.minProtection, 'P0')
  }
  assert.equal(requirements.filter(item => item.label === 'External operation boundary').length, 3)
  assert.equal(requirements.find(item => item.label === 'Decisions log').minProtection, 'P1')
  assert.equal(requirements.find(item => item.label === 'Next action').minProtection, 'P1')
  assert.equal(requirements.find(item => item.label === 'Impact surface').minProtection, 'P2')
  const before = coverage.semanticCoverageRequirements({ '.cap/task-context.md': '## External operation boundary\n- authorization: local only\n' })[0]
  assert.equal(requirements.find(item => item.id === before.id)?.sourceRef, before.sourceRef)
  const value = checkpoint(requirements)
  value.atoms.push({ id: 'acceptance', type: 'acceptance_criterion', protection: 'P1', status: 'active' })
  assert.deepEqual(coverage.validateSemanticCoverage(value, requirements), [])
  value.coverage.splice(2, 1)
  assert.ok(coverage.validateSemanticCoverage(value, requirements).some(item => item.code === 'semantic_source_uncovered'))
})
