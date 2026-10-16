import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const LEVEL = new Map(['P0', 'P1', 'P2', 'P3', 'P4'].map((value, index) => [value, index]))
// These are semantic classes declared by a reviewed source/atom, not a keyword
// classifier for business prose. Unknown headings remain source-backed detail.
export const SEMANTIC_PROTECTION = Object.freeze({
  intent: 'P0', authorization: 'P0', prohibition: 'P0', identity: 'P0',
  security: 'P0', safety: 'P0', invalidation: 'P0', boundary: 'P0', ownership: 'P0',
  decision: 'P1', acceptance: 'P1', next_action: 'P1', blocker: 'P1', invariant: 'P1', unknown: 'P1',
  constraint: 'P2', evidence: 'P2', implementation: 'P2', source_detail: 'P2',
})
const TYPE_FLOOR = { intent: 'P0', authorization: 'P0', identity: 'P0', decision: 'P1', acceptance_criterion: 'P1', next_action: 'P1', invariant: 'P1' }
const CATEGORY_TYPES = {
  intent: ['intent'], authorization: ['constraint', 'authorization'], prohibition: ['constraint'],
  identity: ['identity', 'constraint'], security: ['constraint', 'invariant'], safety: ['constraint', 'invariant'],
  invalidation: ['constraint', 'authorization'], boundary: ['constraint', 'authorization'], ownership: ['constraint'],
  decision: ['decision'], acceptance: ['acceptance_criterion'], next_action: ['next_action'], blocker: ['blocker', 'unknown'],
  invariant: ['invariant', 'constraint'], unknown: ['unknown'], constraint: ['constraint'], evidence: ['evidence', 'unknown', 'acceptance_criterion'],
  implementation: ['constraint', 'evidence', 'next_action', 'decision'],
  source_detail: ['constraint', 'evidence', 'intent', 'decision', 'acceptance_criterion', 'invariant', 'unknown', 'next_action'],
}
const HEADING_CATEGORIES = new Map([
  ['intent', 'intent'], ['task intent', 'intent'], ['目标', 'intent'], ['需求目标', 'intent'],
  ['authorization', 'authorization'], ['authorization boundaries', 'authorization'], ['授权边界', 'authorization'],
  ['prohibitions', 'prohibition'], ['prohibition', 'prohibition'], ['non-goals', 'prohibition'], ['禁止事项', 'prohibition'], ['非目标', 'prohibition'],
  ['identity', 'identity'], ['task identity', 'identity'], ['身份边界', 'identity'],
  ['security constraints', 'security'], ['security', 'security'], ['安全约束', 'security'],
  ['safety constraints', 'safety'], ['safety', 'safety'], ['安全边界', 'safety'],
  ['invalidates-on', 'invalidation'], ['invalidation', 'invalidation'], ['失效条件', 'invalidation'],
  ['decisions', 'decision'], ['decisions log', 'decision'], ['决策', 'decision'],
  ['acceptance criteria', 'acceptance'], ['acceptance', 'acceptance'], ['验收标准', 'acceptance'],
  ['next action', 'next_action'], ['next actions', 'next_action'], ['下一步', 'next_action'],
  ['blockers', 'blocker'], ['阻断项', 'blocker'], ['invariants', 'invariant'], ['不变量', 'invariant'],
  ['unknowns', 'unknown'], ['待确认', 'unknown'], ['implementation plan', 'implementation'], ['实施计划', 'implementation'],
])
const strongest = floors => floors.filter(value => LEVEL.has(value)).sort((a, b) => LEVEL.get(a) - LEVEL.get(b))[0]
const belowFloor = (protection, floor) => !LEVEL.has(protection) || LEVEL.get(protection) > LEVEL.get(floor)
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
const activeAtoms = checkpoint => Array.isArray(checkpoint?.atoms) ? checkpoint.atoms.filter(atom => record(atom) && atom.status === 'active') : []
const TASK_SOURCE_HEADINGS = { 'External operation boundary': 'boundary', 'Impact surface': 'source_detail', 'Dirty ownership': 'ownership' }
const STATE_SOURCE_HEADINGS = { 'External operation authorization': 'authorization', 'Decisions log': 'decision', 'Next action': 'next_action', 'Gates passed': 'evidence' }

