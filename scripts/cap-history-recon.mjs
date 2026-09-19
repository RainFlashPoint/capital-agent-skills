#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, opendirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_TEXT_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 1000
const HISTORY_INDEX_FIELDS = new Set([
  'schemaVersion', 'taskId', 'parentTaskId', 'title', 'intentSummary', 'keywords',
  'branch', 'baseCommit', 'deliveryCommit', 'completedAt', 'status',
  'knowledgeDisposition', 'artifactRoot', 'knowledgeDocumentId', 'experienceIndex',
])
const EXPERIENCE_INDEX_FIELDS = new Set([
  'schema', 'title', 'sourceCommit', 'retrievalCues', 'problemPatterns', 'decisionRules',
  'invalidationSignals', 'codePaths', 'entryPoints', 'symbols', 'invariants', 'codeAnchors', 'path',
])
const STALE_MANIFEST_FIELDS = new Set([
  'schemaVersion', 'oldTaskId', 'oldSessionId', 'oldBranch', 'currentBranch',
  'currentWorktree', 'fingerprint', 'knowledgeDisposition', 'moved',
])
const CURRENT_DISPOSITIONS = new Set(['synced', 'pending-sync', 'local-only', 'no-reusable-experience'])
const EXPERIENCE_REQUIRED_DISPOSITIONS = new Set(['synced', 'pending-sync', 'local-only'])
const STABLE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'fix', 'feat', 'chore',
  '修复', '实现', '新增', '更新', '修改', '问题', '功能', '一个', '这个', '进行', '相关',
])
const TERM_ALIASES = new Map([
  ['经验', ['experience']], ['闭环', ['loop']], ['历史', ['history', 'legacy']],
  ['知识', ['knowledge']], ['注入', ['injection']], ['归因', ['attribution', 'evidence', 'proof']],
  ['支付', ['payment']], ['回调', ['callback']], ['协议', ['contract', 'protocol']],
])

function fail(message) {
  process.stderr.write(`cap-history-recon: ${message}\n`)
  process.exit(1)
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function parseArgs(argv) {
  let repo = '.'
  let intent = ''
  let limit = 8
  let json = false
  const anchors = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--intent') intent = argv[++index] || ''
    else if (arg === '--limit') limit = Math.max(1, Math.min(20, Number(argv[++index]) || 8))
    else if (arg === '--anchor' || arg === '--changed-file' || arg === '--symbol') anchors.push(argv[++index] || '')
    else if (arg === '--anchors') anchors.push(...String(argv[++index] || '').split(/[\n,]/))
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) fail(`未知参数：${arg}`)
    else repo = arg
  }
  if (!intent.trim()) fail('缺少 --intent')
  return { repo, intent: intent.trim(), anchors: anchors.map(value => value.trim()).filter(Boolean), limit, json }
}

