#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureContextBinding, captureCoverageRequirements, capturePublishedPredecessor } from './cap-context-gate.mjs'
import { semanticCoverageRequirements, validateSemanticCoverage, validateAtomProtection, semanticProtectionAdvisories, SEMANTIC_PROTECTION } from './cap-context-coverage.mjs'

const PROTECTION_ORDER = new Map(['P0', 'P1', 'P2', 'P3', 'P4'].map((value, index) => [value, index]))
const AUTHORITATIVE_TRUST = new Set(['user-authorized', 'server-observed', 'repository-observed'])
const SELF_REFERENTIAL_PREFIXES = ['checkpoint:', 'summary:', 'model:']
const ATOM_TYPES = new Set(['intent', 'authorization', 'constraint', 'identity', 'decision', 'unknown', 'evidence', 'next_action', 'blocker', 'acceptance_criterion', 'invariant', 'narrative', 'chitchat'])
const TRUST_VALUES = new Set(['user-authorized', 'user-stated', 'server-observed', 'repository-observed', 'local-observed', 'model-derived', 'unknown'])
const STATUS_VALUES = new Set(['active', 'superseded', 'invalidated'])
const CERTAINTY_VALUES = new Set(['confirmed', 'unknown', 'hypothesis'])
const RECOVERABILITY_ORDER = new Map([['irrecoverable', 0], ['source-backed', 1], ['recomputable', 2]])
const SOURCE_SCHEMES = new Set(['user-message', 'server-action', 'server-receipt', 'platform-task', 'git', 'artifact', 'local-action', 'test', 'state', 'spec', 'plan', 'project', 'file', 'model', 'summary', 'checkpoint'])
const TRUST_SCHEMES = new Map([
  ['user-authorized', new Set(['user-message'])],
  ['user-stated', new Set(['user-message'])],
  ['server-observed', new Set(['server-action', 'server-receipt', 'platform-task'])],
  ['repository-observed', new Set(['git', 'artifact', 'test', 'state', 'spec', 'plan', 'project', 'file'])],
  ['local-observed', new Set(['git', 'artifact', 'local-action', 'test', 'file'])],
  ['model-derived', new Set(['model', 'summary', 'checkpoint'])],
])
const PROVIDER_KINDS = new Set(['codex-app-server', 'responses-api', 'anthropic', 'other', 'none'])
const PROVIDER_STATUSES = new Set(['not-requested', 'requested', 'running', 'succeeded', 'failed', 'unavailable'])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function error(code, path, message) {
  return { code, path, message }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value, { nonEmpty = false } = {}) {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every(isNonEmptyString)
}

function active(atom) {
  return atom?.status !== 'superseded' && atom?.status !== 'invalidated'
}

function reactivationErrors(before, after, path) {
  return !active(before) && active(after)
    ? [error('terminal_atom_reactivated', path, 'terminal atoms cannot reactivate; create a new sourced successor')]
    : []
}

function sourceScheme(source) {
  return String(source).match(/^([a-z][a-z0-9-]*):/)?.[1] || ''
}

export function fileSource(ref) {
  return typeof ref === 'string' ? ref.match(/^(?:artifact|file|state|spec|plan|project):(.+)$/)?.[1]?.split('#')[0] || null : null
}

function sourceMatchesTrust(source, trust) {
  const schemes = TRUST_SCHEMES.get(trust)
  return schemes ? schemes.has(sourceScheme(source)) : trust === 'unknown'
}

function sourceIsSelfReferential(source) {
  return SELF_REFERENTIAL_PREFIXES.some(prefix => String(source).startsWith(prefix))
}

function authoritativeNewSource(previous, current) {
  const before = new Set(previous.sourceRefs || [])
  const added = (current.sourceRefs || []).filter(source => !before.has(source))
  return AUTHORITATIVE_TRUST.has(current.trust)
    && added.some(source => !sourceIsSelfReferential(source) && sourceMatchesTrust(source, current.trust))
}

function tokenEstimate(atom) {
  if (Number.isFinite(atom.tokenEstimate) && atom.tokenEstimate >= 0) return atom.tokenEstimate
  const { effectivePriority, scoreReasons, tierReason, tier, ...content } = atom
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf8') / 3))
}

