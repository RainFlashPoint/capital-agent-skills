// Validate the current task's comparison evidence, never create another knowledge
// base or infer business contradictions from keywords. The agent reviews sources.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000
const field = (body, key) => body.match(new RegExp(`^- ${key}:[ \\t]*([^\\r\\n]*)$`, 'm'))?.[1]?.trim() || ''
const section = (body, title) => body.match(new RegExp(`^## ${title}[ \\t]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] || ''
const assessments = new Set(['compatible', 'different_scope', 'not_applicable', 'change_authorized', 'unresolved', 'unverified'])
const source = value => text(value) && /^(?:knowledge|task|git|file|user-message|server-decision):[^\s]+$/.test(value)
const decision = value => text(value) && /^(?:user-message|server-decision):[^\s]+$/.test(value)

export function inspectHistoryRules(markdown = '', identity = {}) {
  const body = String(markdown).replace(/\r\n/g, '\n')
  const candidates = field(section(body, 'History usage'), 'candidates')
  const count = (body.match(/^## Historical rule check[ \t]*$/gm) || []).length
  const required = Boolean(candidates && candidates !== 'none') || count > 0
  const errors = []
  let comparisons = []
  const finish = () => {
    const reason = errors[0]?.code || (required ? 'history_rule_check_current' : 'history_rule_check_not_required')
    const pending = errors.some(e => e.code === 'history_rule_conflict_unresolved')
    const unverified = errors.some(e => e.code === 'history_rule_source_unverified')
    const kind = pending ? 'resolve_history_rule_conflict' : unverified ? 'verify_history_rule_sources' : 'review_history_rules'
    return { required, passed: errors.length === 0, reason, errors,
      nextActions: errors.length ? [{ kind, label: pending ? '确认历史规则与本次需求的冲突处置' : '核对历史来源并补齐规则对照', reason, requiresUser: pending, reference: 'cap-flow/references/history-rule-consistency.md' }] : [],
      remediation: errors.length ? '读取已召回的原始知识/Task/需求和当前需求，对照范围与规则；明确授权的变更引用原始决策后继续，未决冲突只暂停受影响改动。不要重新建设知识或凭摘要放行。' : '',
    }
  }
  const add = (code, detail) => errors.push({ code, detail })
  if (!required) return finish()
  if (!count) { add('history_rule_check_missing', '已召回历史候选；缺少 Historical rule check 原文对照结果'); return finish() }
  const raw = section(body, 'Historical rule check').trim()
  if (count !== 1 || Buffer.byteLength(raw) > 65536 || !/^```json\n[\s\S]*\n```$/.test(raw)) {
    add('history_rule_check_invalid', '历史规则对照必须为单个有界 JSON 段'); return finish()
  }
  let report
  try { report = JSON.parse(raw.slice(8, -4)) } catch { add('history_rule_check_invalid', '历史规则对照 JSON 无效'); return finish() }
  if (!record(report) || report.schemaVersion !== 1 || !Array.isArray(report.comparisons) || report.comparisons.length > 100) {
    add('history_rule_check_invalid', '历史规则对照 schemaVersion/比较清单无效'); return finish()
  }
  if (!text(report.repo) || !text(report.taskId) || (identity.repo !== undefined && report.repo !== identity.repo)
    || (identity.taskId !== undefined && report.taskId !== identity.taskId)
    || !text(report.intent) || report.intent !== field(body, 'intent') || !text(report.candidateSet) || report.candidateSet !== candidates) {
    add('history_rule_check_stale', '当前仓库、Task、意图或历史候选集已变化，需重新审阅对照'); return finish()
  }
  comparisons = report.comparisons
  const candidateRefs = candidates === 'none' ? [] : candidates.split(',').map(ref => ref.trim())
  if (candidateRefs.some(ref => !source(ref)) || new Set(candidateRefs).size !== candidateRefs.length) {
    add('history_rule_check_invalid', 'History usage candidates 须为去重的逗号分隔原始引用；旧自由文本需审阅后迁移')
  }
  if ((candidates !== 'none' && !comparisons.length) || (candidates === 'none' && comparisons.length)) add('history_rule_check_invalid', '比较清单与历史候选是否存在不一致')
  const ids = new Set()
  for (const item of comparisons) {
    if (!record(item) || !text(item.id) || ids.has(item.id) || !source(item.historyRef) || !source(item.currentRef)
      || !['scope', 'historicalRule', 'currentRule', 'rationale', 'impact'].every(key => text(item[key])) || !assessments.has(item.assessment)) {
      add('history_rule_check_invalid', '每条比较须有唯一 id、原始来源、适用范围、新旧规则、理由、影响和有效处置'); continue
    }
    ids.add(item.id)
    if (!candidateRefs.includes(item.historyRef)) add('history_rule_candidate_mismatch', `${item.id}: 历史来源不属于已审阅候选集`)
    if (item.assessment === 'change_authorized' && !decision(item.decisionRef)) add('history_rule_decision_missing', `${item.id}: 规则变更须引用原始用户消息或可信决策，不能由经验/摘要自证授权`)
    if (item.assessment === 'unverified') add('history_rule_source_unverified', `${item.id}: 历史来源或适用范围未核实；先补证据。${item.historyRef} / ${item.currentRef}`)
    if (item.assessment === 'unresolved') add('history_rule_conflict_unresolved', `${item.id}: 历史规则「${item.historicalRule}」(${item.historyRef})；本次「${item.currentRule}」(${item.currentRef})；范围=${item.scope}；影响=${item.impact}；${item.rationale}`)
  }
  for (const ref of candidateRefs) if (!comparisons.some(item => record(item) && item.historyRef === ref)) add('history_rule_candidate_unreviewed', `历史候选未对照：${ref}`)
  return finish()
}
