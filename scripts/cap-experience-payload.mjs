#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'
import { sanitizeTaskText } from './cap-task-request.mjs'

const MAX_FILE_BYTES = 256 * 1024
const CAP_FILES = ['.cap/experience.md', '.cap/STATE.md', '.cap/verify/summary.md', '.cap/verify/logic-report.md', '.cap/review/summary.md']
const GENERIC = /^(?:完成(?:需求|开发|修改)?|修复问题|参考(?:现有|类似)实现|按(?:现有|原有)方式处理|处理一下|优化(?:代码|逻辑)?|update|fix(?: bug)?)[。.!！]?$/i

function fail(message) {
  process.stderr.write(`cap-experience-payload: ${message}\n`)
  process.exit(1)
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOptional(repo, args) {
  try { return git(repo, args) } catch { return '' }
}

function parseArgs(argv) {
  let repo = '.'
  let commit = 'HEAD'
  let intent = ''
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--commit') commit = argv[++index] || 'HEAD'
    else if (arg === '--intent') intent = argv[++index] || ''
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) fail(`未知参数：${arg}`)
    else repo = arg
  }
  if (!intent.trim()) fail('缺少 --intent')
  return { repo, commit, intent: intent.trim(), json }
}

function field(markdown = '', name = '') {
  return String(markdown).match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]+)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}

function section(markdown = '', aliases = []) {
  const wanted = aliases.map(value => String(value).toLowerCase())
  const lines = String(markdown).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase()
    if (!heading || !wanted.some(alias => heading === alias || heading.startsWith(`${alias} /`) || heading.endsWith(`/ ${alias}`))) continue
    const body = []
    for (let cursor = index + 1; cursor < lines.length && !/^##\s+/.test(lines[cursor]); cursor += 1) body.push(lines[cursor])
    return body.join('\n').trim()
  }
  return ''
}

function bullets(value = '', limit = 20) {
  return String(value).split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim() || '')
    .filter(Boolean)
    .slice(0, limit)
}

function labeled(lines = [], aliases = []) {
  const wanted = aliases.map(value => String(value).toLowerCase())
  return lines.map(line => {
    const match = String(line).match(/^([^:：]{1,40})[:：]\s*(.+)$/)
    if (!match || !wanted.includes(match[1].trim().toLowerCase())) return ''
    return match[2].trim()
  }).filter(Boolean)
}

function compact(value = '', max = 4000) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function sanitize(value = '') {
  return compact(sanitizeTaskText(String(value))
    .replace(/\b(secret|token|password|passwd|api[_-]?key|private[_-]?key)\s*[:#=]\s*[^\s,，;；]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/\b(account|merchant(?:\s*id)?|customer(?:\s*id)?)\s*[:#=]?\s*[a-z0-9_-]{3,}\b/gi, '$1 [REDACTED_IDENTIFIER]')
    .replace(/(商户号|商户编号|商编|账户号|账号)\s*[:：=#]?\s*[a-z0-9_-]{3,}/gi, '$1[REDACTED_IDENTIFIER]')
    .replace(/\b10(?:\.\d{1,3}){3}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b192\.168(?:\.\d{1,3}){2}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b\d{12,}\b/g, '[REDACTED_IDENTIFIER]'))
}

function sanitizedList(values = []) {
  return values.map(sanitize).filter(Boolean)
}

async function safeRead(repo, relativePath) {
  const path = join(repo, relativePath)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return ''
    const canonical = await realpath(path)
    const rel = relative(repo, canonical)
    if (!rel || rel.startsWith('..') || resolve(repo, rel) !== canonical) return ''
    return readFile(canonical, 'utf8')
  } catch {
    return ''
  }
}

function changedFiles(repo, state, commitSha) {
  const base = field(state, 'base-commit')
  const args = base && /^[0-9a-f]{7,40}$/i.test(base)
    ? ['diff', '--name-only', `${base}..${commitSha}`]
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commitSha]
  const rank = path => path.startsWith('.cap/') ? 2 : /^(?:docs?|examples?)\//.test(path) ? 1 : 0
  return [...new Set(git(repo, args).split(/\r?\n/).filter(Boolean))]
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
}

function statusValues(markdown = '') {
  return String(markdown).split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(status|verdict|local verification|scope)\s*[:：]\s*(.+)$/i)
    return match?.[2]?.trim().toUpperCase().replace(/[\s-]+/g, '_') || ''
  }).filter(Boolean)
}