function ordinalCompare(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function rankAtoms(atoms) {
  return [...atoms].sort((left, right) => {
    const protection = (PROTECTION_ORDER.get(left.protection) ?? 99) - (PROTECTION_ORDER.get(right.protection) ?? 99)
    if (protection !== 0) return protection
    const priority = Number(right.effectivePriority ?? right.priority ?? 0) - Number(left.effectivePriority ?? left.priority ?? 0)
    if (priority !== 0) return priority
    const recoverability = (RECOVERABILITY_ORDER.get(left.recoverability) ?? 99) - (RECOVERABILITY_ORDER.get(right.recoverability) ?? 99)
    return recoverability || ordinalCompare(left.id, right.id)
  })
}

function scopeMatchesIdentity(scope, identity, binding = 'commit') {
  return (binding === 'task' ? ['taskId', 'repo', 'branch'] : ['taskId', 'repo', 'branch', 'commit']).every(field => scope?.[field] === identity?.[field])
}

function compatibleSuccessorType(previous, current) {
  if (previous?.type === 'unknown') return ['unknown', 'evidence', 'decision'].includes(current?.type)
  return previous?.type === current?.type
}

function duplicateKey(atom) {
  return `${atom.type}\u0000${atom.assertion}\u0000${JSON.stringify(stableValue(atom.scope))}`
}

// Only replay is coalesced. Unknown semantic fields participate in the key so
// future metadata cannot silently weaken this equivalence relation.
function replayGroups(atoms) {
  const groups = new Map()
  for (const atom of atoms) {
    const { id, sourceRefs, priority, tokenEstimate, ...semantics } = atom
    const key = JSON.stringify(stableValue(semantics))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(atom)
  }
  return [...groups.values()].map(members => {
    members.sort((a, b) => ordinalCompare(a.id, b.id))
    if (members.length === 1) return { members, projection: members[0] }
    const { tokenEstimate: ignored, ...first } = members[0]
    return { members, projection: { ...first,
      priority: Math.max(...members.map(atom => atom.priority)),
      coveredAtomIds: members.map(atom => atom.id),
      sourceRefs: [...new Set(members.flatMap(atom => atom.sourceRefs))].sort(ordinalCompare),
    } }
  })
}

export function contextReplay(checkpoint, plan) {
  const byId = new Map(checkpoint.atoms.map(atom => [atom.id, atom]))
  const hot = plan.hot.map(id => byId.get(id))
  const warmRefs = plan.warm.flatMap(id => byId.get(id).sourceRefs)
  return plan.replayVersion === 1
    ? { hot: replayGroups(hot).map(group => group.projection), warmRefs: [...new Set(warmRefs)].sort(ordinalCompare) }
    : { hot, warmRefs }
}

function scoreAtom(atom, { focusIds = new Set(), duplicate = false } = {}) {
  let score = Number(atom.priority || 0)
  const reasons = [`base:${score}`]
  const adjust = (value, reason) => { score += value; reasons.push(`${reason}:${value >= 0 ? '+' : ''}${value}`) }
  if (focusIds.has(atom.id)) adjust(12, 'current-action')
  if (['unknown', 'blocker', 'next_action'].includes(atom.type)) adjust(8, 'unresolved-or-next')
  const trust = { 'user-authorized': 8, 'server-observed': 8, 'repository-observed': 4, 'local-observed': 2, 'model-derived': -2, unknown: -6 }[atom.trust] || 0
  if (trust) adjust(trust, 'authority')
  const recovery = { irrecoverable: 8, 'source-backed': 2, recomputable: -6 }[atom.recoverability] || 0
  if (recovery) adjust(recovery, 'recoverability')
  const freshness = { current: 4, recent: 0, stale: -10 }[atom.freshness] || 0
  if (freshness) adjust(freshness, 'freshness')
  if (duplicate) adjust(-20, 'duplicate')
  return { effectivePriority: Math.max(0, Math.min(100, score)), scoreReasons: reasons }
}

export function checkpointDigest(checkpoint) {
  return createHash('sha256').update(JSON.stringify(stableValue(checkpoint)) ?? 'null').digest('hex')
}

export function validateCheckpoint(checkpoint) {
  const errors = []
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return { valid: false, digest: checkpointDigest(checkpoint), errors: [error('checkpoint_invalid', '$', 'checkpoint must be an object')] }
  }
  if (checkpoint.schemaVersion !== 1) errors.push(error('schema_version_unsupported', 'schemaVersion', 'schemaVersion must be 1'))

  const identity = checkpoint.identity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    errors.push(error('identity_missing', 'identity', 'checkpoint identity is required'))
  } else {
    for (const field of ['taskId', 'repo', 'branch', 'commit', 'stage']) {
      if (!isNonEmptyString(identity[field])) errors.push(error('identity_field_missing', `identity.${field}`, `${field} is required`))
    }
  }

  if (!Array.isArray(checkpoint.atoms)) {
    errors.push(error('atoms_invalid', 'atoms', 'atoms must be an array'))
  } else {
    if (!checkpoint.atoms.length) errors.push(error('atoms_empty', 'atoms', 'a checkpoint must retain semantic atoms'))
    const ids = new Set()
    checkpoint.atoms.forEach((atom, index) => {
      const path = `atoms[${index}]`
      if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
        errors.push(error('atom_invalid', path, 'atom must be an object'))
        return
      }
      if (!isNonEmptyString(atom.id)) errors.push(error('atom_id_missing', `${path}.id`, 'atom id is required'))
      else if (ids.has(atom.id)) errors.push(error('atom_id_duplicate', `${path}.id`, `duplicate atom id: ${atom.id}`))
      else ids.add(atom.id)
      if (!isNonEmptyString(atom.type)) errors.push(error('atom_type_missing', `${path}.type`, 'atom type is required'))
      else if (!ATOM_TYPES.has(atom.type)) errors.push(error('atom_type_invalid', `${path}.type`, `unsupported atom type: ${atom.type}`))
      if (!isNonEmptyString(atom.assertion)) errors.push(error('atom_assertion_missing', `${path}.assertion`, 'atom assertion is required'))
      if (!PROTECTION_ORDER.has(atom.protection)) errors.push(error('protection_invalid', `${path}.protection`, 'protection must be P0-P4'))
      if (!Number.isFinite(atom.priority) || atom.priority < 0 || atom.priority > 100) errors.push(error('priority_invalid', `${path}.priority`, 'priority must be between 0 and 100'))
      if (!isStringArray(atom.sourceRefs, { nonEmpty: true })) errors.push(error('source_refs_missing', `${path}.sourceRefs`, 'at least one source reference is required'))
      else {
        for (const source of atom.sourceRefs) {
          const scheme = sourceScheme(source)
          if (!SOURCE_SCHEMES.has(scheme)) errors.push(error('source_ref_scheme_invalid', `${path}.sourceRefs`, `unsupported source reference: ${source}`))
        }
      }
      if (!TRUST_VALUES.has(atom.trust)) errors.push(error('trust_invalid', `${path}.trust`, 'trust must use a supported value'))
      if (!STATUS_VALUES.has(atom.status)) errors.push(error('status_invalid', `${path}.status`, 'status must be active, superseded or invalidated'))
      if (!CERTAINTY_VALUES.has(atom.certainty)) errors.push(error('certainty_invalid', `${path}.certainty`, 'certainty must be confirmed, unknown or hypothesis'))
      if (!RECOVERABILITY_ORDER.has(atom.recoverability)) errors.push(error('recoverability_invalid', `${path}.recoverability`, 'recoverability must be irrecoverable, source-backed or recomputable'))
      if (atom.freshness !== undefined && !['current', 'recent', 'stale'].includes(atom.freshness)) errors.push(error('freshness_invalid', `${path}.freshness`, 'freshness must be current, recent or stale'))
      if (!isStringArray(atom.invalidation)) errors.push(error('invalidation_invalid', `${path}.invalidation`, 'invalidation must be an array of strings'))
      if (!isStringArray(atom.supersedes)) errors.push(error('supersedes_invalid', `${path}.supersedes`, 'supersedes must be an array of atom ids'))
      else if (new Set(atom.supersedes).size !== atom.supersedes.length) errors.push(error('supersedes_duplicate', `${path}.supersedes`, 'supersedes ids must be unique'))

      if (!atom.scope || typeof atom.scope !== 'object' || Array.isArray(atom.scope)) {
        errors.push(error('scope_missing', `${path}.scope`, 'atom scope is required'))
      } else {
        for (const field of ['taskId', 'repo', 'branch', 'commit']) {
          if (!isNonEmptyString(atom.scope[field])) errors.push(error('scope_field_missing', `${path}.scope.${field}`, `${field} is required`))
        }
        if (atom.scopeBinding !== undefined && !['task', 'commit'].includes(atom.scopeBinding)) errors.push(error('scope_binding_invalid', `${path}.scopeBinding`, 'scopeBinding must be task or commit'))
        if (['authorization', 'evidence'].includes(atom.type) && atom.scopeBinding === 'task') errors.push(error('scope_binding_forbidden', `${path}.scopeBinding`, 'authorization and evidence must remain commit-bound'))
        if (active(atom) && identity && !scopeMatchesIdentity(atom.scope, identity, atom.scopeBinding)) {
          errors.push(error('atom_scope_identity_mismatch', `${path}.scope`, 'active atom scope must match checkpoint identity'))
        }
      }

      if (atom.certainty === 'confirmed' && TRUST_SCHEMES.has(atom.trust) && isStringArray(atom.sourceRefs, { nonEmpty: true }) && !atom.sourceRefs.some(source => sourceMatchesTrust(source, atom.trust))) {
        errors.push(error('trust_source_mismatch', `${path}.sourceRefs`, `confirmed ${atom.trust} atom lacks a matching source reference`))
      }

      if (atom.type === 'authorization' && active(atom) && !isStringArray(atom.invalidation, { nonEmpty: true })) {
        errors.push(error('authorization_invalidation_missing', `${path}.invalidation`, 'active authorization must state when it expires'))
      }
      if (atom.type === 'authorization' && atom.trust !== 'user-authorized') errors.push(error('authorization_trust_invalid', `${path}.trust`, 'authorization must point to a user-authorized source'))

      if (atom.type === 'evidence' && active(atom) && identity?.commit && atom.scope?.commit !== identity.commit) {
        errors.push(error('stale_commit_evidence', `${path}.scope.commit`, 'active evidence must bind to the checkpoint commit'))
      }

      if (atom.certainty === 'confirmed' && isStringArray(atom.sourceRefs, { nonEmpty: true }) && atom.sourceRefs.every(sourceIsSelfReferential)) {
        errors.push(error('self_certified_atom', `${path}.sourceRefs`, 'a checkpoint or summary cannot certify its own assertion'))
      }
    })
  }

  errors.push(...validateAtomProtection(checkpoint))
  return { valid: errors.length === 0, digest: checkpointDigest(checkpoint), errors }
}