function sourceCategory(unit, fallback = 'source_detail') {
  const declarations = [...unit.content.matchAll(/<!--\s*cap-semantic:\s*([^\s>]+)\s*-->/g)].map(match => match[1])
  const heading = HEADING_CATEGORIES.get(unit.heading.toLowerCase())
  const categories = [...declarations, heading, unit.inheritedCategory].filter(Boolean)
  const invalid = categories.find(category => !Object.hasOwn(SEMANTIC_PROTECTION, category))
  if (invalid) return invalid
  return categories.sort((a, b) => LEVEL.get(SEMANTIC_PROTECTION[a]) - LEVEL.get(SEMANTIC_PROTECTION[b]))[0] || fallback
}

export function validateAtomProtection(checkpoint) {
  const errors = []
  if (!Array.isArray(checkpoint?.atoms)) return [{ code: 'atoms_invalid', path: 'atoms', message: 'atoms must be an array' }]
  for (const [index, atom] of checkpoint.atoms.entries()) {
    if (!record(atom)) {
      errors.push({ code: 'atom_invalid', path: `atoms[${index}]`, message: 'atom must be an object' })
      continue
    }
    if (atom.status !== 'active') continue
    const path = `atoms[${index}].protection`
    if (atom.semanticCategory !== undefined && !Object.hasOwn(SEMANTIC_PROTECTION, atom.semanticCategory)) {
      errors.push({ code: 'semantic_category_invalid', path: `atoms[${index}].semanticCategory`, message: 'use a reviewed supported semantic category' })
    }
    const floor = strongest([TYPE_FLOOR[atom.type], SEMANTIC_PROTECTION[atom.semanticCategory]])
    if (floor && belowFloor(atom.protection, floor)) errors.push({ code: 'semantic_protection_below_floor', path, message: `${atom.semanticCategory || atom.type} requires ${floor} or stronger; review the original source and preserve lineage` })
  }
  return errors
}

