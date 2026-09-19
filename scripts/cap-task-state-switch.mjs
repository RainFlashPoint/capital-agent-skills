#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname, relative, sep, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectTaskBoundary } from './cap-status.mjs'
import { archiveHistoricalOutboxEvents } from './cap-outbox.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { captureTaskBaseline, removeTaskBaseline } from './cap-worktree-baseline.mjs'

const ACTIVE_PATHS = ['STATE.md', 'task-context.md', 'spec.md', 'plan.md', 'experience.md', 'verify', 'review', 'release', 'execution']
const RECOVERY_FILE_MAX_BYTES = 8 * 1024 * 1024

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
  let ownsLock = false
  let lockIdentity = null
  try {
    lock = await open(lockPath, 'wx')
    ownsLock = true
    lockIdentity = await lock.stat()
    const currentIndex = await readFile(migration.indexPath)
    const currentHash = createHash('sha256').update(currentIndex).digest('hex')
    if (currentHash !== migration.originalIndexHash) throw new Error('tracked_cap_index_changed: Git index changed during active-state migration')
    await replace(migration.temporaryIndex, migration.indexPath)
  } finally {
    await lock?.close().catch(() => {})
    if (ownsLock && lockIdentity) {
      const currentIdentity = await lstat(lockPath).catch(() => null)
      if (currentIdentity && currentIdentity.dev === lockIdentity.dev && currentIdentity.ino === lockIdentity.ino) {
        await rm(lockPath, { force: true }).catch(() => {})
      }
    }
  }
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
async function readRecoveryFile(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat()
    if (!before.isFile() || before.size > RECOVERY_FILE_MAX_BYTES) throw new Error('task_switch_pending_invalid: recovery file type or size')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(path)
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || offset !== before.size) {
      throw new Error('task_switch_pending_invalid: recovery file changed')
    }
    return bytes.subarray(0, offset).toString('utf8')
  } finally { await handle?.close() }
}
async function replaceStateFile(path, text) {
  const temporary = await writeSyncedTemporaryFile(path, text)
  try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}