function normalized(value = '') {
  return String(value).normalize('NFKC').toLowerCase().replace(/[_/.:@-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function terms(value = '') {
  const result = new Set()
  for (const segment of normalized(value).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) || []) {
    if (/^[a-z0-9]+$/.test(segment)) {
      if (segment.length >= 2 && !STOP_WORDS.has(segment)) result.add(segment)
      continue
    }
    if (segment.length <= 8 && !STOP_WORDS.has(segment)) result.add(segment)
    for (const size of [2, 3, 4]) {
      for (let index = 0; index + size <= segment.length; index += 1) {
        const token = segment.slice(index, index + size)
        if (!STOP_WORDS.has(token)) result.add(token)
      }
    }
  }
  for (const [term, aliases] of TERM_ALIASES) {
    if (result.has(term)) aliases.forEach(alias => result.add(alias))
  }
  return result
}

function listValues(...values) {
  return values.flatMap(value => Array.isArray(value) ? value.map(scalar).filter(Boolean) : [])
}

function sourceCommitRelation(repo, sourceCommit, head = '', cache = new Map()) {
  const value = String(sourceCommit || '').trim()
  if (!value) return 'missing'
  // SHA-1 repositories use 40 hex digits; SHA-256 repositories use 64.
  // Abbreviated object names are accepted in either format.
  if (!/^[0-9a-f]{7,64}$/i.test(value)) return 'invalid'
  const cacheKey = `${head}\0${value.toLowerCase()}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  let relation = 'unknown'
  try {
    const resolved = git(repo, ['rev-parse', `${value}^{commit}`])
    const currentHead = head || git(repo, ['rev-parse', 'HEAD'])
    if (resolved === currentHead) relation = 'current'
    try {
      if (relation !== 'current') {
        git(repo, ['merge-base', '--is-ancestor', resolved, currentHead])
        relation = 'ancestor'
      }
    } catch {
      return 'diverged'
    }
  } catch {
    relation = 'unknown'
  }
  cache.set(cacheKey, relation)
  return relation
}

function normalizedAnchor(value) {
  return normalized(value).replace(/\s+/g, ' ')
}

function anchorMatches(candidate, anchors) {
  const available = listValues(candidate.anchorValues).map(normalizedAnchor).filter(Boolean)
  return anchors.filter(anchor => {
    const wanted = normalizedAnchor(anchor)
    return wanted && available.some(value => value === wanted || value.includes(wanted) || wanted.includes(value))
  })
}

function scoreCandidate(candidate, intentTerms, anchors = []) {
  const candidateTerms = terms(candidate.searchText)
  const matched = [...intentTerms].filter(term => candidateTerms.has(term))
  const matchedAnchors = anchorMatches(candidate, anchors)
  let score = matched.reduce((sum, term) => {
    if (/^\d+$/.test(term)) return sum + 14
    if (/^[a-z0-9]+$/.test(term)) return sum + Math.min(8, Math.max(3, term.length))
    return sum + Math.min(6, term.length + 1)
  }, 0)
  if (candidate.source_type === 'cap_index') score += matched.length > 0 ? 5 : 0
  if (candidate.source_type === 'branch') score += matched.length > 0 ? 3 : 0
  if (candidate.source_type === 'cap_memory') score = Math.min(12, score + (matched.length > 0 ? 2 : 0))
  if (matchedAnchors.length) {
    score += matchedAnchors.reduce((sum, anchor) => sum + (anchor.includes('/') ? 24 : 30), 0)
    if (candidate.source_type === 'cap_index') score += 10
  }
  const unresolvedDebt = candidate.knowledgeDisposition === 'pending-sync' || candidate.knowledgeDisposition === 'needs-harvest'
  if (unresolvedDebt && score === 0) score = 1
  return {
    ...candidate,
    score: Math.min(100, score),
    matchedAnchors,
    reason: [
      unresolvedDebt ? `待处置知识：${candidate.knowledgeDisposition}` : '',
      matchedAnchors.length ? `代码锚点命中：${matchedAnchors.slice(0, 6).join('、')}` : '',
      matched.length > 0 ? `命中：${matched.sort((a, b) => b.length - a.length).slice(0, 6).join('、')}` : '',
    ].filter(Boolean).join('；'),
  }
}

function safeRead(path) {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TEXT_BYTES) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
function safeJson(path) {
  const text = safeRead(path)
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}
function boundedDirectoryEntries(path, limit = MAX_DIRECTORY_ENTRIES, report = null) {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) return []
    const directory = opendirSync(path)
    const entries = []
    try {
      while (entries.length <= limit) {
        const entry = directory.readSync()
        if (!entry) break
        entries.push(entry)
      }
    } finally {
      directory.closeSync()
    }
    const truncated = entries.length > limit
    if (truncated) entries.length = limit
    entries.sort((left, right) => left.name.localeCompare(right.name))
    if (report) {
      report.entries = entries.length
      report.truncated = truncated
    }
    return entries
  } catch {
    return []
  }
}
function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}
function listText(value) {
  return Array.isArray(value) ? value.map(scalar).filter(Boolean).join(' ') : ''
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function safeIndexText(value, limit = 500) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length > limit) return null
  if (/https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(text)) return null
  if (/(?:^|[\s("':=`])\/(?!\/)(?:[^/\s,，;；]+\/)+[^/\s,，;；]+/.test(text)) return null
  if (/(?:^|[\s("'=])[A-Za-z]:\\/.test(text)) return null
  if (/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(text)) return null
  if (/\b(?:secret|token|password|passwd|api[_-]?key)\s*[:#=]\s*[^\s,，;；]+/i.test(text)) return null
  if (/\bauthorization\s*:\s*(?:(?:bearer|basic|digest)\s+)?[^\s,，;；]+/i.test(text)) return null
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text)) return null
  if (/\b(?:account|merchant(?:\s*id)?|customer(?:\s*id)?)\s*[:#=]\s*[a-z0-9_-]{3,}\b/i.test(text)) return null
  if (/(?:商户号|商户编号|商编|账户号|账号)\s*[:：=#]\s*[a-z0-9_-]{3,}/i.test(text)) return null
  if (/\b(?:[a-z0-9-]+\.)+(?:internal|local|corp|lan)\b/i.test(text)) return null
  return text
}

function safeIndexList(value, { paths = false } = {}) {
  if (!Array.isArray(value) || value.length > 8) return null
  const result = []
  for (const item of value) {
    const text = safeIndexText(item)
    if (text === null || !text || text !== item || result.includes(text)) return null
    if (paths) {
      const segments = text.split('/')
      if (!text || text.startsWith('/') || text.startsWith('\\') || text.includes('\\') || /^[A-Za-z]:/.test(text)) return null
      if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
      if (['users', 'home', 'private', 'tmp', 'opt', 'etc', 'var'].includes(segments[0].toLowerCase())) return null
    }
    result.push(text)
  }
  return result
}

function validExperienceIndex(value, taskId) {
  if (!plainObject(value) || value.schema !== 'cap-experience-index/v1') return null
  if (Object.keys(value).some(key => !EXPERIENCE_INDEX_FIELDS.has(key))) return null
  if (value.path !== `.cap/history/${taskId}/experience.md`) return null
  const result = { schema: value.schema, path: value.path }
  for (const key of ['title', 'sourceCommit']) {
    if (!(key in value)) continue
    const text = safeIndexText(value[key])
    if (text === null) return null
    result[key] = text
  }
  for (const key of ['retrievalCues', 'problemPatterns', 'decisionRules', 'invalidationSignals', 'entryPoints', 'symbols', 'invariants', 'codeAnchors']) {
    if (!(key in value)) continue
    const items = safeIndexList(value[key])
    if (!items) return null
    result[key] = items
  }
  if ('codePaths' in value) {
    const items = safeIndexList(value.codePaths, { paths: true })
    if (!items) return null
    result.codePaths = items
  }
  return result
}

function validHistoryIndex(item, entryName) {
  if (!plainObject(item) || item.schemaVersion !== 1 || Object.keys(item).some(key => !HISTORY_INDEX_FIELDS.has(key))) return null
  const taskId = item.taskId
  if (typeof taskId !== 'string' || !STABLE_TASK_ID.test(taskId) || entryName !== `${taskId}.json`) return null
  if (item.artifactRoot !== `.cap/history/${taskId}`) return null
  const scalarLimits = { parentTaskId: 128, title: 500, intentSummary: 500, branch: 256, baseCommit: 128, deliveryCommit: 128, completedAt: 128, status: 32 }
  for (const [key, limit] of Object.entries(scalarLimits)) {
    if (!(key in item)) continue
    const text = safeIndexText(item[key], limit)
    if (text === null || text !== item[key]) return null
  }
  if ('keywords' in item && !safeIndexList(item.keywords)) return null
  const rawDisposition = item.knowledgeDisposition
  const disposition = rawDisposition === undefined ? 'legacy-unknown' : rawDisposition
  if (rawDisposition !== undefined && !CURRENT_DISPOSITIONS.has(rawDisposition) && rawDisposition !== 'legacy-local' && rawDisposition !== 'legacy-unknown') return null
  const experience = item.experienceIndex === undefined ? null : validExperienceIndex(item.experienceIndex, taskId)
  if (item.experienceIndex !== undefined && !experience) return null
  if (EXPERIENCE_REQUIRED_DISPOSITIONS.has(disposition) && !experience) return null
  if (disposition === 'synced' && (typeof item.knowledgeDocumentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.knowledgeDocumentId))) return null
  if ('knowledgeDocumentId' in item && (typeof item.knowledgeDocumentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.knowledgeDocumentId))) return null
  return { ...item, knowledgeDisposition: disposition, experienceIndex: experience }
}

function validStaleManifest(item, taskName, snapshotName) {
  if (!plainObject(item) || Object.keys(item).some(key => !STALE_MANIFEST_FIELDS.has(key))) return null
  if (item.schemaVersion !== 1 && item.schemaVersion !== undefined) return null
  if (item.oldTaskId !== taskName || !STABLE_TASK_ID.test(taskName)) return null
  if (item.knowledgeDisposition !== 'needs-harvest') return null
  if (typeof item.fingerprint !== 'string' || !/^[0-9a-f]{12}$/.test(item.fingerprint)) return null
  if (snapshotName !== item.fingerprint && !snapshotName.startsWith(`${item.fingerprint}-`)) return null
  for (const key of ['oldSessionId', 'oldBranch', 'currentBranch', 'currentWorktree']) if (typeof item[key] !== 'string') return null
  if (!Array.isArray(item.moved) || item.moved.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))) return null
  return item
}

function gitCandidates(repo) {
  const candidates = []
  const filesByCommit = new Map()
  const log = git(repo, ['log', '--all', '-n', '300', '--name-only', '--format=%H%x09%D%x09%s'])
  let current = null
  const flush = () => {
    if (current) filesByCommit.set(current.commit, current)
    current = null
  }
  for (const line of log.split('\n')) {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})\t/.test(line)) {
      flush()
      const [commit, refsForCommit, ...subjectParts] = line.split('\t')
      current = { commit, refs: refsForCommit, subject: subjectParts.join('\t'), files: [] }
      continue
    }
    if (current && line.trim()) current.files.push(line.trim())
  }
  flush()

  const refs = git(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(subject)', 'refs/heads', 'refs/remotes'])
  for (const line of refs.split('\n').filter(Boolean)) {
    const [ref, commit, ...subjectParts] = line.split('\t')
    if (!ref || ref.endsWith('/HEAD')) continue
    const subject = subjectParts.join('\t')
    const changedFiles = filesByCommit.get(commit)?.files || []
    candidates.push({
      source_type: 'branch', branch: ref, commit, subject,
      anchorValues: changedFiles,
      searchText: `${ref} ${subject} ${changedFiles.join(' ')}`,
      inspect: { kind: 'git_ref', value: ref },
    })
  }
  for (const record of filesByCommit.values()) {
    candidates.push({
      source_type: 'commit', commit: record.commit, refs: record.refs, subject: record.subject,
      anchorValues: record.files,
      searchText: `${record.refs} ${record.subject} ${record.files.join(' ')}`,
      inspect: { kind: 'git_commit', value: record.commit },
    })
  }
  return candidates
}

function capCandidates(repo, scan = {}) {
  const capRoot = join(repo, '.cap')
  const candidates = []
  let head = ''
  try { head = git(repo, ['rev-parse', 'HEAD']) } catch {}
  const sourceCommitCache = new Map()
  for (const name of ['PROFILE.md', 'EVOLUTION.md']) {
    const path = join(capRoot, name)
    if (!existsSync(path)) continue
    candidates.push({
      source_type: 'cap_memory', file: `.cap/${name}`,
      searchText: `${name} ${safeRead(path)}`,
      inspect: { kind: 'repo_file', value: `.cap/${name}` },
    })
  }

  const archiveRoot = join(capRoot, 'archive')
  if (existsSync(archiveRoot)) {
    const archiveReport = { entries: 0, truncated: false }
    for (const entry of boundedDirectoryEntries(archiveRoot, MAX_DIRECTORY_ENTRIES, archiveReport)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      candidates.push({
        source_type: 'cap_archive', file: `.cap/archive/${entry.name}`,
        searchText: entry.name,
        inspect: { kind: 'repo_path', value: `.cap/archive/${entry.name}` },
      })
    }
    scan.cap_archive_entries = archiveReport.entries
    scan.cap_archive_truncated = archiveReport.truncated
  }

  // 历史正文可能很大且可能含不可信仓库内容；正常侦察只读显式索引，不递归读取快照。
  const indexRoot = join(capRoot, 'history', 'index')
  if (existsSync(indexRoot) && !lstatSync(indexRoot).isSymbolicLink() && lstatSync(indexRoot).isDirectory()) {
    const indexReport = { entries: 0, truncated: false }
    for (const entry of boundedDirectoryEntries(indexRoot, MAX_DIRECTORY_ENTRIES, indexReport)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = `.cap/history/index/${entry.name}`
      const item = validHistoryIndex(safeJson(join(indexRoot, entry.name)), entry.name)
      if (!item) continue
      const knowledgeDisposition = item.knowledgeDisposition
      const experienceIndex = item.experienceIndex || {}
      const sourceCommit = scalar(experienceIndex.sourceCommit)
      const anchorValues = listValues(
        experienceIndex.codePaths,
        experienceIndex.entryPoints,
        experienceIndex.symbols,
        experienceIndex.invariants,
        experienceIndex.codeAnchors,
        item?.changedFiles,
      )
      candidates.push({
        source_type: 'cap_index', file,
        knowledgeDisposition,
        sourceCommit,
        sourceCommitRelation: sourceCommitRelation(repo, sourceCommit, head, sourceCommitCache),
        anchorValues,
        searchText: `${entry.name} ${scalar(item?.title)} ${scalar(item?.intentSummary)} ${listText(item?.keywords)} ${listText(experienceIndex.retrievalCues)} ${listText(experienceIndex.decisionRules)} ${listText(experienceIndex.invalidationSignals)} ${anchorValues.join(' ')} ${knowledgeDisposition}`,
        inspect: { kind: 'repo_file', value: file },
      })
    }
    scan.cap_history_index_entries = indexReport.entries
    scan.cap_history_index_truncated = indexReport.truncated
  }
  const staleRoot = join(capRoot, 'local-state', 'stale')
  if (existsSync(staleRoot)) {
    const taskReport = { entries: 0, truncated: false }
    let snapshotEntries = 0
    let snapshotTruncated = false
    const taskEntries = boundedDirectoryEntries(staleRoot, MAX_DIRECTORY_ENTRIES, taskReport)
    for (let taskIndex = 0; taskIndex < taskEntries.length; taskIndex += 1) {
      const taskEntry = taskEntries[taskIndex]
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue
      const remainingSnapshots = MAX_DIRECTORY_ENTRIES - snapshotEntries
      if (remainingSnapshots <= 0) {
        snapshotTruncated = true
        break
      }
      const taskRoot = join(staleRoot, taskEntry.name)
      const snapshotReport = { entries: 0, truncated: false }
      for (const snapshotEntry of boundedDirectoryEntries(taskRoot, remainingSnapshots, snapshotReport)) {
        if (!snapshotEntry.isDirectory() || snapshotEntry.isSymbolicLink()) continue
        const manifestPath = join(taskRoot, snapshotEntry.name, 'manifest.json')
        const item = validStaleManifest(safeJson(manifestPath), taskEntry.name, snapshotEntry.name)
        if (!item) continue
        const knowledgeDisposition = item.knowledgeDisposition
        const file = `.cap/local-state/stale/${taskEntry.name}/${snapshotEntry.name}/manifest.json`
        candidates.push({
          source_type: 'cap_stale', file, taskId: scalar(item.oldTaskId) || taskEntry.name,
          knowledgeDisposition,
          searchText: `${taskEntry.name} ${scalar(item.oldBranch)} ${scalar(item.currentBranch)} ${knowledgeDisposition}`,
          inspect: { kind: 'repo_file', value: file },
        })
      }
      snapshotEntries += snapshotReport.entries
      snapshotTruncated ||= snapshotReport.truncated
      if (snapshotEntries >= MAX_DIRECTORY_ENTRIES && taskIndex + 1 < taskEntries.length) snapshotTruncated = true
    }
    scan.cap_stale_task_entries = taskReport.entries
    scan.cap_stale_task_truncated = taskReport.truncated
    scan.cap_stale_snapshot_entries = snapshotEntries
    scan.cap_stale_snapshot_truncated = snapshotTruncated
  }
  return candidates
}

function publicCandidate(candidate) {
  const { searchText, anchorValues, ...result } = candidate
  return result
}

export function inspectHistory({ repo = '.', intent = '', anchors = [], limit = 8 } = {}) {
  const root = resolve(git(repo, ['rev-parse', '--show-toplevel']))
  const intentTerms = terms(intent)
  const scan = { cap_history_index_entries: 0, cap_history_index_truncated: false }
  const candidates = [...gitCandidates(root), ...capCandidates(root, scan)]
    .map(candidate => scoreCandidate(candidate, intentTerms, anchors))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => {
      const priority = { 'pending-sync': 0, 'needs-harvest': 1, 'local-only': 2, synced: 3, 'no-reusable-experience': 4, 'legacy-unknown': 5 }
      const leftPriority = priority[left.knowledgeDisposition] ?? 6
      const rightPriority = priority[right.knowledgeDisposition] ?? 6
      return leftPriority - rightPriority || right.score - left.score || left.source_type.localeCompare(right.source_type) || String(left.inspect?.value).localeCompare(String(right.inspect?.value))
    })
  const seen = new Set()
  const matches = []
  for (const candidate of candidates) {
    const canonicalBranch = String(candidate.branch || '').replace(/^origin\//, '')
    const key = candidate.source_type === 'branch'
      ? `branch:${canonicalBranch}:${candidate.commit || ''}`
      : `${candidate.source_type}:${candidate.commit || candidate.file || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    matches.push(publicCandidate(candidate))
    if (matches.length >= limit) break
  }
  return { repo: root, intent, anchors, scanned: { branches_and_tips: true, recent_commits: true, cap_memory: true, cap_history_index_only: true, code_anchors: anchors.length > 0, ...scan }, matches }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2))
  let result
  try {
    result = inspectHistory(options)
  } catch (error) {
    fail(error.message || String(error))
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (result.matches.length === 0) process.stdout.write('cap-history-recon: 未发现相关历史候选\n')
  else result.matches.forEach((item, index) => process.stdout.write(`${index + 1}. [${item.source_type}] ${item.branch || item.commit?.slice(0, 12) || item.file} · ${item.reason} · 查看 ${item.inspect?.kind}:${item.inspect?.value}\n`))
}