export function semanticProtectionAdvisories(checkpoint, requirements = []) {
  const atoms = activeAtoms(checkpoint)
  const inventory = Array.isArray(requirements) ? requirements.filter(record) : []
  const p0 = atoms.filter(atom => atom.protection === 'P0')
  if (p0.length < 8 || p0.length / Math.max(atoms.length, 1) < 0.5) return []
  const candidates = p0.filter(atom => {
    const mapped = inventory.filter(item => Array.isArray(atom.sourceRefs) && atom.sourceRefs.includes(item.sourceRef))
    const floor = strongest([TYPE_FLOOR[atom.type], SEMANTIC_PROTECTION[atom.semanticCategory], ...mapped.map(item => item.minProtection)])
    return floor && floor !== 'P0'
  })
  if (!candidates.length) return []
  return [{ code: 'semantic_p0_inflation', path: 'atoms', atomIds: candidates.map(atom => atom.id), message: `${p0.length}/${atoms.length} active atoms are P0. Review the listed source-backed detail, plans and decisions for accidental blanket promotion; preserve real safety boundaries and terminal/supersedes lineage. Do not automatically downgrade existing P0 atoms.` }]
}
function sections(text = '', sourceHeadings = {}) {
  const result = [], hierarchy = []
  let heading = 'preamble', lines = []
  const flush = () => {
    const content = lines.filter(line => line.trim() && !/^\s*(?:```.*|[-| :]+)\s*$/.test(line) && !/^(?:- )?(?:context-|provider-compaction|updated:)/.test(line)).map(line => line.trim()).join('\n')
    const parent = hierarchy.at(-2), current = hierarchy.at(-1)
    const originHeading = parent?.originHeading || (Object.hasOwn(sourceHeadings, heading) ? heading : undefined)
    const unit = { heading, content, originHeading, inheritedCategory: parent?.category }
    unit.category = sourceCategory(unit)
    if (current) Object.assign(current, { category: unit.category, originHeading })
    if (content) result.push(unit)
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^(#{1,6}) (.*)$/)
    if (match) {
      flush()
      while (hierarchy.length && hierarchy.at(-1).level >= match[1].length) hierarchy.pop()
      hierarchy.push({ level: match[1].length })
      heading = match[2].trim(); lines = []
    }
    else lines.push(line)
  }
  flush()
  return result
}

// Inventory is derived from original task artifacts, never from checkpoint atoms.
// Hash anchors make omissions/stale mappings detectable; they do not prove paraphrase equivalence.
export function semanticCoverageRequirements(sources = {}) {
  const requirements = []
  const add = (path, label, content, types, category) => {
    if (!content?.trim() || /^(?:- )?(?:none|not-applicable)$/i.test(content.trim())) return
    const id = sha(`${path}\n${label}\n${content.trim()}`)
    requirements.push({ id, sourceRef: `file:${path}#semantic-${id}`, label, types, category, minProtection: SEMANTIC_PROTECTION[category] })
  }
  const context = sources['.cap/task-context.md'] || ''
  add('.cap/task-context.md', 'intent', context.match(/^- intent:[ \t]*(.*)$/m)?.[1], ['intent'], 'intent')
  for (const unit of sections(context, TASK_SOURCE_HEADINGS)) {
    if (unit.originHeading) {
      const category = TASK_SOURCE_HEADINGS[unit.originHeading]
      for (const line of unit.content.split('\n')) add('.cap/task-context.md', unit.originHeading, line, CATEGORY_TYPES[category], category)
    }
  }
  for (const unit of sections(sources['.cap/STATE.md'] || '', STATE_SOURCE_HEADINGS)) {
    const category = STATE_SOURCE_HEADINGS[unit.originHeading]
    if (category) for (const line of unit.content.split('\n')) add('.cap/STATE.md', unit.originHeading, line, CATEGORY_TYPES[category], category)
  }
  for (const path of ['.cap/spec.md', '.cap/plan.md']) {
    for (const unit of sections(sources[path] || '')) {
      const category = unit.category
      add(path, unit.heading, unit.content, CATEGORY_TYPES[category] || CATEGORY_TYPES.source_detail, category)
    }
  }
  return requirements
}

export function validateSemanticCoverage(checkpoint, requirements) {
  const errors = validateAtomProtection(checkpoint), atoms = activeAtoms(checkpoint)
  const add = (code, path, message) => errors.push({ code, path, message })
  if (!Array.isArray(requirements)) return [...errors, { code: 'semantic_inventory_invalid', path: 'requirements', message: 'requirements must be an array of source obligations' }]
  const inventory = requirements.filter(record)
  if (inventory.length !== requirements.length) add('semantic_inventory_invalid', 'requirements', 'source obligations must be objects')
  for (const type of ['intent', 'constraint', 'acceptance_criterion', 'next_action']) {
    if (!atoms.some(atom => atom.type === type && ['P0', 'P1'].includes(atom.protection))) add('semantic_category_missing', `atoms.${type}`, `retain a P0/P1 ${type} atom`)
  }
  const coverage = checkpoint?.coverage
  if (!Array.isArray(coverage)) return [...errors, { code: 'semantic_coverage_missing', path: 'coverage', message: 'map original-source inventory to active atoms' }]
  const ids = new Set()
  for (const mapping of coverage) {
    if (!record(mapping) || typeof mapping.id !== 'string' || ids.has(mapping.id) || !Array.isArray(mapping.atomIds) || !mapping.atomIds.length || !mapping.atomIds.every(id => typeof id === 'string' && id.length)) add('semantic_coverage_invalid', 'coverage', 'unique inventory ids and nonempty string atomIds are required')
    ids.add(mapping?.id)
    if (!inventory.some(item => item.id === mapping?.id)) add('semantic_coverage_stale', 'coverage', 'inventory mapping no longer matches original sources')
  }
  for (const item of inventory) {
    if (!Object.hasOwn(SEMANTIC_PROTECTION, item.category) || item.minProtection !== SEMANTIC_PROTECTION[item.category] || !Array.isArray(item.types)) {
      add('semantic_category_invalid', item.sourceRef, 'regenerate the source inventory with a supported semantic category and protection floor')
      continue
    }
    const mapping = coverage.find(entry => entry?.id === item.id)
    const covered = Array.isArray(mapping?.atomIds) && mapping.atomIds.length && mapping.atomIds.every(id => atoms.some(atom => atom.id === id && item.types.includes(atom.type) && ['P0', 'P1', 'P2'].includes(atom.protection) && Array.isArray(atom.sourceRefs) && atom.sourceRefs.includes(item.sourceRef)))
    if (!covered) add('semantic_source_uncovered', item.sourceRef, `uncovered ${item.label}; map to active sourced ${item.types.join('/')} atoms`)
    else if (mapping.atomIds.some(id => belowFloor(atoms.find(atom => atom.id === id).protection, item.minProtection))) add('semantic_protection_below_floor', item.sourceRef, `${item.label} (${item.category}) requires ${item.minProtection} or stronger`)
  }
  return errors
}