async function reclaimDeadTaskSwitchLock(lockPath) {
  const identity = await lstat(lockPath).catch(() => null)
  if (!identity) return false
  let metadata
  try { metadata = JSON.parse(await readRecoveryFile(lockPath)) } catch { return false }
  if (!Number.isInteger(metadata?.pid) || metadata.pid <= 0 || metadata.pid === process.pid) return false
  let alive = true
  try { process.kill(metadata.pid, 0) } catch (error) { if (error?.code === 'ESRCH') alive = false }
  if (alive) return false
  const current = await lstat(lockPath).catch(() => null)
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false
  await rm(lockPath, { force: true })
  return true
}
async function recoverPendingTaskSwitch(repo) {
  const capRoot = join(repo, '.cap')
  const pendingPath = join(capRoot, 'local-state', 'locks', 'task-switch.pending.json')
  let pending
  try { pending = JSON.parse(await readRecoveryFile(pendingPath)) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error('task_switch_pending_invalid: pending boundary journal is not valid JSON or a safe file')
  }
  if (!pending || pending.schemaVersion !== 1 || typeof pending.snapshotRoot !== 'string'
      || typeof pending.taskId !== 'string' || typeof pending.oldTaskId !== 'string'
      || typeof pending.fingerprint !== 'string' || typeof pending.oldState !== 'string'
      || (pending.oldContext !== undefined && typeof pending.oldContext !== 'string')
      || !pending.snapshotRoot || !pending.taskId || !pending.oldTaskId || !pending.fingerprint) {
    throw new Error('task_switch_pending_invalid: pending boundary journal identity is invalid')
  }
  if (!/^[0-9a-f]{12}$/i.test(pending.fingerprint)) {
    throw new Error('task_switch_pending_invalid: snapshot fingerprint is invalid')
  }
  const snapshotRoot = resolve(repo, pending.snapshotRoot)
  const staleRoot = join(capRoot, 'local-state', 'stale')
  const lexicalParts = relative(staleRoot, snapshotRoot).split(sep)
  if (lexicalParts.length !== 2 || lexicalParts[0] !== safeSegment(pending.oldTaskId)
      || !new RegExp(`^${pending.fingerprint}(?:-[0-9a-f-]{36})?$`, 'i').test(lexicalParts[1])) {
    throw new Error('unsafe_cap_state_path: snapshot root must stay under its exact stale Task directory')
  }
  await ensureSafeCapDirectory(repo, staleRoot)
  await ensureSafeCapDirectory(repo, snapshotRoot)
  const canonicalStale = await realpath(staleRoot)
  const canonicalSnapshot = await realpath(snapshotRoot).catch(() => '')
  if (!canonicalSnapshot || (canonicalSnapshot !== canonicalStale && !canonicalSnapshot.startsWith(`${canonicalStale}${sep}`))) {
    throw new Error(`task_switch_pending_invalid: snapshot root must stay under ${staleRoot}`)
  }
  const snapshotRelative = relative(canonicalStale, canonicalSnapshot)
  if (!snapshotRelative || snapshotRelative.startsWith(`..${sep}`) || snapshotRelative === '..') {
    throw new Error('task_switch_pending_invalid: snapshot root is not a stale snapshot directory')
  }
  const expectedParent = join(canonicalStale, safeSegment(pending.oldTaskId))
  const canonicalParent = await realpath(dirname(canonicalSnapshot)).catch(() => '')
  const snapshotName = basename(canonicalSnapshot)
  if (canonicalParent !== expectedParent
      || !new RegExp(`^${pending.fingerprint}(?:-[0-9a-f-]{36})?$`, 'i').test(snapshotName)) {
    throw new Error('task_switch_pending_invalid: snapshot identity does not match the retired Task')
  }
  const snapshotInfo = await lstat(snapshotRoot).catch(() => null)
  if (!snapshotInfo) {
    await rm(pendingPath, { force: true }).catch(() => {})
    return true
  }
  if (!snapshotInfo.isDirectory()) throw new Error('task_switch_pending_invalid: snapshot root is not a directory')
  async function validateSnapshotTree(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error('task_switch_pending_invalid: snapshot contains a link, hardlink, or special file')
    }
    if (info.isFile() && info.nlink > 1) {
      throw new Error('task_switch_pending_invalid: snapshot contains a link, hardlink, or special file')
    }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await validateSnapshotTree(join(path, name))
    }
  }
  await validateSnapshotTree(snapshotRoot)
  const statePath = join(capRoot, 'STATE.md')
  const currentState = await readFile(statePath, 'utf8').catch(() => '')
  const currentTaskId = field(currentState, 'task-id')
  if (currentTaskId === pending.taskId) {
    await rm(pendingPath, { force: true }).catch(() => {})
    return true
  }
  if (currentTaskId && currentTaskId !== pending.oldTaskId) {
    throw new Error('task_switch_pending_invalid: active Task conflicts with recovery')
  }
  for (const name of ACTIVE_PATHS) {
    const destination = join(capRoot, name)
    if (await exists(destination)) await validateSnapshotTree(destination)
  }
  for (const name of ACTIVE_PATHS.slice().reverse()) {
    const source = join(snapshotRoot, name)
    const destination = join(capRoot, name)
    if (await exists(source) && !await exists(destination)) await rename(source, destination)
  }
  // Keep the snapshot until a successful subsequent boundary has preserved it.
  // Never recursively delete paths supplied by recovery metadata.
  if (pending.oldState) await replaceStateFile(statePath, pending.oldState)
  if (pending.oldContext !== undefined) await replaceStateFile(join(capRoot, 'task-context.md'), pending.oldContext)
  await rename(snapshotRoot, `${snapshotRoot}-recovered-${randomUUID()}`)
  await rm(pendingPath, { force: true }).catch(() => {})
  return true
}
function field(markdown = '', name = '') {
  return String(markdown).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.replace(/\s+#.*$/, '').trim() || ''
}
function safeSegment(value = '', fallback = 'unknown') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
}
async function ensureSafeCapDirectory(repo, target) {
  const absoluteRepo = resolve(repo)
  const canonicalRepo = await realpath(repo)
  const absoluteTarget = resolve(target)
  const repoRelative = relative(absoluteRepo, absoluteTarget)
  if (!repoRelative || repoRelative === '..' || repoRelative.startsWith(`..${sep}`) || resolve(absoluteRepo, repoRelative) !== absoluteTarget) {
    throw new Error(`unsafe_cap_state_path: ${absoluteTarget}`)
  }
  let current = canonicalRepo
  for (const segment of repoRelative.split(sep).filter(Boolean)) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(current)
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe_cap_state_path: ${current}`)
    const canonicalCurrent = await realpath(current)
    if (canonicalCurrent !== canonicalRepo && !canonicalCurrent.startsWith(`${canonicalRepo}${sep}`)) {
      throw new Error(`unsafe_cap_state_path: ${current}`)
    }
  }
}

async function writeSyncedTemporaryFile(path, contents) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    return temporaryPath
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

async function publishTaskBoundary({ statePath, contextPath, stateText, contextText, beforePublish } = {}) {
  let stateTemporaryPath = ''
  let contextTemporaryPath = ''
  let contextPublished = false
  try {
    stateTemporaryPath = await writeSyncedTemporaryFile(statePath, stateText)
    contextTemporaryPath = await writeSyncedTemporaryFile(contextPath, contextText)
    if (beforePublish) await beforePublish()
    await rename(contextTemporaryPath, contextPath)
    contextTemporaryPath = ''
    contextPublished = true
    await rename(stateTemporaryPath, statePath)
    stateTemporaryPath = ''
  } catch (error) {
    if (contextPublished) await rm(contextPath, { force: true }).catch(() => {})
    throw error
  } finally {
    if (stateTemporaryPath) await rm(stateTemporaryPath, { force: true }).catch(() => {})
    if (contextTemporaryPath) await rm(contextTemporaryPath, { force: true }).catch(() => {})
  }
}

async function switchTaskStateLocked({ repoRoot = '.', taskId, sessionId, expectedOldTaskId = '', title = '新研发任务', intentSummary = '', stage = 'understand', environment = {}, sessionRootRegistry = '', migrateTrackedActive = false, beforeTrackedIndexReplace, replaceTrackedIndex, beforeTaskBoundaryPublish } = {}) {
  if (!taskId || !sessionId) throw new Error('taskId and sessionId are required')
  const repo = resolve(repoRoot)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  if (await realpath(gitRoot) !== await realpath(repo)) throw new Error(`repoRoot must be the Git root: ${gitRoot}`)
  const sessionRoot = await inspectSessionRoot({ repoRoot: gitRoot, environment, registryRoot: sessionRootRegistry, capture: false, requireExisting: Boolean(Object.keys(environment).length) })
  if (sessionRoot.blocked) throw new Error(`${sessionRoot.code}: expected ${sessionRoot.expectedRoot || 'captured session root'}, received ${sessionRoot.currentRoot}`)
  const capRoot = join(repo, '.cap')
  await ensureSafeCapDirectory(repo, capRoot)
  const statePath = join(capRoot, 'STATE.md')
  const oldState = await readFile(statePath, 'utf8').catch(() => '')
  const oldContext = await readFile(join(capRoot, 'task-context.md'), 'utf8').catch(() => '')
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

  const fingerprint = createHash('sha256').update(`${oldState}\n${branch}\n${gitRoot}`).digest('hex').slice(0, 12)
  let snapshotRoot = join(capRoot, 'local-state', 'stale', safeSegment(oldTaskId), fingerprint)
  if (!oldState) {
    // With no active STATE there is no prior task identity to disambiguate a
    // repeated boundary. Keep each snapshot rather than treating the same
    // empty-state fingerprint as a collision.
    snapshotRoot = join(capRoot, 'local-state', 'stale', safeSegment(oldTaskId), `${fingerprint}-${randomUUID()}`)
  } else if (await exists(snapshotRoot)) {
    const snapshotEntries = await readdir(snapshotRoot)
    if (snapshotEntries.length === 0) await rm(snapshotRoot, { recursive: true, force: true })
    else throw new Error(`stale snapshot already exists: ${snapshotRoot}`)
  }
  await ensureSafeCapDirectory(repo, dirname(snapshotRoot))
  const pendingPath = join(capRoot, 'local-state', 'locks', 'task-switch.pending.json')
  const pendingText = JSON.stringify({ schemaVersion: 1, taskId, oldTaskId, fingerprint, oldState, oldContext, snapshotRoot, createdAt: new Date().toISOString() }) + '\n'
  if (Buffer.byteLength(pendingText, 'utf8') > RECOVERY_FILE_MAX_BYTES) {
    throw new Error('task_switch_pending_invalid: boundary journal exceeds the recovery size limit')
  }
  const pendingTemporaryPath = await writeSyncedTemporaryFile(pendingPath, pendingText)
  await rename(pendingTemporaryPath, pendingPath)
  await ensureSafeCapDirectory(repo, snapshotRoot)

  const moved = []
  let newStateStarted = false
  let newContextStarted = false
  let taskBaseline = null
  let outboxArchive = { archived: 0, pending: 0, totalBefore: 0, archivePath: '', retainedHistoricalPending: 0 }
  try {
    if (tracked.length) trackedMigration = await prepareTrackedActiveMigration(repo, tracked)
    taskBaseline = await captureTaskBaseline(repo, taskId)
    await ensureSafeCapDirectory(repo, snapshotRoot)
    for (const name of ACTIVE_PATHS) {
      const source = join(capRoot, name)
      if (!await exists(source)) continue
      const destination = join(snapshotRoot, name)
      await rename(source, destination)
      moved.push({ source, destination })
    }
    await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, oldTaskId, oldSessionId: field(oldState, 'session-id'), oldBranch: field(oldState, 'branch'), currentBranch: branch, currentWorktree: gitRoot, fingerprint, knowledgeDisposition: 'needs-harvest', moved: moved.map(item => item.source.slice(capRoot.length + 1)) }, null, 2)}\n`)
    const contextPath = join(capRoot, 'task-context.md')
    const stateText = `# Cap State: ${title}\n\nstage: ${stage}\nstatus: in-progress\nexecution-required: true\ntask-id: ${taskId}\nsession-id: ${sessionId}\nbranch: ${branch}\nbranch-purpose: feature/${safeSegment(title, 'task')}\nbase-commit: ${head}\nworktree: ${gitRoot}\nupdated: pending\n\n## Gates passed\n- [ ] context：task-context.md 已基于当前任务与代码 HEAD 刷新\n- [x] git：旧任务状态已安全隔离，当前分支与本 Task 绑定\n\n## Decisions log\n- 旧活动状态已保存到 .cap/local-state/stale/${safeSegment(oldTaskId)}/${fingerprint}，未修改业务源码。\n\n## Next action\n-> refresh task-context before implementation\n`
    const contextText = `# Task Context\n\n- intent: ${intentSummary || title}\n- branch: ${branch}\n- head: ${head}\n- status: pending-reconnaissance\n\n当前文件仅完成 Task 边界切换；进入需求确认、计划或编码前必须重新执行任务级代码侦察。\n`
    await publishTaskBoundary({ statePath, contextPath, stateText, contextText, beforePublish: beforeTaskBoundaryPublish })
    newStateStarted = true
    newContextStarted = true
    if (trackedMigration) await commitTrackedActiveMigration(trackedMigration, {
      beforeReplace: beforeTrackedIndexReplace,
      replace: replaceTrackedIndex,
    })
  } catch (error) {
    if (newStateStarted) await rm(statePath, { force: true }).catch(() => {})
    if (newContextStarted) await rm(join(capRoot, 'task-context.md'), { force: true }).catch(() => {})
    for (const item of moved.reverse()) await rename(item.destination, item.source).catch(() => {})
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
    await rm(pendingPath, { force: true }).catch(() => {})
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

export async function switchTaskState(options = {}) {
  const { repoRoot = '.', taskId, sessionId, environment = {}, sessionRootRegistry = '', afterTaskSwitchLock } = options
  if (!taskId || !sessionId) throw new Error('taskId and sessionId are required')
  const repo = resolve(repoRoot)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  if (await realpath(gitRoot) !== await realpath(repo)) throw new Error(`repoRoot must be the Git root: ${gitRoot}`)
  const sessionRoot = await inspectSessionRoot({ repoRoot: gitRoot, environment, registryRoot: sessionRootRegistry, capture: false, requireExisting: Boolean(Object.keys(environment).length) })
  if (sessionRoot.blocked) throw new Error(`${sessionRoot.code}: expected ${sessionRoot.expectedRoot || 'captured session root'}, received ${sessionRoot.currentRoot}`)

  const capRoot = join(repo, '.cap')
  const locksRoot = join(capRoot, 'local-state', 'locks')
  await ensureSafeCapDirectory(repo, locksRoot)
  const statePath = join(capRoot, 'STATE.md')
  const observedState = await readFile(statePath, 'utf8').catch(() => '')
  const lockPath = join(locksRoot, 'task-switch.lock')
  const pendingPath = join(locksRoot, 'task-switch.pending.json')
  let lock
  let lockIdentity
  let reclaimed = false
  try {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        if (await reclaimDeadTaskSwitchLock(lockPath)) {
          reclaimed = true
          lock = await open(lockPath, 'wx', 0o600)
        } else {
          throw new Error('task_switch_in_progress: another Task boundary switch owns the operation lock')
        }
      } else {
        throw error
      }
    }
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, taskId, sessionId, createdAt: new Date().toISOString() })}\n`, 'utf8')
    await lock.sync()
    lockIdentity = await lock.stat()
    const recoveredBoundary = await recoverPendingTaskSwitch(repo)
    const expectedState = recoveredBoundary ? await readFile(statePath, 'utf8').catch(() => '') : observedState
    if (afterTaskSwitchLock) await afterTaskSwitchLock()
    const lockedState = await readFile(statePath, 'utf8').catch(() => '')
    if (lockedState !== expectedState) throw new Error('task_switch_state_changed: active STATE changed while acquiring the Task switch lock')
    const result = await switchTaskStateLocked(options)
    await rm(pendingPath, { force: true }).catch(() => {})
    return result
  } finally {
    await lock?.close().catch(() => {})
    if (lockIdentity) {
      const currentIdentity = await lstat(lockPath).catch(() => null)
      if (currentIdentity && currentIdentity.dev === lockIdentity.dev && currentIdentity.ino === lockIdentity.ino) {
        await rm(lockPath, { force: true }).catch(() => {})
      }
    }
  }
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