export function validateCheckpointTransition(previous, current) {
  const previousValidation = validateCheckpoint(previous)
  const currentValidation = validateCheckpoint(current)
  // A retained legacy predecessor may predate protection floors. Permit its
  // repair, while current atoms still obey every floor and protected lineage.
  const errors = [...previousValidation.errors.filter(item => item.code !== 'semantic_protection_below_floor').map(item => ({ ...item, checkpoint: 'previous' })), ...currentValidation.errors.map(item => ({ ...item, checkpoint: 'current' }))]
  if (errors.some(item => item.code !== 'atoms_empty')) return { valid: false, previousDigest: previousValidation.digest, digest: currentValidation.digest, errors }
  const previousAtoms = new Map((previous?.atoms || []).filter(atom => atom?.id).map(atom => [atom.id, atom]))
  const currentAtoms = new Map((current?.atoms || []).filter(atom => atom?.id).map(atom => [atom.id, atom]))
  const successors = new Map()

  if (previous?.identity && current?.identity && ['taskId', 'repo', 'branch'].some(field => previous.identity[field] !== current.identity[field])) {
    errors.push(error('checkpoint_identity_changed', 'identity', 'Task, repository and branch identity cannot change within one checkpoint chain'))
  }

  for (const atom of current?.atoms || []) {
    for (const target of Array.isArray(atom?.supersedes) ? atom.supersedes : []) {
      if (target === atom.id) errors.push(error('supersedes_self', `atoms.${atom.id}.supersedes`, 'an atom cannot supersede itself'))
      if (!currentAtoms.has(target)) errors.push(error('supersedes_target_missing', `atoms.${atom.id}.supersedes`, `retain ancestor atom in current snapshot: ${target}`))
      const values = successors.get(target) || []
      values.push(atom)
      successors.set(target, values)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = id => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = (currentAtoms.get(id)?.supersedes || []).some(target => currentAtoms.has(target) && visit(target))
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  if ([...currentAtoms.keys()].some(visit)) errors.push(error('supersedes_cycle', 'atoms', 'supersedes lineage must be acyclic'))

  const successorCache = new Map()
  const validSuccessors = (before, trail = new Set()) => {
    if (successorCache.has(before.id)) return successorCache.get(before.id)
    if (trail.has(before.id)) return []
    const nextTrail = new Set(trail).add(before.id)
    const leaves = []
    for (const after of successors.get(before.id) || []) {
      let valid = true
      if (!compatibleSuccessorType(before, after)) { errors.push(error('supersedes_type_incompatible', `atoms.${after.id}.type`, `cannot supersede ${before.type} with ${after.type}`)); valid = false }
      if ((PROTECTION_ORDER.get(after.protection) ?? 99) > (PROTECTION_ORDER.get(before.protection) ?? 99)) { errors.push(error('supersedes_protection_downgraded', `atoms.${after.id}.protection`, 'successor cannot lower the protection floor')); valid = false }
      if (!authoritativeNewSource(before, after)) { errors.push(error('supersedes_authority_missing', `atoms.${after.id}.sourceRefs`, 'successor requires a new authoritative source')); valid = false }
      if (before.type === 'authorization') {
        const retained = new Set(after.invalidation || [])
        if ((before.invalidation || []).some(value => !retained.has(value))) { errors.push(error('authorization_invalidation_removed', `atoms.${after.id}.invalidation`, 'successor authorization cannot remove invalidation conditions')); valid = false }
      }
      if (!valid) continue
      if (active(after)) {
        if (!scopeMatchesIdentity(after.scope, current?.identity, after.scopeBinding)) errors.push(error('supersedes_scope_mismatch', `atoms.${after.id}.scope`, 'active successor must bind the current checkpoint identity'))
        else leaves.push(after)
      } else {
        leaves.push(...validSuccessors(after, nextTrail))
      }
    }
    const unique = [...new Map(leaves.map(atom => [atom.id, atom])).values()]
    if (unique.length > 1) errors.push(error('supersedes_target_ambiguous', `atoms.${before.id}`, 'one atom cannot have multiple active successor branches'))
    successorCache.set(before.id, unique)
    return unique
  }
  for (const target of successors.keys()) {
    const before = currentAtoms.get(target)
    if (before) validSuccessors(before)
  }

  for (const [id, before] of previousAtoms) {
    const after = currentAtoms.get(id)
    const hasNewEdge = (successors.get(before.id) || []).some(atom => !(previousAtoms.get(atom.id)?.supersedes || []).includes(before.id))
    const lineage = active(before) || hasNewEdge ? validSuccessors(before) : []
    const retainedActive = after && active(after) && (PROTECTION_ORDER.get(after.protection) ?? 99) <= (PROTECTION_ORDER.get(before.protection) ?? 99)
    const commitExpired = ['authorization', 'evidence'].includes(before.type) && before.scope.commit !== current.identity.commit && previous.identity.commit !== current.identity.commit
    const justifiedInvalidation = after?.status === 'invalidated' && (authoritativeNewSource(before, after) || commitExpired)
    const protectedBefore = before.protection === 'P0' || ['intent', 'authorization', 'identity'].includes(before.type) || SEMANTIC_PROTECTION[before.semanticCategory] === 'P0'
    if (active(before) && protectedBefore && !retainedActive && !justifiedInvalidation && lineage.length === 0) errors.push(error('protected_atom_missing', `atoms.${id}`, 'active P0 atom was lost, deactivated without authority, or replaced by an invalid successor'))
    if (active(before) && before.type === 'decision' && !retainedActive && !justifiedInvalidation && lineage.length === 0) errors.push(error('decision_lineage_broken', `atoms.${id}`, 'decision disappeared without a valid successor or authoritative invalidation'))
    if (!after) {
      errors.push(error('atom_history_missing', `atoms.${id}`, 'retain prior atoms, including terminal authorization and evidence, to prevent ID reuse and resurrection across snapshots'))
      continue
    }
    errors.push(...reactivationErrors(before, after, `atoms.${id}.status`))
    if (before.type !== after.type || before.assertion !== after.assertion || before.scopeBinding !== after.scopeBinding || JSON.stringify(stableValue(before.scope)) !== JSON.stringify(stableValue(after.scope))) {
      errors.push(error('atom_identity_mutated', `atoms.${id}`, 'atom type, assertion and scope are immutable; create a superseding atom'))
    }
    if ((PROTECTION_ORDER.get(after.protection) ?? 99) > (PROTECTION_ORDER.get(before.protection) ?? 99)) {
      errors.push(error('protection_downgraded', `atoms.${id}.protection`, 'an existing atom protection floor cannot be lowered'))
    }
    const afterSources = new Set(after.sourceRefs || [])
    if ((before.supersedes || []).some(id => !(after.supersedes || []).includes(id))) errors.push(error('supersedes_lineage_removed', `atoms.${id}.supersedes`, 'existing supersedes lineage cannot be removed'))
    if ((before.sourceRefs || []).some(source => !afterSources.has(source))) {
      errors.push(error('source_lineage_removed', `atoms.${id}.sourceRefs`, 'existing source references cannot be removed'))
    }
    const afterInvalidation = new Set(after.invalidation || [])
    if ((before.invalidation || []).some(value => !afterInvalidation.has(value))) errors.push(error('invalidation_condition_removed', `atoms.${id}.invalidation`, 'existing invalidation conditions cannot be removed'))
    if (before.certainty === 'unknown' && after.certainty === 'confirmed' && !authoritativeNewSource(before, after)) {
      errors.push(error('unknown_upgraded_without_evidence', `atoms.${id}`, 'unknown cannot become confirmed without a new authoritative source'))
    }
    if (before.type === 'evidence' && before.trust === 'local-observed' && after.trust === 'server-observed') {
      errors.push(error('evidence_trust_escalation', `atoms.${id}.trust`, 'local evidence cannot be mutated into server evidence; create a new atom'))
    }
  }

  return {
    valid: errors.length === 0,
    previousDigest: previousValidation.digest,
    digest: currentValidation.digest,
    errors,
  }
}

export function classifyPressure(usedTokens, contextWindow, thresholds = {}) {
  if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) throw new TypeError('token counts must be non-negative and contextWindow must be positive')
  const medium = thresholds.medium ?? 0.55
  const high = thresholds.high ?? 0.70
  const critical = thresholds.critical ?? 0.82
  if (!(medium >= 0 && medium < high && high < critical && critical <= 1)) throw new TypeError('thresholds must be ordered: 0 <= medium < high < critical <= 1')
  const ratio = usedTokens / contextWindow
  if (ratio < medium) return 'low'
  if (ratio < high) return 'medium'
  if (ratio < critical) return 'high'
  return 'critical'
}

function legacyPlanContext(checkpoint, { budgetTokens, currentActionIds = [], penalizeDuplicates = true } = {}) {
  const validation = validateCheckpoint(checkpoint)
  const errors = [...validation.errors]
  const hot = []
  const warm = []
  const cold = []
  const dropped = []
  if (!Number.isFinite(budgetTokens) || budgetTokens < 0) errors.push(error('budget_invalid', 'budgetTokens', 'budgetTokens must be a non-negative number'))
  if (!Array.isArray(currentActionIds) || currentActionIds.some(item => !isNonEmptyString(item))) errors.push(error('current_action_ids_invalid', 'currentActionIds', 'currentActionIds must be an array of atom ids'))
  if (errors.length) return { valid: false, digest: validation.digest, budgetTokens, hotTokens: 0, hot, warm, cold, dropped, errors }

  let used = 0
  const activeAtoms = (checkpoint?.atoms || []).filter(active)
  const counts = new Map()
  for (const atom of activeAtoms) counts.set(duplicateKey(atom), (counts.get(duplicateKey(atom)) || 0) + 1)
  const focusIds = new Set(currentActionIds || [])
  const scored = activeAtoms.map(atom => ({ ...atom, ...scoreAtom(atom, { focusIds, duplicate: penalizeDuplicates && (counts.get(duplicateKey(atom)) || 0) > 1 }) }))
  const ranked = rankAtoms(scored)
  for (const atom of ranked) {
    const estimate = tokenEstimate(atom)
    const planned = { ...atom, tokenEstimate: estimate, tierReason: atom.protection === 'P0' ? 'protected-floor' : atom.scoreReasons.join(',') }
    if (atom.protection === 'P0') {
      hot.push({ ...planned, tier: 'hot' })
      used += estimate
      continue
    }
    if ((atom.protection === 'P1' || atom.protection === 'P2') && used + estimate <= budgetTokens) {
      hot.push({ ...planned, tier: 'hot' })
      used += estimate
    } else if (atom.protection === 'P1' || atom.protection === 'P2') {
      warm.push({ ...planned, tier: 'warm' })
    } else if ((atom.protection === 'P3' && atom.effectivePriority >= 75) || (atom.protection === 'P4' && atom.effectivePriority >= 85)) {
      if (atom.effectivePriority >= 95 && used + estimate <= budgetTokens) {
        hot.push({ ...planned, tier: 'hot', tierReason: `${planned.tierReason},dynamic-promotion` })
        used += estimate
      } else {
        warm.push({ ...planned, tier: 'warm', tierReason: `${planned.tierReason},dynamic-promotion` })
      }
    } else if (atom.protection === 'P3') {
      cold.push({ ...planned, tier: 'cold' })
    } else {
      dropped.push({ ...planned, tier: 'dropped' })
    }
  }
  for (const atom of checkpoint.atoms.filter(atom => !active(atom))) cold.push({ ...atom, tier: 'cold', effectivePriority: 0, tierReason: 'inactive-history', tokenEstimate: tokenEstimate(atom) })

  const protectedTokens = hot.filter(atom => atom.protection === 'P0').reduce((sum, atom) => sum + tokenEstimate(atom), 0)
  if (Number.isFinite(budgetTokens) && protectedTokens > budgetTokens) {
    errors.push(error('protected_budget_overflow', 'budgetTokens', 'P0 atoms exceed the hot-context budget; fail closed instead of dropping them'))
  }
  return {
    valid: errors.length === 0,
    digest: validation.digest,
    budgetTokens,
    hotTokens: used,
    hot,
    warm,
    cold,
    dropped,
    warnings: semanticProtectionAdvisories(checkpoint),
    errors,
  }
}

export function planContext(checkpoint, options = {}) {
  if (options.replayVersion === 0) return legacyPlanContext(checkpoint, options)
  if (options.currentActionIds !== undefined && (!Array.isArray(options.currentActionIds) || options.currentActionIds.some(id => !isNonEmptyString(id)))) return legacyPlanContext(checkpoint, options)
  const checked = validateCheckpoint(checkpoint)
  if (!checked.valid) return legacyPlanContext(checkpoint, options)
  const groups = replayGroups(checkpoint.atoms.filter(active))
  const groupById = new Map(groups.map(group => [group.projection.id, group]))
  const focus = new Set(options.currentActionIds || [])
  const planned = legacyPlanContext({ ...checkpoint, atoms: [...groups.map(group => group.projection), ...checkpoint.atoms.filter(atom => !active(atom))] }, {
    ...options, penalizeDuplicates: false,
    currentActionIds: groups.filter(group => group.members.some(atom => focus.has(atom.id))).map(group => group.projection.id),
  })
  const result = { ...planned, digest: checked.digest, replayVersion: 1 }
  for (const tier of ['hot', 'warm', 'cold', 'dropped']) result[tier] = planned[tier].flatMap(atom => {
    const group = groupById.get(atom.id)
    return group ? group.members.map((member, index) => ({ ...atom, ...member, tokenEstimate: index === 0 ? atom.tokenEstimate : 0 })) : [atom]
  })
  return result
}

function contentHash(content) {
  return createHash('sha256').update(content).digest('hex')
}

// STATE cursor publication is derived metadata. Preserve every semantic field,
// including provider lifecycle and pressure, while ignoring only these cursors.
function sourceHash(source, content) {
  if (source.projection === 'state-without-cursors-v1' && source.path === '.cap/STATE.md') {
    return contentHash(content.split(/\r?\n/).filter(line => line.trim() && !/^(?:- )?(?:context-checkpoint(?:-digest)?|context-manifest|context-previous-(?:manifest|digest)|context-pressure|context-used-tokens|context-window-tokens|updated):/.test(line)).join('\n'))
  }
  return contentHash(content)
}

export function validateAtomLog(content, checkpoint) {
  const errors = []
  const latest = new Map()
  if (typeof content !== 'string') return [error('atom_log_invalid', 'atomLog', 'atom log must be JSONL')]
  try {
    for (const line of content.split('\n').filter(line => line.trim())) {
      const atom = JSON.parse(line)
      const validation = validateCheckpoint({ schemaVersion: 1, identity: { ...atom.scope, stage: 'implement' }, atoms: [atom] })
      errors.push(...validation.errors)
      const before = latest.get(atom.id)
      if (before) {
        errors.push(...reactivationErrors(before, atom, 'atomLog'))
        if (before.type !== atom.type || before.assertion !== atom.assertion || before.scopeBinding !== atom.scopeBinding || checkpointDigest(before.scope) !== checkpointDigest(atom.scope)) errors.push(error('atom_log_identity_mutated', 'atomLog', 'logged atom identity cannot change'))
        if ((PROTECTION_ORDER.get(atom.protection) ?? 99) > (PROTECTION_ORDER.get(before.protection) ?? 99)) errors.push(error('atom_log_protection_downgraded', 'atomLog', 'logged protection cannot decrease'))
        if (['sourceRefs', 'supersedes', 'invalidation'].some(field => (before[field] || []).some(value => !(atom[field] || []).includes(value)))) errors.push(error('atom_log_lineage_removed', 'atomLog', 'logged source, lineage and invalidation cannot be removed'))
        if (before.certainty === 'unknown' && atom.certainty === 'confirmed' && !authoritativeNewSource(before, atom)) errors.push(error('unknown_upgraded_without_evidence', 'atomLog', 'logged unknown promotion requires authority'))
        if (before.trust === 'local-observed' && atom.trust === 'server-observed') errors.push(error('evidence_trust_escalation', 'atomLog', 'logged local evidence cannot become Server evidence'))
      }
      latest.set(atom.id, atom)
    }
  } catch {
    errors.push(error('atom_log_invalid', 'atomLog', 'each log line must be a complete semantic atom'))
  }
  const atoms = Array.isArray(checkpoint?.atoms) ? checkpoint.atoms : []
  if (latest.size !== atoms.length || atoms.some(atom => checkpointDigest(latest.get(atom.id)) !== checkpointDigest(atom))) errors.push(error('atom_log_projection_mismatch', 'atomLog', 'latest logged revisions must reproduce checkpoint atoms'))
  return errors
}

export function createManifest(checkpoint, { checkpointPath, previous = null, previousPath = null, atomLogPath, atomLogContent, budgetTokens, currentActionIds = [], trigger, pressure, provider = { kind: 'none', status: 'unavailable', eventRef: null }, sourceContents = {} } = {}) {
  const validation = previous ? validateCheckpointTransition(previous, checkpoint) : validateCheckpoint(checkpoint)
  const plan = planContext(checkpoint, { budgetTokens, currentActionIds })
  const manifest = {
    schemaVersion: 1,
    checkpoint: checkpointPath,
    digest: checkpointDigest(checkpoint),
    previousCheckpoint: previousPath,
    previousDigest: previous ? checkpointDigest(previous) : null,
    identity: checkpoint.identity,
    atomLog: { path: atomLogPath, sha256: typeof atomLogContent === 'string' ? contentHash(atomLogContent) : null },
    sources: Object.keys(sourceContents).sort(ordinalCompare).map(path => {
      const source = { path, ...(path === '.cap/STATE.md' ? { projection: 'state-without-cursors-v1' } : {}) }
      return { ...source, sha256: sourceHash(source, sourceContents[path]) }
    }),
    trigger,
    pressure,
    hotBudgetTokens: budgetTokens,
    plan: { digest: plan.digest, replayVersion: 1, currentActionIds, hotTokens: plan.hotTokens, ...Object.fromEntries(['hot', 'warm', 'cold', 'dropped'].map(tier => [tier, plan[tier].map(atom => atom.id)])) },
    provider,
    validated: validation.valid && plan.valid,
  }
  return manifest
}

export function validateManifest(manifest, { checkpoint, previous = null, atomLogContent, sourceContents = {}, requireRecovery = false } = {}) {
  const validation = validateCheckpoint(checkpoint)
  const errors = [...validation.errors]
  if (manifest?.entry) errors.push(...validateSemanticCoverage(checkpoint, semanticCoverageRequirements(sourceContents)))
  const fail = (code, path, message) => errors.push(error(code, path, message))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, errors: [error('manifest_invalid', '$', 'manifest must be an object')] }
  if (manifest.schemaVersion !== 1) fail('manifest_schema_invalid', 'schemaVersion', 'manifest schemaVersion must be 1')
  if (!isNonEmptyString(manifest.checkpoint)) fail('manifest_checkpoint_missing', 'checkpoint', 'checkpoint path is required')
  if (manifest.digest !== validation.digest) fail('manifest_digest_mismatch', 'digest', 'manifest digest does not match checkpoint')
  if (JSON.stringify(stableValue(manifest.identity)) !== JSON.stringify(stableValue(checkpoint?.identity))) fail('manifest_identity_mismatch', 'identity', 'manifest identity must match checkpoint')
  if (!isNonEmptyString(manifest.trigger)) fail('manifest_trigger_missing', 'trigger', 'manifest trigger is required')
  if (!['unknown', 'low', 'medium', 'high', 'critical'].includes(manifest.pressure)) fail('manifest_pressure_invalid', 'pressure', 'manifest pressure is invalid')
  if (manifest.previousDigest === null) {
    if (manifest.previousCheckpoint !== null || previous !== null) fail('manifest_previous_binding_invalid', 'previousCheckpoint', 'initial checkpoint must not reference a predecessor')
  } else {
    if (!isNonEmptyString(manifest.previousCheckpoint) || !previous) fail('manifest_previous_checkpoint_missing', 'previousCheckpoint', 'a predecessor snapshot is required')
    else {
      const transition = validateCheckpointTransition(previous, checkpoint)
      errors.push(...transition.errors)
      if (manifest.previousDigest !== transition.previousDigest) fail('manifest_previous_digest_mismatch', 'previousDigest', 'predecessor digest does not match')
    }
  }
  if (manifest.previousCheckpoint === manifest.checkpoint) fail('manifest_previous_snapshot_reused', 'previousCheckpoint', 'predecessor must be a separate retained snapshot')
  if (!isNonEmptyString(manifest.atomLog?.path) || typeof atomLogContent !== 'string' || manifest.atomLog.sha256 !== contentHash(atomLogContent)) fail('manifest_atom_log_mismatch', 'atomLog', 'atom log content/hash is missing or differs')
  errors.push(...validateAtomLog(atomLogContent, checkpoint))
  if (!Array.isArray(manifest.sources)) fail('manifest_sources_invalid', 'sources', 'source hash list is required')
  else for (const source of manifest.sources) {
    if (source?.projection !== undefined && (source.projection !== 'state-without-cursors-v1' || source.path !== '.cap/STATE.md')) fail('manifest_source_projection_invalid', 'sources', 'source projection is unsupported')
    if (!isNonEmptyString(source?.path) || typeof sourceContents[source.path] !== 'string' || source.sha256 !== sourceHash(source, sourceContents[source.path])) fail('manifest_source_hash_mismatch', 'sources', 'source hash is missing or differs')
  }
  const indexedSources = new Set((Array.isArray(manifest.sources) ? manifest.sources : []).map(source => source?.path))
  if (manifest.entry) for (const path of ['.cap/task-context.md', '.cap/STATE.md']) if (!indexedSources.has(path)) fail('manifest_coverage_source_missing', 'sources', `bound coverage requires ${path}`)
  for (const atom of Array.isArray(checkpoint?.atoms) ? checkpoint.atoms : []) for (const ref of Array.isArray(atom?.sourceRefs) ? atom.sourceRefs : []) {
    const path = fileSource(ref)
    if (path && !indexedSources.has(path)) fail('manifest_source_missing', 'sources', 'a checkpoint file source is missing from the source hash index')
  }
  if (!manifest.plan || !Array.isArray(manifest.plan.currentActionIds)) fail('manifest_plan_missing', 'plan', 'a reproducible context plan is required')
  else {
    if (manifest.plan.replayVersion !== undefined && manifest.plan.replayVersion !== 1) fail('manifest_replay_version_invalid', 'plan.replayVersion', 'unsupported replay projection')
    const plan = planContext(checkpoint, { budgetTokens: manifest.hotBudgetTokens, currentActionIds: manifest.plan.currentActionIds, replayVersion: manifest.plan.replayVersion || 0 })
    errors.push(...plan.errors)
    if (manifest.plan.digest !== plan.digest) fail('manifest_plan_digest_mismatch', 'plan.digest', 'plan checkpoint digest does not match')
    if (manifest.plan.hotTokens !== plan.hotTokens) fail('manifest_plan_tokens_mismatch', 'plan.hotTokens', 'hot token count differs')
    for (const tier of ['hot', 'warm', 'cold', 'dropped']) {
      if (JSON.stringify(manifest.plan[tier]) !== JSON.stringify(plan[tier].map(atom => atom.id))) fail('manifest_plan_tier_mismatch', `plan.${tier}`, `planned ${tier} ids differ`)
    }
  }
  if (!PROVIDER_KINDS.has(manifest.provider?.kind) || !PROVIDER_STATUSES.has(manifest.provider?.status)) fail('manifest_provider_invalid', 'provider', 'provider kind/status is invalid')
  if (['requested', 'running', 'succeeded', 'failed'].includes(manifest.provider?.status) && !isNonEmptyString(manifest.provider.eventRef)) fail('manifest_provider_event_missing', 'provider.eventRef', 'provider lifecycle requires an event reference')
  if (requireRecovery && manifest.provider?.status !== 'succeeded') fail('provider_compaction_not_succeeded', 'provider.status', 'recovery requires observed provider success')
  if (manifest.validated !== true) fail('manifest_not_validated', 'validated', 'manifest must record successful structural validation')
  return { valid: errors.length === 0, digest: validation.digest, errors }
}

