import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectHistoryRules } from './cap-history-rules.mjs'

const comparison = (assessment = 'unresolved') => ({
  id: 'cancel-1', historyRef: 'knowledge:kn-cancel', currentRef: 'user-message:request-cancel',
  scope: 'project=demo; environment=test; subject=account cancellation; conditions=unsettled order',
  historicalRule: 'Reject cancellation while an order is unsettled',
  currentRule: 'Allow cancellation while an order is unsettled',
  assessment, rationale: 'Same conditions, opposite behavior', impact: 'Order settlement and account lifecycle',
})
const assessment = (items = [comparison()]) => ({ schemaVersion: 1, repo: 'https://example.test/org/demo.git', taskId: 'task-demo', intent: 'Change cancellation behavior', candidateSet: 'knowledge:kn-cancel', comparisons: items })
function context(report = assessment(), candidates = 'knowledge:kn-cancel') {
  return `- intent: Change cancellation behavior\n\n## History usage\n- candidates: ${candidates}\n- outcome: modified_adopted\n- reason: inspected prior rule\n\n${report === null ? '' : `## Historical rule check\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`}`
}

test('no candidates does not require another knowledge store or a fabricated rule', () => {
  assert.equal(inspectHistoryRules(context(null, 'none')).passed, true)
})
test('recalled history requires a reviewed comparison even when adoption says not_used', () => {
  const r = inspectHistoryRules(context(null).replace('modified_adopted', 'not_used'))
  assert.equal(r.passed, false); assert.equal(r.reason, 'history_rule_check_missing')
})
test('same-scope contradictory rule blocks with actionable original-source details', () => {
  const r = inspectHistoryRules(context())
  assert.equal(r.passed, false); assert.equal(r.reason, 'history_rule_conflict_unresolved')
  assert.match(r.errors[0].detail, /Reject cancellation/)
  assert.match(r.errors[0].detail, /Allow cancellation/)
  assert.equal(r.nextActions[0].kind, 'resolve_history_rule_conflict')
  assert.equal(r.nextActions[0].requiresUser, true)
})
test('a mixed result cannot hide an unresolved rule behind a compatible one', () => {
  const r = inspectHistoryRules(context(assessment([{ ...comparison('compatible'), id: 'other' }, comparison()])))
  assert.equal(r.passed, false)
})
for (const result of ['compatible', 'different_scope', 'not_applicable']) {
  test(`${result} proceeds after original-source comparison, without asking again`, () => {
    const r = inspectHistoryRules(context(assessment([comparison(result)])))
    assert.equal(r.passed, true); assert.deepEqual(r.nextActions, [])
  })
}
test('explicitly authorized rule replacement proceeds with a decision source', () => {
  const r = inspectHistoryRules(context(assessment([{ ...comparison('change_authorized'), decisionRef: 'user-message:explicit-rule-replacement' }])))
  assert.equal(r.passed, true)
})
test('a change cannot be cleared by model-generated summary or missing decision', () => {
  for (const decisionRef of [undefined, 'summary:approved', 'checkpoint:self', 'knowledge:old']) {
    const r = inspectHistoryRules(context(assessment([{ ...comparison('change_authorized'), decisionRef }])))
    assert.equal(r.passed, false); assert.ok(r.errors.some(e => e.code === 'history_rule_decision_missing'))
  }
})
test('unverified history requests evidence first, not a fabricated human approval', () => {
  const r = inspectHistoryRules(context(assessment([comparison('unverified')])))
  assert.equal(r.passed, false); assert.equal(r.nextActions[0].requiresUser, false)
  assert.equal(r.nextActions[0].kind, 'verify_history_rule_sources')
})
test('new intent and candidate-set changes invalidate prior comparisons', () => {
  for (const patch of [{ intent: 'Old intent' }, { candidateSet: 'knowledge:other' }]) {
    assert.equal(inspectHistoryRules(context({ ...assessment(), ...patch })).reason, 'history_rule_check_stale')
  }
})
test('malformed, duplicate, empty or unsupported reports fail closed without throwing', () => {
  const cases = [null, [], {}, { ...assessment(), schemaVersion: 2 }, { ...assessment(), comparisons: [] },
    assessment([null]), assessment([comparison(), comparison()]), assessment([{ ...comparison(), assessment: 'PASS' }])]
  for (const report of cases) assert.equal(inspectHistoryRules(context(report)).passed, false)
  assert.equal(inspectHistoryRules(context().replace('```json', '```')).passed, false)
  assert.equal(inspectHistoryRules(context() + context()).passed, false)
})
test('source-less and self-certified conclusions cannot be accepted as a rule check', () => {
  for (const patch of [{ historyRef: 'summary:old' }, { currentRef: 'checkpoint:self' }, { scope: ' ' }, { impact: '' }]) {
    assert.equal(inspectHistoryRules(context(assessment([{ ...comparison('compatible'), ...patch }]))).passed, false)
  }
})
test('JSON and comparison bounds reject unbounded context output', () => {
  assert.equal(inspectHistoryRules(context(assessment(Array.from({ length: 101 }, (_, i) => ({ ...comparison('compatible'), id: `r${i}` }))))).passed, false)
  assert.equal(inspectHistoryRules(context(assessment([{ ...comparison(), rationale: 'x'.repeat(70000) }]))).passed, false)
})
test('all recalled sources must be compared; an unrelated source cannot replace them', () => {
  const report = { ...assessment([comparison('compatible')]), candidateSet: 'knowledge:kn-cancel, task:prior-rule' }
  const result = inspectHistoryRules(context(report, report.candidateSet))
  assert.ok(result.errors.some(e => e.code === 'history_rule_candidate_unreviewed'))
  const wrong = inspectHistoryRules(context(assessment([{ ...comparison('compatible'), historyRef: 'knowledge:unrelated' }])))
  assert.ok(wrong.errors.some(e => e.code === 'history_rule_candidate_mismatch'))
})
test('switching repositories or Tasks requires a fresh assessment instead of inheriting another project decision', () => {
  const body = context(assessment([comparison('compatible')]))
  assert.equal(inspectHistoryRules(body, { repo: 'https://example.test/org/other.git', taskId: 'task-demo' }).reason, 'history_rule_check_stale')
  assert.equal(inspectHistoryRules(body, { repo: 'https://example.test/org/demo.git', taskId: 'task-other' }).reason, 'history_rule_check_stale')
  assert.equal(inspectHistoryRules(body, { repo: 'https://example.test/org/demo.git', taskId: 'task-demo' }).passed, true)
})
