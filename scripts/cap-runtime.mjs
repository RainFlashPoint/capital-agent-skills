#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'

const validStages = new Set(['', 'plan', 'implement', 'test', 'review', 'release'])

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

async function exists(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

function field(markdown = '', name = '') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(markdown).match(new RegExp(`^- ${escaped}:\\s*(.*)$`, 'mi'))?.[1]?.trim()
    || String(markdown).match(new RegExp(`^${escaped}:\\s*(.*)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim()
    || ''
}

async function canonicalRepo(candidate = '.') {
  const root = git(resolve(candidate), ['rev-parse', '--show-toplevel'])
  return realpath(root)
}

async function canonicalComparable(path, base = '') {
  const absolute = isAbsolute(path) ? path : resolve(base || '.', path)
  try { return await realpath(absolute) } catch { return resolve(absolute) }
}

function fail(scope, code, detail) {
  const error = new Error(detail)
  error.scope = scope
  error.code = code
  throw error
}

export async function inspectBoundary(repoCandidate = '.') {
  const repo = await canonicalRepo(repoCandidate)
  const session = await inspectSessionRoot({ repoRoot: repo, environment: process.env, capture: false, requireExisting: true })
  if (session.blocked) fail('cap-guard', session.code || 'session_root_mismatch', session.reason || '会话仓库边界不一致')
  const state = await readFile(join(repo, '.cap', 'STATE.md'), 'utf8').catch(() => '')
  if (!state) return { ok: true, repo, state: false, branch: git(repo, ['branch', '--show-current']) }
  const branch = git(repo, ['branch', '--show-current'])
  const recordedBranch = field(state, 'branch')
  const recordedWorktree = field(state, 'worktree')
  if (recordedBranch && !recordedBranch.startsWith('<') && recordedBranch !== branch) {
    fail('cap-guard', 'branch_mismatch', `STATE 分支=${recordedBranch}，当前分支=${branch}`)
  }
  if (recordedWorktree && recordedWorktree !== '(none)' && !recordedWorktree.startsWith('<')) {
    const expected = await canonicalComparable(recordedWorktree, repo)
    const differs = process.platform === 'win32' ? expected.toLowerCase() !== repo.toLowerCase() : expected !== repo
    if (differs) fail('cap-guard', 'worktree_mismatch', `STATE worktree=${expected}，当前=${repo}`)
  }
  return { ok: true, repo, state: true, branch, stage: field(state, 'stage'), status: field(state, 'status') }
}

function section(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`)
  if (start < 0) return ''
  const body = markdown.slice(start + heading.length + 1)
  const next = body.search(/^## /m)
  return next >= 0 ? body.slice(0, next) : body
}

function hasPath(sectionText = '') {
  return /^- `[^`]+`/m.test(sectionText)
}

export async function inspectTaskContext(repoCandidate = '.', { stage = '', intent = '' } = {}) {
  if (!validStages.has(stage)) fail('cap-context', 'unknown_stage', `未知阶段：${stage}`)
  const boundary = await inspectBoundary(repoCandidate)
  const repo = boundary.repo
  const contextPath = join(repo, '.cap', 'task-context.md')
  if (!await exists(contextPath)) fail('cap-context', 'task_context_missing', '缺少 .cap/task-context.md')
  const context = (await readFile(contextPath, 'utf8')).replace(/\r\n/g, '\n')
  const headings = ['## Entry points', '## Call chain and data flow', '## Similar implementations', '## Tests and environment', '## Evidence sources', '## External operation boundary', '## Impact surface', '## Profile drift']
  for (const heading of headings) if (!context.includes(heading)) fail('cap-context', 'required_section_missing', `缺少必填段：${heading}`)
  const recorded = {
    intent: field(context, 'intent'), branch: field(context, 'branch'), head: field(context, 'head'),
    index: field(context, 'index-fingerprint'), worktree: field(context, 'worktree-fingerprint'), untracked: field(context, 'untracked-fingerprint'),
  }
  for (const [name, value] of Object.entries(recorded)) if (!value) fail('cap-context', `${name}_missing`, `task-context 缺少 ${name}`)
  if (field(context, 'profile-used-as') !== 'index-only') fail('cap-context', 'profile_not_index_only', 'PROFILE 必须标记为 index-only')
  const branch = git(repo, ['branch', '--show-current'])
  let head = ''
  try { head = git(repo, ['rev-parse', '--verify', 'HEAD']) } catch { head = 'working-tree' }
  if (recorded.branch !== branch) fail('cap-context', 'branch_changed', `记录=${recorded.branch}，当前=${branch}`)
  if (recorded.head !== head) fail('cap-context', 'head_changed', `记录=${recorded.head}，当前=${head}`)
  const fingerprints = await inspectContextFingerprint(repo)
  if (recorded.index !== fingerprints.index) fail('cap-context', 'index_fingerprint_changed', '暂存区与调查时不一致')
  if (recorded.worktree !== fingerprints.worktree) fail('cap-context', 'worktree_fingerprint_changed', '未暂存改动与调查时不一致')
  if (recorded.untracked !== fingerprints.untracked) fail('cap-context', 'untracked_fingerprint_changed', '未跟踪文件与调查时不一致')
  if (intent && recorded.intent !== intent) fail('cap-context', 'intent_changed', `记录=${recorded.intent}`)
  for (const heading of ['## Entry points', '## Tests and environment', '## Evidence sources']) {
    if (!hasPath(section(context, heading))) fail('cap-context', 'path_evidence_missing', `${heading} 没有真实路径`)
  }
  for (const key of ['environment', 'authorization', 'minimum-impact', 'recovery', 'invalidates-on']) {
    if (!field(context, key)) fail('cap-context', 'external_boundary_incomplete', `External operation boundary 缺少 ${key}`)
  }
  if (!/^- (?:modify|inspect-only|out-of-scope): `[^`]+`/m.test(section(context, '## Impact surface'))) {
    fail('cap-context', 'impact_surface_missing', 'Impact surface 没有带路径的范围证据')
  }
  return { ok: true, repo, stage, intent: recorded.intent, fingerprints }
}

export async function prepareNext(capCandidate = '.cap') {
  const capRoot = resolve(capCandidate)
  const statePath = join(capRoot, 'STATE.md')
  if (!await exists(statePath)) return { exitCode: 0, result: { ready: true, reason: 'no_active_task' } }
  const state = await readFile(statePath, 'utf8')
  const taskId = field(state, 'task-id')
  const stage = field(state, 'stage').replace(/^cap-/, '').toLowerCase()
  const historyPath = taskId ? join(capRoot, 'history', taskId) : ''
  const historyExists = historyPath ? await stat(historyPath).then(item => item.isDirectory()).catch(() => false) : false
  const result = { ready: false, taskId, stage, historyPath: historyExists ? historyPath : '' }
  if (stage === 'done') {
    return { exitCode: 3, result: { ...result, reason: 'retirement_required', nextAction: 'run strict retire after confirming Server Gate and delivery commit' } }
  }
  return { exitCode: 3, result: { ...result, reason: 'active_task_exists', nextAction: 'resume current task or use another branch/worktree' } }
}

function parseOptions(argv) {
  const result = { target: argv[1] || '.', stage: '', intent: '', json: argv.includes('--json') }
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--stage') result.stage = argv[++index] || ''
    else if (argv[index] === '--intent') result.intent = argv[++index] || ''
  }
  return result
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || ''
  const options = parseOptions(argv)
  if (command === 'guard') {
    const result = await inspectBoundary(options.target)
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `cap-guard: PASS — ${result.repo}\n`)
    return 0
  }
  if (command === 'context') {
    const result = await inspectTaskContext(options.target, options)
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `cap-context: PASS — intent/branch/HEAD/index/worktree/untracked/代码证据均新鲜${options.stage ? `，允许进入 ${options.stage}` : ''}\n`)
    return 0
  }
  if (command === 'prepare-next') {
    const prepared = await prepareNext(options.target)
    process.stdout.write(`${JSON.stringify(prepared.result)}\n`)
    return prepared.exitCode
  }
  fail('cap-runtime', 'unknown_command', '用法：node scripts/cap-runtime.mjs <guard|context|prepare-next> <path> [--stage ...] [--intent ...]')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`${error.scope || 'cap-runtime'}: BLOCKED — ${error.code || 'runtime_error'}: ${error.message}\n`)
    process.exitCode = 1
  })
}
