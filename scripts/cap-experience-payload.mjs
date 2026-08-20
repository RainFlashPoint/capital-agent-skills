#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeRepositoryUrl } from './client-delivery.mjs'
import { sanitizeTaskText } from './cap-task-request.mjs'

const MAX_FILE_BYTES = 256 * 1024
const CAP_FILES = ['.cap/STATE.md', '.cap/spec.md', '.cap/verify/summary.md', '.cap/verify/logic-report.md', '.cap/review/summary.md']

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
  return String(markdown).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}

function section(markdown = '', names = []) {
  const wanted = new Set(names.map(name => String(name).trim().toLowerCase()))
  const lines = String(markdown).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase()
    if (!heading || !wanted.has(heading)) continue
    const body = []
    for (let cursor = index + 1; cursor < lines.length && !/^##\s+/.test(lines[cursor]); cursor += 1) {
      body.push(lines[cursor])
    }
    if (body.join('\n').trim()) return body.join('\n').trim()
  }
  return ''
}

function bullets(value = '', limit = 10) {
  return String(value).split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim() || '')
    .filter(Boolean)
    .slice(0, limit)
}

function compact(value = '', max = 2000) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function sanitize(value = '') {
  return compact(sanitizeTaskText(String(value))
    .replace(/\b(account|merchant(?:\s*id)?|customer(?:\s*id)?)\s*[:#=]?\s*[a-z0-9_-]{3,}\b/gi, '$1 [REDACTED_IDENTIFIER]')
    .replace(/(商户号|商户编号|商编|账户号|账号)\s*[:：=#]?\s*[a-z0-9_-]{3,}/gi, '$1[REDACTED_IDENTIFIER]')
    .replace(/\b10(?:\.\d{1,3}){3}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b192\.168(?:\.\d{1,3}){2}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/g, '[REDACTED_PRIVATE_ADDRESS]')
    .replace(/\b\d{12,}\b/g, '[REDACTED_IDENTIFIER]'))
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
  return [...new Set(git(repo, args).split(/\r?\n/).filter(Boolean))].sort()
}

function labeledValues(markdown = '', labels = []) {
  const wanted = new Set(labels.map(label => label.toLowerCase()))
  return String(markdown).split(/\r?\n/).map(line => {
    const match = line.match(/^\s*([^:：]+)[:：]\s*(.+?)\s*$/)
    if (!match || !wanted.has(match[1].trim().toLowerCase())) return ''
    return match[2].trim().toUpperCase().replace(/[\s-]+/g, '_')
  }).filter(Boolean)
}

function hasPositiveCountContradiction(markdown = '') {
  const source = String(markdown)
  const failed = [...source.matchAll(/\b(\d+)\s*(?:FAILED|FAILURES?|失败|错误)\b/gi)].some(match => Number(match[1]) > 0)
  const zeroPassed = [...source.matchAll(/\b0\s*(?:PASSED|通过)\b/gi)].length > 0
  return failed || zeroPassed
}

function positiveVerification(verifyText = '') {
  const statuses = labeledValues(verifyText, ['status', 'verdict', 'local verification'])
  const positive = statuses.some(status => ['PASS', 'PASSED', 'SUCCESS'].includes(status) || status.startsWith('LOCAL_PASS'))
  return positive && !hasPositiveCountContradiction(verifyText)
}

function positiveReview(reviewText = '') {
  const statuses = labeledValues(reviewText, ['status', 'verdict', 'scope'])
  const positive = statuses.some(status => ['CLEAN', 'PASS', 'PASSED', 'APPROVED', 'SUCCESS'].includes(status) || status.startsWith('LOCAL_PASS'))
  const openFindings = String(reviewText).split(/\r?\n/)
    .filter(line => /^\s*findings\s*[:：]/i.test(line))
    .flatMap(line => [...line.matchAll(/\d+/g)].map(match => Number(match[0])))
    .some(count => count > 0)
  return positive && !openFindings
}

function actionRefs(value = '') {
  return [...new Set(String(value).match(/\baction_[a-z0-9][a-z0-9_-]{5,}\b/gi) || [])].map(id => `action:${id}`)
}

function finalOutcomeLines(lines = []) {
  return lines
    .filter(line => !/^\s*(?:RED|FAIL(?:ED)?|失败|错误)\s*[:：]/i.test(line))
    .map(line => line
      .replace(/\b0\s*(?:FAILED|FAILURES?|ERRORS?|失败|错误)(?=$|[\s、,，;；。])/gi, '')
      .replace(/([、,，;；])(?:\s*[、,，;；])+/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim())
    .filter(Boolean)
}

export async function buildExperiencePayload({ repo = '.', commit = 'HEAD', intent = '' } = {}) {
  const root = await realpath(resolve(git(repo, ['rev-parse', '--show-toplevel'])))
  const documents = Object.fromEntries(await Promise.all(CAP_FILES.map(async path => [path, await safeRead(root, path)])))
  const state = documents['.cap/STATE.md']
  const spec = documents['.cap/spec.md']
  const verifyPaths = ['.cap/verify/summary.md', '.cap/verify/logic-report.md'].filter(path => documents[path])
  const reviewPaths = ['.cap/review/summary.md'].filter(path => documents[path])
  const verifyText = verifyPaths.map(path => documents[path]).join('\n')
  const reviewText = reviewPaths.map(path => documents[path]).join('\n')
  const commitSha = git(root, ['rev-parse', commit])
  const problem = sanitize(section(spec, ['Goal', 'Problem', '目标', '问题']))
  const contract = bullets(section(spec, ['Contract', 'Solution', '契约', '方案']))
  const decisions = bullets(section(state, ['Decisions log', '决策记录']))
  const solution = sanitize([...contract, ...decisions].slice(0, 8).join('；'))
  const conditions = bullets(section(spec, ['Safety', 'Conditions', '安全', '适用条件'])).map(sanitize).filter(Boolean)
  const counterexamples = bullets(section(spec, ['Out of scope', 'Counterexamples', '不在范围', '反例'])).map(sanitize).filter(Boolean)
  const evidenceRefs = [
    `commit:${commitSha}`,
    ...['.cap/spec.md', ...verifyPaths, ...reviewPaths].filter(path => documents[path]),
    ...actionRefs(`${state}\n${verifyText}`),
  ]
  const evidence = bullets(section(verifyText, ['Evidence', '验证证据']), 8)
  const journey = bullets(section(verifyText, ['External journey', '外部旅程']), 6)
  const outcome = sanitize(finalOutcomeLines([...evidence, ...journey]).slice(0, 10).join('；'))
  const verified = positiveVerification(verifyText)
  const reviewed = positiveReview(reviewText)
  const missing = [
    problem.length < 12 ? 'problem' : '',
    solution.length < 12 ? 'solution' : '',
    conditions.length === 0 ? 'conditions' : '',
    counterexamples.length === 0 ? 'counterexamples' : '',
    verifyPaths.length === 0 || !verified ? 'verification_evidence' : '',
    outcome.length < 12 ? 'outcome' : '',
    !field(state, 'task-id') ? 'task_id' : '',
    !field(state, 'session-id') ? 'session_id' : '',
  ].filter(Boolean)
  if (missing.length) return { ready: false, missing, evidence_refs: evidenceRefs }

  const repoUrl = sanitizeRepositoryUrl(gitOptional(root, ['remote', 'get-url', 'origin']) || root)
  const sanitizedIntent = sanitize(intent)
  const taskId = field(state, 'task-id')
  const identity = createHash('sha256').update(JSON.stringify([repoUrl, taskId, commitSha, sanitizedIntent])).digest('hex').slice(0, 24)
  return {
    ready: true,
    payload: {
      intent: sanitizedIntent,
      changed_files: changedFiles(root, state, commitSha),
      repo_url: repoUrl,
      task_id: taskId,
      session_id: field(state, 'session-id'),
      commit_sha: commitSha,
      idempotency_key: `experience:${taskId}:${identity}:deterministic-v2`,
      experience: {
        problem,
        solution,
        conditions,
        counterexamples,
        evidence_refs: evidenceRefs,
        outcome,
      },
      verify_verdict: {
        logic: { status: 'PASS', evidence_refs: verifyPaths },
        ...(journey.length ? { journey: { status: 'PASS', evidence_refs: verifyPaths } } : {}),
      },
      ...(reviewed ? { review_verdict: { status: 'PASS', evidence_refs: reviewPaths } } : {}),
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const options = parseArgs(process.argv.slice(2))
  let result
  try {
    result = await buildExperiencePayload(options)
  } catch (error) {
    fail(error.message || String(error))
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (!result.ready) process.stdout.write(`cap-experience-payload: BLOCKED (${result.missing.join(', ')})\n`)
  else process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`)
}