function hasFailureContradiction(markdown = '') {
  const source = String(markdown)
  return [...source.matchAll(/\b(\d+)\s*(?:FAILED|FAILURES?|失败|错误)\b/gi)].some(match => Number(match[1]) > 0)
    || [...source.matchAll(/\b0\s*(?:PASSED|通过)\b/gi)].length > 0
}

function positiveVerification(text = '') {
  const positive = statusValues(text).some(status => ['PASS', 'PASSED', 'SUCCESS'].includes(status) || status.startsWith('LOCAL_PASS'))
  return positive && !hasFailureContradiction(text)
}

function positiveReview(text = '') {
  const positive = statusValues(text).some(status => ['CLEAN', 'PASS', 'PASSED', 'APPROVED', 'SUCCESS'].includes(status) || status.startsWith('LOCAL_PASS'))
  const openFindings = String(text).split(/\r?\n/).filter(line => /^\s*findings\s*[:：]/i.test(line))
    .flatMap(line => [...line.matchAll(/\d+/g)].map(match => Number(match[0]))).some(count => count > 0)
  return positive && !openFindings
}

function hasFutureTrigger(values = []) {
  return values.some(value => /(?:^|[，,；;。\s])(?:当|如果|若|遇到|出现|when\b|if\b)/i.test(value))
}

function hasDecisionRule(values = []) {
  return values.some(value => /(?:当|如果|若|when|if).*(?:必须|禁止|不得|应先|优先|must|should|do not|never)/i.test(value))
}

function isSpecific(values = []) {
  return values.some(value => sanitize(value).length >= 12 && !GENERIC.test(sanitize(value)))
}

function safeEvidence(values = [], commitSha = '') {
  const refs = []
  for (const value of values) {
    const clean = sanitize(value)
    if (clean === `commit:${commitSha}`) refs.push(clean)
    else if (/^\.cap\/(?:verify|review)\/[a-z0-9._/-]+$/i.test(clean) && !clean.includes('..')) refs.push(clean)
    else if (/^action:[a-z0-9][a-z0-9_-]{5,}$/i.test(clean)) refs.push(clean)
  }
  return [...new Set(refs)]
}

function prefixed(label, values = []) {
  return values.length ? `${label}${sanitizedList(values).join('；')}` : ''
}