async function readJson(source) {
  const text = source === '-'
    ? await new Promise((resolve, reject) => {
      let value = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { value += chunk })
      process.stdin.on('end', () => resolve(value))
      process.stdin.on('error', reject)
    })
    : await readFile(source, 'utf8')
  return JSON.parse(text)
}

async function readManifestResource(source, basePath, { repoSource = false } = {}) {
  const base = await realpath(repoSource ? process.cwd() : dirname(resolve(basePath)))
  const file = await realpath(resolve(repoSource ? process.cwd() : dirname(resolve(basePath)), source))
  if (file !== base && !file.startsWith(`${base}${sep}`)) throw new Error('manifest_path_escape')
  return readFile(file, 'utf8')
}

function usageError(message) {
  return { valid: false, errors: [error('cli_usage_invalid', '$', message)] }
}

export async function main(argv = process.argv.slice(2)) {
  const [operation, source, ...rest] = argv
  if (operation === 'prepare') {
    const { prepareContext } = await import('./cap-context-preparation.mjs')
    const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
    return prepareContext(source || '.', { checkpointPath: option('--checkpoint'), budgetTokens: Number(option('--budget-tokens')), event: option('--event') })
  }
  if (operation === 'resume') {
    const { observeContextResume } = await import('./cap-context-recovery.mjs')
    const index = rest.indexOf('--event')
    return observeContextResume(source || '.', index >= 0 ? { event: rest[index + 1] } : {})
  }
  if (operation === 'coverage') return { valid: true, requirements: await captureCoverageRequirements(source || '.') }
  if (operation === 'create-atom-log') {
    if (!source) return usageError('usage: create-atom-log <checkpoint-file> --output <jsonl-file>')
    const checkpoint = await readJson(source)
    const validation = validateCheckpoint(checkpoint)
    if (!validation.valid) return { valid: false, errors: validation.errors }
    const outputIndex = rest.indexOf('--output')
    if (outputIndex < 0 || !rest[outputIndex + 1]) return usageError('usage: create-atom-log <checkpoint-file> --output <jsonl-file>')
    const target = resolve(rest[outputIndex + 1])
    const base = await realpath(dirname(resolve(source)))
    const targetParent = await realpath(dirname(target))
    if (targetParent !== base) throw new Error('atom_log_output_path_invalid')
    const content = `${checkpoint.atoms.map(atom => JSON.stringify(atom)).join('\n')}\n`
    await writeFile(target, content, { flag: 'wx' })
    return { valid: true, path: relative(base, target).split(sep).join('/'), sha256: contentHash(content), atomCount: checkpoint.atoms.length }
  }
  if (operation === 'transition') {
    if (source === '-' && rest.length === 0) {
      const pair = await readJson('-')
      return validateCheckpointTransition(pair.previous, pair.current)
    }
    const current = rest[0]
    if (!source || !current || source === '-' || current === '-') return usageError('usage: transition <previous-file> <current-file> | transition - (stdin: {previous,current})')
    return validateCheckpointTransition(await readJson(source), await readJson(current))
  }
  if (operation === 'validate-manifest') {
    if (!source) return usageError('usage: validate-manifest <manifest-file>')
    const manifest = await readJson(source)
    const checkpoint = JSON.parse(await readManifestResource(manifest.checkpoint, source))
    const previous = manifest.previousCheckpoint ? JSON.parse(await readManifestResource(manifest.previousCheckpoint, source)) : null
    const atomLogContent = manifest.atomLog?.path ? await readManifestResource(manifest.atomLog.path, source) : undefined
    const sourceContents = {}
    for (const item of manifest.sources || []) {
      sourceContents[item.path] = await readManifestResource(item.path, source, { repoSource: true })
    }
    return validateManifest(manifest, { checkpoint, previous, atomLogContent, sourceContents, requireRecovery: rest.includes('--require-recovery') })
  }
  if (operation === 'create-manifest') {
    if (!source) return usageError('usage: create-manifest <checkpoint-file> --atom-log <file> --budget-tokens N --trigger <name> --pressure <level> --provider-kind <kind> --provider-status <status> --provider-event <ref|none> [--previous <file>] [--output <manifest-file>]')
    const option = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined }
    const checkpoint = await readJson(source)
    if (option('--bind-entry')) {
      const { inspectTaskContext } = await import('./cap-runtime.mjs')
      try { await inspectTaskContext(option('--bind-entry'), { stage: checkpoint.identity.stage, checkSemantic: false }) }
      catch (cause) { return { valid: false, errors: cause.blockers || [{ code: cause.code || 'context_preflight_failed', detail: cause.message }] } }
    }
    const previousPath = option('--previous')
    const previous = previousPath ? JSON.parse(await readManifestResource(relative(dirname(resolve(source)), resolve(previousPath)), source)) : null
    let publishedPredecessor = null
    if (option('--bind-entry')) {
      publishedPredecessor = await capturePublishedPredecessor(option('--bind-entry'))
      const publishedFile = publishedPredecessor ? await realpath(resolve(option('--bind-entry'), publishedPredecessor.path)) : null
      const sameSnapshot = publishedPredecessor && checkpointDigest(checkpoint) === publishedPredecessor.digest && await realpath(resolve(source)) === publishedFile
      if (publishedPredecessor && !sameSnapshot && (!previous || checkpointDigest(previous) !== publishedPredecessor.digest || await realpath(resolve(previousPath)) !== publishedFile)) {
        return { valid: false, errors: [error('context_predecessor_missing', 'previousCheckpoint', 'bind the current published checkpoint as the immutable predecessor before replacing it')] }
      }
      if (sameSnapshot && previous) return { valid: false, errors: [error('context_predecessor_unexpected', 'previousCheckpoint', 'rebinding the same snapshot must not use itself as a predecessor')] }
      if (!publishedPredecessor && previous) return { valid: false, errors: [error('context_predecessor_unexpected', 'previousCheckpoint', 'no published checkpoint exists in the current Task')] }
    }
    const atomLogPath = option('--atom-log')
    const atomLogContent = atomLogPath ? await readManifestResource(relative(dirname(resolve(source)), resolve(atomLogPath)), source) : undefined
    const base = dirname(resolve(source))
    const sourceContents = {}
    if (option('--bind-entry')) {
      for (const path of ['.cap/task-context.md', '.cap/STATE.md', '.cap/spec.md', '.cap/plan.md']) {
        try { sourceContents[path] = await readManifestResource(path, source, { repoSource: true }) }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      }
    }
    for (const atom of checkpoint.atoms || []) for (const ref of atom.sourceRefs || []) {
      const candidate = fileSource(ref)
      if (candidate) {
        if (!Object.hasOwn(sourceContents, candidate)) sourceContents[candidate] = await readManifestResource(candidate, source, { repoSource: true })
      }
    }
    const manifest = createManifest(checkpoint, {
      checkpointPath: relative(base, resolve(source)).split(sep).join('/'),
      previous,
      previousPath: previousPath ? relative(base, resolve(previousPath)).split(sep).join('/') : null,
      atomLogPath: atomLogPath ? relative(base, resolve(atomLogPath)).split(sep).join('/') : undefined,
      atomLogContent,
      sourceContents,
      budgetTokens: Number(option('--budget-tokens')),
      currentActionIds: JSON.parse(option('--current-action-ids') || '[]'),
      trigger: option('--trigger'),
      pressure: option('--pressure'),
      provider: { kind: option('--provider-kind'), status: option('--provider-status'), eventRef: option('--provider-event') === 'none' ? null : option('--provider-event') },
    })
    if (option('--bind-entry')) {
      manifest.entry = await captureContextBinding(option('--bind-entry'), { stage: checkpoint.identity.stage })
      manifest.entry.previousManifest = publishedPredecessor?.manifestPath || 'none'
      manifest.entry.previousDigest = publishedPredecessor?.digest || null
      for (const key of ['taskId', 'repo', 'branch', 'commit', 'stage']) {
        if (manifest.entry[key] !== checkpoint.identity[key]) throw new Error('context_entry_identity_mismatch')
      }
    }
    const check = validateManifest(manifest, { checkpoint, previous, atomLogContent, sourceContents })
    const result = { ...manifest, valid: check.valid, errors: check.errors }
    const outputPath = option('--output')
    if (outputPath && check.valid) {
      const target = resolve(outputPath)
      const base = await realpath(dirname(resolve(source)))
      const targetParent = await realpath(dirname(target))
      if (targetParent !== base) throw new Error('manifest_output_path_invalid')
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    }
    return result
  }
  if (!['validate', 'plan'].includes(operation) || !source) return usageError('usage: validate <file|-> | plan <file|-> --budget-tokens N | transition <previous-file> <current-file> | validate-manifest <manifest-file> | create-atom-log <checkpoint-file> --output <jsonl-file> | create-manifest <checkpoint-file> ...')
  const checkpoint = await readJson(source)
  if (operation === 'validate') return validateCheckpoint(checkpoint)
  const budgetIndex = rest.indexOf('--budget-tokens')
  const budgetTokens = budgetIndex >= 0 ? Number(rest[budgetIndex + 1]) : Number.NaN
  const actionsIndex = rest.indexOf('--current-action-ids')
  let currentActionIds = []
  if (actionsIndex >= 0) currentActionIds = JSON.parse(rest[actionsIndex + 1] || '[]')
  return planContext(checkpoint, { budgetTokens, currentActionIds })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
  }).catch(cause => {
    const result = { valid: false, errors: [error('input_invalid', '$', 'Input could not be read or parsed; use valid JSON and repository-contained paths')] }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = 1
  })
}
