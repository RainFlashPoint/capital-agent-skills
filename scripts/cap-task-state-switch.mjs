#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectTaskBoundary } from './cap-status.mjs'

const ACTIVE_PATHS = ['STATE.md', 'task-context.md', 'spec.md', 'plan.md', 'verify', 'review', 'release']

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
function field(markdown = '', name = '') {
  return String(markdown).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}
function safeSegment(value = '', fallback = 'unknown') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
}

export async function switchTaskState({ repoRoot = '.', taskId, sessionId, expectedOldTaskId = '', title = '新研发任务', intentSummary = '', stage = 'understand' } = {}) {
  if (!taskId || !sessionId) throw new Error('taskId and sessionId are required')
  const repo = resolve(repoRoot)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  if (await realpath(gitRoot) !== await realpath(repo)) throw new Error(`repoRoot must be the Git root: ${gitRoot}`)
  const capRoot = join(repo, '.cap')
  const statePath = join(capRoot, 'STATE.md')
  const oldState = await readFile(statePath, 'utf8').catch(() => '')
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const boundary = inspectTaskBoundary({ stateText: oldState, branch, worktree: gitRoot })
  const oldTaskId = field(oldState, 'task-id') || 'unknown-task'
  const explicitReplacement = expectedOldTaskId && expectedOldTaskId === oldTaskId && taskId !== oldTaskId
  if (oldState && !boundary.blocked && !explicitReplacement) throw new Error('active STATE matches the current branch/worktree; refusing implicit Task replacement without the exact old Task ID')

  await mkdir(capRoot, { recursive: true })
  const fingerprint = createHash('sha256').update(`${oldState}\n${branch}\n${gitRoot}`).digest('hex').slice(0, 12)
  const snapshotRoot = join(capRoot, 'local-state', 'stale', safeSegment(oldTaskId), fingerprint)
  if (await exists(snapshotRoot)) throw new Error(`stale snapshot already exists: ${snapshotRoot}`)
  await mkdir(snapshotRoot, { recursive: true })

  const moved = []
  try {
    for (const name of ACTIVE_PATHS) {
      const source = join(capRoot, name)
      if (!await exists(source)) continue
      const destination = join(snapshotRoot, name)
      await rename(source, destination)
      moved.push({ source, destination })
    }
    await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify({ oldTaskId, oldSessionId: field(oldState, 'session-id'), oldBranch: field(oldState, 'branch'), currentBranch: branch, currentWorktree: gitRoot, fingerprint, moved: moved.map(item => item.source.slice(capRoot.length + 1)) }, null, 2)}\n`)
    await writeFile(statePath, `# Cap State: ${title}\n\nstage: ${stage}\nstatus: in-progress\ntask-id: ${taskId}\nsession-id: ${sessionId}\nbranch: ${branch}\nbranch-purpose: feature/${safeSegment(title, 'task')}\nbase-commit: ${head}\nworktree: ${gitRoot}\nupdated: pending\n\n## Gates passed\n- [ ] context：task-context.md 已基于当前任务与代码 HEAD 刷新\n- [x] git：旧任务状态已安全隔离，当前分支与本 Task 绑定\n\n## Decisions log\n- 旧活动状态已保存到 .cap/local-state/stale/${safeSegment(oldTaskId)}/${fingerprint}，未修改业务源码。\n\n## Next action\n-> refresh task-context before implementation\n`)
    await writeFile(join(capRoot, 'task-context.md'), `# Task Context\n\n- intent: ${intentSummary || title}\n- branch: ${branch}\n- head: ${head}\n- status: pending-reconnaissance\n\n当前文件仅完成 Task 边界切换；进入需求确认、计划或编码前必须重新执行任务级代码侦察。\n`)
  } catch (error) {
    await rm(statePath, { force: true }).catch(() => {})
    await rm(join(capRoot, 'task-context.md'), { force: true }).catch(() => {})
    for (const item of moved.reverse()) await rename(item.destination, item.source).catch(() => {})
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { switched: true, snapshotRoot, oldTaskId, taskId, sessionId, branch, head }
}

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1]
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const input = args(process.argv.slice(2))
  const result = await switchTaskState({ repoRoot: input.repo || '.', taskId: input['task-id'], sessionId: input['session-id'], expectedOldTaskId: input['expected-old-task'], title: input.title, intentSummary: input.intent, stage: input.stage })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
