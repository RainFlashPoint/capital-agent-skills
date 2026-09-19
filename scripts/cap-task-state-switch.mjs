#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectTaskBoundary } from './cap-status.mjs'
import { archiveHistoricalOutboxEvents } from './cap-outbox.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { captureTaskBaseline, removeTaskBaseline } from './cap-worktree-baseline.mjs'

const ACTIVE_PATHS = ['STATE.md', 'task-context.md', 'spec.md', 'plan.md', 'experience.md', 'verify', 'review', 'release']

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
function trackedActivePaths(repo) {
  const pathspecs = ACTIVE_PATHS.map(name => `.cap/${name}`)
  const output = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] })
  return output.toString('utf8').split('\0').filter(Boolean).sort()
}
function pathIsIgnored(repo, path) {
  return spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repo }).status === 0
}
async function prepareTrackedActiveMigration(repo, tracked) {
  const uncovered = tracked.filter(path => !pathIsIgnored(repo, path))
  if (uncovered.length) throw new Error(`tracked_cap_ignore_policy_missing: ${uncovered.join(', ')}`)
  const indexValue = git(repo, ['rev-parse', '--git-path', 'index'])
  const indexPath = resolve(repo, indexValue)
  const temporaryIndex = join(dirname(indexPath), `.cap-index-${process.pid}-${randomUUID()}`)
  const originalIndex = await readFile(indexPath)
  const originalIndexHash = createHash('sha256').update(originalIndex).digest('hex')
  await writeFile(temporaryIndex, originalIndex)
  try {
    execFileSync('git', ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...tracked], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    await rm(temporaryIndex, { force: true })
    throw new Error(`tracked_cap_index_migration_failed: ${error?.stderr?.toString()?.trim() || error.message}`)
  }
  return { indexPath, temporaryIndex, originalIndexHash, tracked }
}
async function commitTrackedActiveMigration(migration, { beforeReplace, replace = rename } = {}) {
  if (beforeReplace) await beforeReplace()
  const lockPath = `${migration.indexPath}.lock`
  let lock
  try {
    lock = await open(lockPath, 'wx')
    const currentIndex = await readFile(migration.indexPath)
    const currentHash = createHash('sha256').update(currentIndex).digest('hex')
    if (currentHash !== migration.originalIndexHash) throw new Error('tracked_cap_index_changed: Git index changed during active-state migration')
    await replace(migration.temporaryIndex, migration.indexPath)
  } finally {
    await lock?.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
function field(markdown = '', name = '') {
  return String(markdown).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}
function safeSegment(value = '', fallback = 'unknown') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
}

export async function switchTaskState({ repoRoot = '.', taskId, sessionId, expectedOldTaskId = '', title = '新研发任务', intentSummary = '', stage = 'understand', environment = {}, sessionRootRegistry = '', migrateTrackedActive = false, beforeTrackedIndexReplace, replaceTrackedIndex } = {}) {
  if (!taskId || !sessionId) throw new Error('taskId and sessionId are required')
  const repo = resolve(repoRoot)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  if (await realpath(gitRoot) !== await realpath(repo)) throw new Error(`repoRoot must be the Git root: ${gitRoot}`)
  const sessionRoot = await inspectSessionRoot({ repoRoot: gitRoot, environment, registryRoot: sessionRootRegistry, capture: false, requireExisting: Boolean(Object.keys(environment).length) })
  if (sessionRoot.blocked) throw new Error(`${sessionRoot.code}: expected ${sessionRoot.expectedRoot || 'captured session root'}, received ${sessionRoot.currentRoot}`)
  const capRoot = join(repo, '.cap')
  const statePath = join(capRoot, 'STATE.md')
  const oldState = await readFile(statePath, 'utf8').catch(() => '')
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const boundary = inspectTaskBoundary({ stateText: oldState, branch, worktree: gitRoot })
  const oldTaskId = field(oldState, 'task-id') || 'unknown-task'
  const explicitReplacement = expectedOldTaskId && expectedOldTaskId === oldTaskId && taskId !== oldTaskId
  if (oldState && !boundary.blocked && !explicitReplacement) throw new Error('active STATE matches the current branch/worktree; refusing implicit Task replacement without the exact old Task ID')
  if (oldState && field(oldState, 'stage').toLowerCase() === 'done') throw new Error('completed_task_requires_retire: completed Task must pass strict Retire before a new Task can start')

  const tracked = trackedActivePaths(repo)
  if (tracked.length && !migrateTrackedActive) {
    throw new Error(`tracked_cap_active_state: refusing to move tracked .cap files into ignored local-state (${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? `, +${tracked.length - 5} more` : ''})`)
  }
  let trackedMigration = null

  await mkdir(capRoot, { recursive: true })
  const fingerprint = createHash('sha256').update(`${oldState}\n${branch}\n${gitRoot}`).digest('hex').slice(0, 12)
  let snapshotRoot = join(capRoot, 'local-state', 'stale', safeSegment(oldTaskId), fingerprint)
  if (!oldState) {
    // With no active STATE there is no prior task identity to disambiguate a
    // repeated boundary. Keep each snapshot rather than treating the same
    // empty-state fingerprint as a collision.
    snapshotRoot = join(capRoot, 'local-state', 'stale', safeSegment(oldTaskId), `${fingerprint}-${randomUUID()}`)
  } else if (await exists(snapshotRoot)) throw new Error(`stale snapshot already exists: ${snapshotRoot}`)
  await mkdir(snapshotRoot, { recursive: true })

  const moved = []
  let newStateStarted = false
  let newContextStarted = false
  let taskBaseline = null
  let outboxArchive = { archived: 0, pending: 0, totalBefore: 0, archivePath: '', retainedHistoricalPending: 0 }
  try {
    if (tracked.length) trackedMigration = await prepareTrackedActiveMigration(repo, tracked)
    taskBaseline = await captureTaskBaseline(repo, taskId)
    for (const name of ACTIVE_PATHS) {
      const source = join(capRoot, name)
      if (!await exists(source)) continue
      const destination = join(snapshotRoot, name)
      await rename(source, destination)
      moved.push({ source, destination })
    }
    await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify({ oldTaskId, oldSessionId: field(oldState, 'session-id'), oldBranch: field(oldState, 'branch'), currentBranch: branch, currentWorktree: gitRoot, fingerprint, knowledgeDisposition: 'needs-harvest', moved: moved.map(item => item.source.slice(capRoot.length + 1)) }, null, 2)}\n`)
    newStateStarted = true
    await writeFile(statePath, `# Cap State: ${title}\n\nstage: ${stage}\nstatus: in-progress\nexecution-required: true\ntask-id: ${taskId}\nsession-id: ${sessionId}\nbranch: ${branch}\nbranch-purpose: feature/${safeSegment(title, 'task')}\nbase-commit: ${head}\nworktree: ${gitRoot}\nupdated: pending\n\n## Gates passed\n- [ ] context：task-context.md 已基于当前任务与代码 HEAD 刷新\n- [x] git：旧任务状态已安全隔离，当前分支与本 Task 绑定\n\n## Decisions log\n- 旧活动状态已保存到 .cap/local-state/stale/${safeSegment(oldTaskId)}/${fingerprint}，未修改业务源码。\n\n## Next action\n-> refresh task-context before implementation\n`)
    newContextStarted = true
    await writeFile(join(capRoot, 'task-context.md'), `# Task Context\n\n- intent: ${intentSummary || title}\n- branch: ${branch}\n- head: ${head}\n- status: pending-reconnaissance\n\n当前文件仅完成 Task 边界切换；进入需求确认、计划或编码前必须重新执行任务级代码侦察。\n`)
    if (trackedMigration) await commitTrackedActiveMigration(trackedMigration, {
      beforeReplace: beforeTrackedIndexReplace,
      replace: replaceTrackedIndex,
    })
  } catch (error) {
    if (newStateStarted) await rm(statePath, { force: true }).catch(() => {})
    if (newContextStarted) await rm(join(capRoot, 'task-context.md'), { force: true }).catch(() => {})
    for (const item of moved.reverse()) await rename(item.destination, item.source).catch(() => {})
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
    if (trackedMigration) await rm(trackedMigration.temporaryIndex, { force: true }).catch(() => {})
    if (taskBaseline?.created) await removeTaskBaseline(taskBaseline.path).catch(() => {})
    throw error
  }
  try {
    outboxArchive = await archiveHistoricalOutboxEvents(repo, { activeTaskRef: taskId, archiveLabel: oldTaskId })
    if (outboxArchive.archived) {
      const currentState = await readFile(statePath, 'utf8')
      await writeFile(statePath, currentState.replace('\n## Next action', `\n- 已将 ${outboxArchive.archived} 条非当前 Task Outbox 元数据归档，未补报、未删除；活动 Outbox 剩余 ${outboxArchive.pending} 条。\n\n## Next action`))
    }
  } catch (error) {
    outboxArchive = { ...outboxArchive, error: String(error?.message || error) }
    try {
      const currentState = await readFile(statePath, 'utf8')
      await writeFile(statePath, currentState.replace('\n## Next action', `\n- 历史 Outbox 自动归档未完成：${outboxArchive.error}；cap-status 仍按当前 Task 隔离展示，旧事件未重放、未删除。\n\n## Next action`))
    } catch {}
  }
  return { switched: true, snapshotRoot, oldTaskId, taskId, sessionId, branch, head, outboxArchive, taskBaseline: taskBaseline?.path || '', migratedTrackedActive: trackedMigration?.tracked || [] }
}

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, '')
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[key] = argv[++index]
    else result[key] = true
  }
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const input = args(process.argv.slice(2))
  const result = await switchTaskState({ repoRoot: input.repo || '.', taskId: input['task-id'], sessionId: input['session-id'], expectedOldTaskId: input['expected-old-task'], title: input.title, intentSummary: input.intent, stage: input.stage, environment: process.env, migrateTrackedActive: input['migrate-tracked-active'] === true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
