#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_TEXT_BYTES = 256 * 1024
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--intent') intent = argv[++index] || ''
    else if (arg === '--limit') limit = Math.max(1, Math.min(20, Number(argv[++index]) || 8))
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) fail(`未知参数：${arg}`)
    else repo = arg
  }
  if (!intent.trim()) fail('缺少 --intent')
  return { repo, intent: intent.trim(), limit, json }
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

function scoreCandidate(candidate, intentTerms) {
  const candidateTerms = terms(candidate.searchText)
  const matched = [...intentTerms].filter(term => candidateTerms.has(term))
  let score = matched.reduce((sum, term) => {
    if (/^\d+$/.test(term)) return sum + 14
    if (/^[a-z0-9]+$/.test(term)) return sum + Math.min(8, Math.max(3, term.length))
    return sum + Math.min(6, term.length + 1)
  }, 0)
  if (candidate.source_type === 'cap_index') score += matched.length > 0 ? 5 : 0
  if (candidate.source_type === 'branch') score += matched.length > 0 ? 3 : 0
  if (candidate.source_type === 'cap_memory') score = Math.min(12, score + (matched.length > 0 ? 2 : 0))
  return {
    ...candidate,
    score: Math.min(100, score),
    reason: matched.length > 0 ? `命中：${matched.sort((a, b) => b.length - a.length).slice(0, 6).join('、')}` : '',
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

function gitCandidates(repo) {
  const candidates = []
  const refs = git(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(subject)', 'refs/heads', 'refs/remotes'])
  for (const line of refs.split('\n').filter(Boolean)) {
    const [ref, commit, ...subjectParts] = line.split('\t')
    if (!ref || ref.endsWith('/HEAD')) continue
    const subject = subjectParts.join('\t')
    candidates.push({
      source_type: 'branch', branch: ref, commit, subject,
      searchText: `${ref} ${subject}`,
      inspect: { kind: 'git_ref', value: ref },
    })
  }
  const log = git(repo, ['log', '--all', '-n', '300', '--format=%H%x09%D%x09%s'])
  for (const line of log.split('\n').filter(Boolean)) {
    const [commit, refsForCommit, ...subjectParts] = line.split('\t')
    const subject = subjectParts.join('\t')
    candidates.push({
      source_type: 'commit', commit, refs: refsForCommit, subject,
      searchText: `${refsForCommit} ${subject}`,
      inspect: { kind: 'git_commit', value: commit },
    })
  }
  return candidates
}

function capCandidates(repo) {
  const capRoot = join(repo, '.cap')
  const candidates = []
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
    for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
      candidates.push({
        source_type: 'cap_archive', file: `.cap/archive/${entry.name}`,
        searchText: entry.name,
        inspect: { kind: 'repo_path', value: `.cap/archive/${entry.name}` },
      })
    }
  }

  // 历史正文可能很大且可能含不可信仓库内容；正常侦察只读显式索引，不递归读取快照。
  const indexRoot = join(capRoot, 'history', 'index')
  if (existsSync(indexRoot)) {
    for (const entry of readdirSync(indexRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = `.cap/history/index/${entry.name}`
      candidates.push({
        source_type: 'cap_index', file,
        searchText: `${entry.name} ${safeRead(join(indexRoot, entry.name))}`,
        inspect: { kind: 'repo_file', value: file },
      })
    }
  }
  return candidates
}

function publicCandidate(candidate) {
  const { searchText, ...result } = candidate
  return result
}

export function inspectHistory({ repo = '.', intent = '', limit = 8 } = {}) {
  const root = resolve(git(repo, ['rev-parse', '--show-toplevel']))
  const intentTerms = terms(intent)
  const candidates = [...gitCandidates(root), ...capCandidates(root)]
    .map(candidate => scoreCandidate(candidate, intentTerms))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.source_type.localeCompare(right.source_type) || String(left.inspect?.value).localeCompare(String(right.inspect?.value)))
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
  return { repo: root, intent, scanned: { branches_and_tips: true, recent_commits: true, cap_memory: true, cap_history_index_only: true }, matches }
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