export async function buildExperiencePayload({ repo = '.', commit = 'HEAD', intent = '' } = {}) {
  const root = await realpath(resolve(git(repo, ['rev-parse', '--show-toplevel'])))
  const documents = Object.fromEntries(await Promise.all(CAP_FILES.map(async path => [path, await safeRead(root, path)])))
  const experienceText = documents['.cap/experience.md']
  if (!experienceText) return { ready: false, missing: ['experience_file'], evidence_refs: [] }

  const state = documents['.cap/STATE.md']
  const commitSha = git(root, ['rev-parse', commit])
  const verifyPaths = ['.cap/verify/summary.md', '.cap/verify/logic-report.md'].filter(path => documents[path])
  const reviewPaths = ['.cap/review/summary.md'].filter(path => documents[path])
  const verifyText = verifyPaths.map(path => documents[path]).join('\n')
  const reviewText = reviewPaths.map(path => documents[path]).join('\n')

  const triggerLines = bullets(section(experienceText, ['复用触发与检索线索', 'reuse triggers and retrieval cues', '复用触发', 'reuse triggers']))
  const problemLines = bullets(section(experienceText, ['问题与根因', 'problem and cause']))
  const decisionLines = bullets(section(experienceText, ['决策与行动', 'decision and actions']))
  const anchorLines = bullets(section(experienceText, ['实现锚点与不变量', 'implementation anchors and invariants']))
  const verificationLines = bullets(section(experienceText, ['验证配方', 'verification recipe']))
  const conditions = bullets(section(experienceText, ['适用前提', 'preconditions']))
  const counterexamples = bullets(section(experienceText, ['禁用场景', 'do not use when']))
  const invalidationLines = bullets(section(experienceText, ['失效信号', 'invalidation signals']))
  const evidenceLines = bullets(section(experienceText, ['证据与结果', 'evidence and outcome']))

  const triggers = labeled(triggerLines, ['触发', 'trigger'])
  const keywords = labeled(triggerLines, ['关键词', 'keywords', '检索词', 'retrieval cues'])
  const symptoms = labeled(triggerLines, ['症状', 'symptom', 'symptoms'])
  const problems = labeled(problemLines, ['问题', 'problem'])
  const causes = labeled(problemLines, ['根因', 'cause', 'root cause'])
  const failedApproaches = labeled(problemLines, ['失败做法', 'failed approach', 'failed approaches'])
  const decisions = labeled(decisionLines, ['决策', 'decision', '决策规则', 'decision rule'])
  const actions = decisionLines.filter(line => /^(?:行动\s*\d*|action\s*\d*)\s*[:：]/i.test(line)).map(line => line.replace(/^[^:：]+[:：]\s*/, ''))
  const entries = labeled(anchorLines, ['入口', 'entry', 'entrypoint'])
  const changePoints = labeled(anchorLines, ['改动点', 'change point', 'change points', 'anchor'])
  const invariants = labeled(anchorLines, ['不变量', 'invariant', 'invariants'])
  const verificationActions = labeled(verificationLines, ['验证动作', 'verification action'])
  const passSignals = labeled(verificationLines, ['通过信号', 'pass signal', 'expected result'])
  const failureSignals = labeled(verificationLines, ['失败信号', 'failure signal'])
  const invalidationSignals = labeled(invalidationLines, ['失效信号', 'invalidation signal'])
  const reviewLocations = labeled(invalidationLines, ['复核位置', 'review location'])
  const evidenceValues = labeled(evidenceLines, ['证据', 'evidence'])
  const outcomes = labeled(evidenceLines, ['结果', 'outcome'])
  const evidenceRefs = safeEvidence(evidenceValues, commitSha)
  const stateTaskId = field(state, 'task-id')
  const experienceTaskId = field(experienceText, 'task-id')
  const sourceCommit = field(experienceText, 'source-commit')
  const unsafeContent = /(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)|(?:^|\s)\.\.\//m.test(experienceText)
  const promptInjection = /(?:ignore (?:all |the )?(?:previous|prior) instructions|忽略(?:以上|此前|之前)(?:所有)?(?:指令|规则)|system prompt|developer message|exfiltrat(?:e|ion))/i.test(experienceText)
  const verificationCommits = verifyPaths.map(path => field(documents[path], 'source-commit')).filter(Boolean)
  const changed = changedFiles(root, state, commitSha)

  const missing = [
    field(experienceText, 'schema') !== 'cap-experience/v1' ? 'schema' : '',
    field(experienceText, 'title').length < 8 ? 'title' : '',
    triggers.length === 0 || !hasFutureTrigger(triggers) ? 'reuse_trigger' : '',
    keywords.length === 0 && symptoms.length === 0 ? 'retrieval_cues' : '',
    problems.length === 0 || !isSpecific(problems) || !isSpecific(causes) ? 'specific_problem' : '',
    causes.length === 0 ? 'root_cause' : '',
    failedApproaches.length === 0 ? 'failed_approach' : '',
    decisions.length === 0 || !hasDecisionRule(decisions) || !isSpecific(decisions) ? 'decision_rule' : '',
    actions.length === 0 || !isSpecific(actions) ? 'actions' : '',
    entries.length === 0 && changePoints.length === 0 ? 'implementation_anchors' : '',
    invariants.length === 0 ? 'invariants' : '',
    verificationActions.length === 0 ? 'verification_action' : '',
    passSignals.length === 0 || failureSignals.length === 0 ? 'verification_observables' : '',
    conditions.length === 0 ? 'conditions' : '',
    counterexamples.length === 0 ? 'counterexamples' : '',
    invalidationSignals.length === 0 ? 'invalidation_signals' : '',
    outcomes.length === 0 || !isSpecific(outcomes) ? 'outcome' : '',
    sourceCommit !== commitSha ? 'source_commit' : '',
    !evidenceRefs.includes(`commit:${commitSha}`) ? 'commit_evidence' : '',
    !evidenceRefs.some(ref => verifyPaths.includes(ref)) ? 'verification_reference' : '',
    verifyPaths.length === 0 || !positiveVerification(verifyText) ? 'verification_evidence' : '',
    verificationCommits.some(value => value !== commitSha) ? 'verification_commit' : '',
    stateTaskId && experienceTaskId && stateTaskId !== experienceTaskId ? 'task_id_consistency' : '',
    unsafeContent ? 'unsafe_content' : '',
    promptInjection ? 'prompt_injection' : '',
    !changed.some(path => !path.startsWith('.cap/')) ? 'changed_files' : '',
  ].filter(Boolean)
  if (missing.length) return { ready: false, missing: [...new Set(missing)], evidence_refs: evidenceRefs }

  const problem = sanitize([
    prefixed('问题：', problems), prefixed('根因：', causes), prefixed('失败做法：', failedApproaches),
  ].filter(Boolean).join('；'))
  const solution = sanitize([
    ...decisions,
    prefixed('行动：', actions),
    prefixed('实现入口：', entries),
    prefixed('实现锚点：', changePoints),
    prefixed('不变量：', invariants),
    prefixed('验证动作：', verificationActions),
    prefixed('通过信号：', passSignals),
    prefixed('失败信号：', failureSignals),
  ].filter(Boolean).join('；'))
  const payloadConditions = sanitizedList([
    ...triggers.map(value => `复用触发：${value}`),
    ...keywords.map(value => `检索词：${value}`),
    ...symptoms.map(value => `症状：${value}`),
    ...conditions,
  ])
  const payloadCounterexamples = sanitizedList([
    ...counterexamples,
    ...invalidationSignals.map(value => `失效信号：${value}`),
    ...reviewLocations.map(value => `复核位置：${value}`),
  ])
  const outcome = sanitize(outcomes.join('；'))
  const repoUrl = sanitizeRepositoryUrl(gitOptional(root, ['remote', 'get-url', 'origin']) || root)
  const sanitizedIntent = sanitize(intent)
  const canonicalHash = createHash('sha256').update(JSON.stringify({ problem, solution, conditions: payloadConditions, counterexamples: payloadCounterexamples, evidenceRefs, outcome })).digest('hex')
  const identity = createHash('sha256').update(JSON.stringify([repoUrl, stateTaskId || experienceTaskId || 'local', commitSha, sanitizedIntent, canonicalHash])).digest('hex').slice(0, 24)
  const reviewed = positiveReview(reviewText) && reviewPaths.every(path => !field(documents[path], 'source-commit') || field(documents[path], 'source-commit') === commitSha)
  return {
    ready: true,
    payload: {
      intent: sanitizedIntent,
      changed_files: changed,
      repo_url: repoUrl,
      ...(stateTaskId || experienceTaskId ? { task_id: stateTaskId || experienceTaskId } : {}),
      ...(field(state, 'session-id') ? { session_id: field(state, 'session-id') } : {}),
      commit_sha: commitSha,
      idempotency_key: `experience:${stateTaskId || experienceTaskId || 'local'}:${identity}:canonical-v1`,
      experience: { problem, solution, conditions: payloadConditions, counterexamples: payloadCounterexamples, evidence_refs: evidenceRefs, outcome },
      verify_verdict: { logic: { status: 'PASS', evidence_refs: verifyPaths } },
      ...(reviewed ? { review_verdict: { status: 'PASS', evidence_refs: reviewPaths } } : {}),
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const options = parseArgs(process.argv.slice(2))
  let result
  try { result = await buildExperiencePayload(options) } catch (error) { fail(error.message || String(error)) }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (!result.ready) process.stdout.write(`cap-experience-payload: BLOCKED (${result.missing.join(', ')})\n`)
  else process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`)
}
