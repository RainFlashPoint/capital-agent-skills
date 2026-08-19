#!/usr/bin/env node

import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPlatformHandshake, normalizeServerUrl } from './setup-lib.mjs'
import { flushPendingDeliveries, readHarnessMode, sanitizeRepositoryUrl } from './client-delivery.mjs'
import { inspectOutbox } from './cap-outbox.mjs'
import { activateLocalFallback, isLocalFallbackActive } from './local-fallback.mjs'

const STAGES = ['understand', 'define', 'plan', 'implement', 'test', 'review', 'release', 'done']
const LEGACY_STAGE = { map: 'understand', shape: 'define', build: 'implement', verify: 'test' }

function text(value = '') { return String(value || '').trim() }
function normalizeMcpRuntime(value = '') {
  const normalized = text(value).toLowerCase()
  return ['loaded', 'missing'].includes(normalized) ? normalized : 'unknown'
}
function canonicalStage(value = '') {
  const normalized = text(value).replace(/^cap-/, '').toLowerCase()
  return LEGACY_STAGE[normalized] || (STAGES.includes(normalized) ? normalized : '')
}
function field(markdown = '', name = '') {
  const match = String(markdown).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))
  return text(match?.[1]).replace(/\s+#.*$/, '').trim()
}
function checked(markdown = '', keyword = '') {
  return String(markdown).split(/\r?\n/).some(line => /^\s*-\s*\[x\]/i.test(line) && line.toLowerCase().includes(keyword.toLowerCase()))
}
function nextFromState(markdown = '') {
  const section = String(markdown).split(/^##\s+Next action\s*$/mi)[1] || ''
  const match = section.match(/->\s*(?:invoke\s+)?(?:cap-)?([a-z-]+)/i)
  return canonicalStage(match?.[1])
}
async function exists(path = '') { try { return (await stat(path)).isFile() } catch { return false } }
function git(repo, args) { try { return text(execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) } catch { return '' } }
function gitSucceeds(repo, args) { try { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); return true } catch { return false } }
async function fetchPlatformTask(serverUrl, userKey, taskId, fetchImpl) {
  if (!serverUrl || !userKey || !taskId) return null
  try {
    const response = await fetchImpl(`${serverUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers: { 'x-user-key': userKey } })
    if (!response.ok) return null
    const body = await response.json()
    return body.data || null
  } catch { return null }
}

async function fetchPlatformHealth(serverUrl, fetchImpl) {
  if (!serverUrl) return null
  try {
    const response = await fetchImpl(`${serverUrl}/api/health`)
    if (!response.ok) return await response.json().catch(() => null)
    return await response.json()
  } catch { return null }
}

function activeFollowUpId(task = {}) {
  if (task?.status !== 'done') return ''
  const nextId = text(task?.nextAction?.taskId)
  if (nextId) return nextId
  const related = Array.isArray(task?.relatedTasks) ? task.relatedTasks : []
  return text(related.find(item => item?.relationType === 'follow_up' && item?.status !== 'done')?.id)
}

function hasCandidateTestAction(task = {}) {
  const candidateExplicit = task?.candidateExplicit === true || task?.gates?.candidateExplicit === true
  const currentCommit = text(task?.currentCommit || task?.gates?.currentCommit)
  const actionType = text(task?.currentAction?.type || task?.currentAction?.actionType).toLowerCase()
  const actionCommit = text(task?.currentAction?.sourceCommit || task?.currentAction?.commitSha)
  return candidateExplicit && Boolean(currentCommit) && ['test', 'verify'].includes(actionType) && actionCommit === currentCommit
}

function canonicalWorkflowStage(task = {}, fallbackStage = '') {
  const stage = canonicalStage(task?.currentStage) || canonicalStage(fallbackStage) || 'test'
  const executionMode = text(task?.executionMode || task?.taskContract?.executionMode)
  if (executionMode === 'verify_only') return 'test'
  return stage === 'test' && !hasCandidateTestAction(task) ? 'implement' : stage
}

function localStatusFromRemote(status = '') {
  const normalized = text(status).toLowerCase()
  if (normalized === 'done') return 'done'
  if (normalized === 'needs_human') return 'gated'
  if (['failed', 'canceled', 'cancelled'].includes(normalized)) return 'blocked'
  return 'in-progress'
}

async function persistCanonicalCursor(statePath, stateText, task = {}, effectiveStage = '') {
  if (!stateText || !task?.id || !effectiveStage) return false
  let next = stateText
  const replaceField = (name, value) => {
    const pattern = new RegExp(`^${name}:\\s*.*$`, 'mi')
    next = pattern.test(next) ? next.replace(pattern, `${name}: ${value}`) : next
  }
  replaceField('stage', effectiveStage)
  replaceField('status', localStatusFromRemote(task.status))
  if (next === stateText) return false
  if (await readFile(statePath, 'utf8').catch(() => '') !== stateText) return false
  const temp = `${statePath}.${process.pid}.${randomUUID()}.canonical.tmp`
  try {
    await writeFile(temp, next)
    await rename(temp, statePath)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
  return true
}

function nextFromPlatformTask(task = {}, fallback = {}) {
  const action = task?.nextAction || {}
  const executionMode = text(task?.executionMode || task?.taskContract?.executionMode)
  const projectedStage = executionMode === 'verify_only' ? 'test' : canonicalStage(task?.currentStage) || fallback.stage || 'test'
  const stage = canonicalWorkflowStage(task, projectedStage)
  if (task?.blocker?.remediation) {
    return { stage, action: text(task.blocker.remediation), reason: `${text(task.blocker.code) || 'platform_blocker'}：${text(task.blocker.detail) || '平台返回结构化阻塞'}`, blocker: task.blocker }
  }
  if (projectedStage === 'test' && stage === 'implement') {
    return { stage, action: '形成最终候选 Commit', reason: '平台尚未同时确认 delivery_candidate=true 与 Test Action，不能称为正在测试验证' }
  }
  if (action.kind === 'action' && action.actionId) {
    const actionStage = action.actionType === 'review' ? 'review' : action.actionType === 'verify' ? 'test' : stage
    return { stage: actionStage, action: text(action.label) || '认领平台待执行动作', reason: `平台 Action ${text(action.actionStatus) || 'ready'}`, platformAction: action }
  }
  if (action.kind === 'gate' && action.label) {
    return { stage, action: text(action.label), reason: `平台 follow-up Task 等待 ${text(action.gate) || '下一门禁'}` }
  }
  return fallback
}

export function reconcileRepositoryState({ head = '', upstreamHead = '', deliveredHead = '', stateHead = '', commits = [] } = {}) {
  const recordedHead = deliveredHead || stateHead
  const headPushed = Boolean(head && upstreamHead && head === upstreamHead)
  const pushRequired = Boolean(head && (!upstreamHead || head !== upstreamHead))
  const localUnrecorded = Boolean(head && recordedHead && head !== recordedHead)
  const remoteUnrecorded = Boolean(upstreamHead && recordedHead && upstreamHead !== recordedHead)
  const initialDeliveryNeeded = Boolean(head && !recordedHead)
  return {
    recordedHead,
    headPushed,
    pushRequired,
    initialDeliveryNeeded,
    localUnrecorded,
    remoteUnrecorded,
    needsDeliveryReconciliation: initialDeliveryNeeded || localUnrecorded || remoteUnrecorded,
    unrecordedCommits: localUnrecorded || initialDeliveryNeeded ? commits : [],
  }
}

export function inspectTaskBoundary({ stateText = '', branch = '', worktree = '' } = {}) {
  if (!stateText) return { blocked: false, code: '', mismatches: [], state: {}, current: { branch: text(branch), worktree: text(worktree) } }
  const stateBranch = field(stateText, 'branch')
  const stateWorktree = field(stateText, 'worktree')
  const usable = value => value && value !== '(none)' && !value.startsWith('<')
  const mismatches = []
  if (usable(stateBranch) && branch && stateBranch !== branch) mismatches.push('branch')
  const canonicalPath = value => { try { return realpathSync.native(resolve(value)) } catch { return resolve(value) } }
  if (usable(stateWorktree) && worktree && canonicalPath(stateWorktree) !== canonicalPath(worktree)) mismatches.push('worktree')
  const blocked = mismatches.length > 0
  return {
    blocked,
    code: blocked ? `task_state_${mismatches.join('_and_')}_mismatch` : '',
    mismatches,
    state: { taskId: field(stateText, 'task-id'), sessionId: field(stateText, 'session-id'), branch: stateBranch, worktree: stateWorktree },
    current: { branch: text(branch), worktree: text(worktree) },
    detail: blocked ? `活动 STATE 属于 ${mismatches.join('、')} 边界之外的旧任务` : '',
    remediation: blocked ? '先安全保存旧 .cap 活动态并为本次 Task 初始化新 STATE；完成前禁止需求确认、计划、编码、测试或评审' : '',
  }
}

export function resolveNextAction({ stateText = '', artifacts = {}, dirty = false, allowStateGate = true } = {}) {
  if (!stateText) {
    return artifacts.profile
      ? { stage: 'define', action: '需求确认', reason: '尚无任务 STATE，已有项目画像' }
      : { stage: 'understand', action: '项目了解', reason: '尚无任务 STATE 与项目画像' }
  }

  const stage = canonicalStage(field(stateText, 'stage')) || 'understand'
  const status = field(stateText, 'status').toLowerCase() || 'in-progress'
  const deferredOnly = field(stateText, 'deferred-only').toLowerCase() === 'true'
  const declared = nextFromState(stateText)
  if ((status === 'blocked' || status === 'gated') && !deferredOnly) {
    return { stage, action: '解除当前门禁', reason: `${stage} 状态为 ${status}`, gated: true, declaredNext: declared }
  }
  if (deferredOnly && declared && declared !== stage) return { stage: declared, action: stageLabel(declared), reason: '核心验收已通过，延期项将拆成 follow-up Task', deferredOnly: true }
  if (declared && declared !== stage) return { stage: declared, action: stageLabel(declared), reason: '采用 STATE 中已声明的下一动作' }

  switch (stage) {
    case 'understand':
      return artifacts.profile || checked(stateText, 'understand') ? { stage: 'define', action: '需求确认', reason: '项目画像已存在' } : { stage, action: '项目了解', reason: '仍缺项目画像' }
    case 'define':
      return artifacts.spec && checked(stateText, 'define') ? { stage: 'plan', action: '开发计划', reason: '规格已获批' } : { stage, action: '需求确认', reason: '规格尚未获批' }
    case 'plan':
      return artifacts.plan && checked(stateText, 'plan') ? { stage: 'implement', action: '编码实现', reason: '计划已就绪' } : { stage, action: '开发计划', reason: '计划尚未达到出口' }
    case 'implement':
      return checked(stateText, 'implementation (green)') || dirty ? { stage: 'test', action: '测试验证', reason: dirty ? '检测到代码改动' : '实现门已通过' } : { stage, action: '编码实现', reason: '尚无完成实现的证据' }
    case 'test':
      if (!allowStateGate) return { stage: 'test', action: '等待 Server Test Action', reason: '团队模式只接受绑定精确 Commit 的 Server Action 证据', gated: true }
      return checked(stateText, 'test：logic') || checked(stateText, 'test: logic') ? { stage: 'review', action: '代码评审', reason: '基础验证已通过' } : { stage, action: '测试验证', reason: '仍需形成通过的验证证据' }
    case 'review':
      if (!allowStateGate) return { stage: 'review', action: '等待 Server Review Action', reason: '团队模式只接受绑定精确 Commit 的 Server Action 证据', gated: true }
      return /cap-gate:\s*pass/i.test(stateText) || checked(stateText, 'review') ? { stage: 'release', action: '交付收口', reason: '评审门已通过' } : { stage, action: '代码评审', reason: '评审门尚未通过' }
    case 'release': return { stage: 'done', action: '完成退场', reason: '进入交付收口' }
    case 'done': return { stage: 'done', action: '归档并沉淀经验', reason: '任务已完成' }
    default: return { stage: 'understand', action: '项目了解', reason: '无法识别当前阶段' }
  }
}

export function stageLabel(stage = '') {
  return ({ understand: '项目了解', define: '需求确认', plan: '开发计划', implement: '编码实现', test: '测试验证', review: '代码评审', release: '交付收口', done: '完成退场' })[stage] || '项目了解'
}

export async function inspectCapStatus({ repoRoot = '.', homeDir = homedir(), fetchImpl = fetch, offline = false, environment = {}, mcpRuntime = 'unknown', allowLocalFallback = false } = {}) {
  const repo = resolve(repoRoot)
  const configPath = join(homeDir, '.config/capital-agent/env')
  const configText = await readFile(configPath, 'utf8').catch(() => '')
  const config = Object.fromEntries(configText.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
  const explicitLocal = text(environment.CAPITAL_AGENT_MODE || config.CAPITAL_AGENT_MODE).toLowerCase() === 'local'
  const mcpRuntimeState = normalizeMcpRuntime(mcpRuntime)
  let serverUrl = ''
  try { serverUrl = normalizeServerUrl(config.CAPITAL_AGENT_SERVER_URL || '') } catch {}
  const userKey = text(config.CAPITAL_AGENT_USER_KEY)
  const teamConfigured = !explicitLocal && Boolean(serverUrl && userKey)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstreamHead = upstream ? git(repo, ['rev-parse', upstream]) : ''
  const remote = sanitizeRepositoryUrl(git(repo, ['remote', 'get-url', 'origin']))
  const dirty = Boolean(git(repo, ['status', '--porcelain']))
  const statePath = join(repo, '.cap/STATE.md')
  const stateText = await readFile(statePath, 'utf8').catch(() => '')
  const harnessMode = await readHarnessMode(repo)
  const boundary = inspectTaskBoundary({ stateText, branch, worktree: gitRoot || repo })
  const taskId = field(stateText, 'task-id')
  const sessionId = field(stateText, 'session-id')
  if (teamConfigured && mcpRuntimeState === 'missing' && allowLocalFallback === true) {
    await activateLocalFallback(repo, { branch, taskId })
  }
  const explicitLocalFallback = teamConfigured && mcpRuntimeState === 'missing' && await isLocalFallbackActive(repo, { branch, taskId })
  const localRun = explicitLocal || explicitLocalFallback
  const restartRequired = teamConfigured && mcpRuntimeState === 'missing' && !explicitLocalFallback
  const parentTaskId = field(stateText, 'parent-task-id')
  const retirementStatus = field(stateText, 'retirement-status') || (stateText ? 'active' : '')
  const historyArtifactRoot = field(stateText, 'history-artifact-root') || (taskId && await exists(join(repo, `.cap/history/${taskId}/manifest.json`)) ? `.cap/history/${taskId}` : '')
  const artifacts = {
    profile: await exists(join(repo, '.cap/PROFILE.md')),
    spec: await exists(join(repo, '.cap/spec.md')),
    plan: await exists(join(repo, '.cap/plan.md')),
  }
  const handshake = offline || localRun || restartRequired ? null : (serverUrl && userKey ? await checkPlatformHandshake(serverUrl, userKey, fetchImpl) : null)
  const platform = offline || restartRequired || handshake?.reason === 'direct_probe_unavailable' ? null : Boolean(handshake?.ok)
  const stateTask = platform && !boundary.blocked ? await fetchPlatformTask(serverUrl, userKey, taskId, fetchImpl) : null
  const runtime = platform ? await fetchPlatformHealth(serverUrl, fetchImpl) : null
  const followUpTaskId = activeFollowUpId(stateTask)
  const followUpTask = followUpTaskId ? await fetchPlatformTask(serverUrl, userKey, followUpTaskId, fetchImpl) : null
  const remoteTask = followUpTask?.status && followUpTask.status !== 'done' ? followUpTask : stateTask
  const switchingTask = Boolean(remoteTask?.id && taskId && remoteTask.id !== taskId)
  const pendingDeliveries = gitRoot && taskId && !offline && !localRun && !restartRequired && !boundary.blocked ? await flushPendingDeliveries(repo, { activeTaskRef: taskId, canonicalTask: stateTask, fetchImpl, homeDir }).catch(() => ({ total: 0, sent: 0, pending: 0 })) : { total: 0, sent: 0, pending: 0 }
  const emptyOutbox = { totalPending: 0, pending: 0, historicalPending: 0, retainedHistoricalPending: 0, unscopedPending: 0, retainedUnscopedPending: 0, ready: 0, blocked: 0, oldestCreatedAt: '', next: null, events: [] }
  const outbox = gitRoot && !localRun ? await inspectOutbox(repo, { activeTaskRef: taskId }).catch(() => emptyOutbox) : emptyOutbox
  const localNext = resolveNextAction({ stateText, artifacts, dirty, allowStateGate: localRun || harnessMode === 'local-only' })
  const guardedLocalNext = !remoteTask && teamConfigured && !localRun && localNext.stage === 'test'
    ? { stage: 'implement', action: '通过 MCP 确认最终候选与 Test Action', reason: '尚未取得 Server canonical projection，不能称为正在测试验证', gated: true }
    : localNext
  const localStage = canonicalStage(field(stateText, 'stage'))
  const remoteWorkflowStage = remoteTask ? canonicalWorkflowStage(remoteTask, localStage) : ''
  const next = switchingTask
    ? nextFromPlatformTask(remoteTask, guardedLocalNext)
    : remoteTask?.status === 'done'
    ? { stage: 'done', action: '归档并沉淀经验', reason: '平台 Task 的同 Commit 交付门禁已全部通过' }
    : nextFromPlatformTask(remoteTask, guardedLocalNext)
  const followUpBaseCommit = switchingTask ? text(remoteTask?.baseCommit || remoteTask?.taskContract?.baseCommit) : ''
  const deliveredHead = followUpBaseCommit || field(stateText, 'delivery-head')
  const stateHead = field(stateText, 'head') || field(stateText, 'task-context').match(/@\s*([0-9a-f]{7,40})/i)?.[1] || ''
  const compareBase = deliveredHead || stateHead
  const commits = compareBase && gitSucceeds(repo, ['cat-file', '-e', `${compareBase}^{commit}`])
    ? git(repo, ['log', '--format=%H%x09%s', `${compareBase}..${head}`]).split(/\r?\n/).filter(Boolean)
    : head ? [git(repo, ['log', '-1', '--format=%H%x09%s', head])].filter(Boolean) : []
  const reconciliation = reconcileRepositoryState({ head, upstreamHead, deliveredHead, stateHead, commits })
  const reasons = []
  if (restartRequired) reasons.push('mcp_runtime_missing_restart_required')
  else if (boundary.blocked) reasons.push(boundary.code)
  else if (!localRun) {
    if (!gitRoot) reasons.push('not_git_repository')
    if (!serverUrl) reasons.push('missing_server_url')
    if (!userKey) reasons.push('missing_user_key')
    if (!offline && serverUrl && userKey && handshake?.reason === 'direct_probe_unavailable') reasons.push('direct_probe_unavailable_needs_mcp_confirmation')
    else if (!offline && serverUrl && userKey && platform === false) reasons.push('platform_handshake_rejected_needs_mcp_confirmation')
    if (!taskId) reasons.push('task_not_attached')
    if (reconciliation.needsDeliveryReconciliation) reasons.push('git_delivery_reconciliation_needed')
  }
  const correction = remoteTask && (remoteWorkflowStage !== localStage || localStatusFromRemote(remoteTask.status) !== field(stateText, 'status').toLowerCase())
    ? { required: true, reason: 'server_canonical_state_overrides_local_state', localStage, remoteStage: remoteWorkflowStage, remoteStatus: remoteTask.status }
    : { required: false, reason: '' }
  if (correction.required && !boundary.blocked) await persistCanonicalCursor(statePath, stateText, remoteTask, remoteWorkflowStage).catch(() => false)
  return {
    mode: explicitLocal
      ? 'local_explicit'
      : restartRequired
      ? 'restart_required'
      : boundary.blocked
      ? 'boundary_blocked'
      : explicitLocalFallback
      ? 'local_fallback_explicit'
      : !gitRoot || !serverUrl || !userKey
      ? 'local_degraded'
      : platform === true
        ? taskId ? 'platform_attached' : 'platform_ready'
        : taskId ? 'platform_attached_unverified' : 'platform_unverified',
    platform: { configured: teamConfigured, connected: localRun ? null : platform, serverUrl: explicitLocal ? '' : serverUrl || '', handshake, mcpRuntime: mcpRuntimeState, localFallback: explicitLocalFallback, runtime: runtime ? { buildCommit: runtime.build?.commit || '', schemaRevision: runtime.schemaRevision || '', taskStoreMode: runtime.taskStoreMode || '', database: runtime.database || '' } : null, pendingDeliveries, outbox },
    repository: { root: gitRoot || repo, remote, branch, head, upstream, upstreamHead, dirty, harnessMode, harnessEligible: harnessMode === 'server' },
    task: {
      id: remoteTask?.id || taskId,
      previousId: switchingTask ? taskId : '',
      sessionId: switchingTask ? '' : sessionId,
      previousSessionId: switchingTask ? sessionId : '',
      requiresNewSession: switchingTask,
      remoteStatus: remoteTask?.status || '',
      remoteStage: remoteTask?.currentStage || '',
      gatesReady: remoteTask?.gates?.ready === true,
      currentCommit: remoteTask?.currentCommit || remoteTask?.gates?.currentCommit || '',
      currentGate: remoteTask?.currentGate || remoteTask?.gates?.current || '',
      currentAction: remoteTask?.currentAction || null,
      blocker: restartRequired
        ? { code: 'mcp_runtime_missing_restart_required', detail: 'Capital Agent 已配置，但当前会话没有加载 MCP 工具', remediation: '选择重启恢复团队模式，或明确本次改用本地模式继续' }
        : boundary.blocked ? { code: boundary.code, detail: boundary.detail, remediation: boundary.remediation } : remoteTask?.blocker || null,
      nextAction: remoteTask?.nextAction || null,
      executionMode: remoteTask?.executionMode || remoteTask?.taskContract?.executionMode || '',
      verificationCommands: remoteTask?.verificationCommands || remoteTask?.taskContract?.verificationCommands || [],
      parentTaskId: remoteTask?.parentTaskId || parentTaskId,
      retirementStatus: remoteTask?.status === 'done' && !historyArtifactRoot ? 'pending' : historyArtifactRoot ? 'snapshotted' : retirementStatus,
      historyArtifactRoot,
    },
    reconciliation,
    boundary,
    correction,
    workflow: restartRequired
      ? { currentStage: localStage, status: 'gated', stage: localStage || 'understand', action: '选择：重启恢复团队模式，或本次明确改用本地模式继续', reason: '当前会话未加载已配置的 Capital Agent MCP；不会静默丢失团队证据，也不会强制中断本地研发', gated: true, options: [
          { id: 'restart', label: '重启后使用团队模式' },
          { id: 'local_once', label: '本次明确改用本地模式继续' },
        ] }
      : boundary.blocked
      ? { currentStage: canonicalStage(field(stateText, 'stage')), status: 'blocked', stage: canonicalStage(field(stateText, 'stage')) || 'understand', action: '安全切换本次 Task 状态', reason: boundary.detail, gated: true }
      : { currentStage: remoteWorkflowStage || next.stage || canonicalStage(field(stateText, 'stage')), status: remoteTask?.status || field(stateText, 'status'), ...next },
    reasons,
  }
}

function render(result) {
  const explicitLocal = result.mode === 'local_explicit'
  const explicitLocalFallback = result.mode === 'local_fallback_explicit'
  const localRun = explicitLocal || explicitLocalFallback
  const restartRequired = result.mode === 'restart_required'
  const connected = explicitLocal ? '本地模式主动跳过' : explicitLocalFallback ? '本次已明确改用本地模式（团队配置保持不变）' : restartRequired ? '已配置，当前会话未加载 MCP' : result.platform.connected === true ? '已连接' : result.platform.handshake?.reason === 'direct_probe_unavailable' ? '直接探测不可用，等待 MCP 确认' : result.platform.connected === false ? '握手未通过，等待 MCP 确认' : result.platform.configured ? '未探测' : '未配置'
  const task = result.task.id || (result.mode === 'platform_ready' ? '待创建' : '未关联')
  return [
    'CAP CLIENT HANDSHAKE',
    `模式：${result.mode}`,
    `平台：${connected}`,
    `仓库：${result.repository.remote || result.repository.root}`,
    `分支：${result.repository.branch || '-'}`,
    `验证模式：${result.repository.harnessMode === 'local-only' ? '本地维护验证（不进入 Server Harness）' : 'Server Harness'}`,
    `Task：${task}`,
    restartRequired ? '当前状态：等待选择运行方式' : '',
    restartRequired ? '代码修改：尚未开始' : '',
    restartRequired ? '现有分支和工作区改动不会丢失' : '',
    restartRequired ? '选项 1（推荐）：完全退出并重新打开客户端，新建任务后使用团队模式' : '',
    restartRequired ? '选项 2：回复“本次本地继续”，本任务不创建平台 Task、不回写经验或 Server Gate' : '',
    result.boundary?.blocked ? `边界阻断：${result.boundary.code}；STATE 分支 ${result.boundary.state.branch || '-'} / 当前分支 ${result.boundary.current.branch || '-'}` : '',
    result.task.requiresNewSession ? `任务接续：${result.task.previousId} → ${result.task.id}（必须新建 Session）` : '',
    result.task.remoteStatus ? `平台 Task：${result.task.remoteStatus}${result.task.gatesReady ? ' · Gate 已通过' : ''}` : '',
    result.task.currentCommit ? `当前候选 Commit：${result.task.currentCommit.slice(0, 12)}` : '',
    result.task.currentAction?.id ? `当前 Action：${result.task.currentAction.type || '-'} · ${result.task.currentAction.status || '-'} · ${result.task.currentAction.id}` : '',
    result.task.blocker ? `${restartRequired ? '提示' : '阻塞'}：${result.task.blocker.detail || result.task.blocker.code}；处理：${result.task.blocker.remediation || '查看技术详情'}` : '',
    result.platform.runtime?.taskStoreMode ? `平台真值：${result.platform.runtime.taskStoreMode} · schema ${result.platform.runtime.schemaRevision || '-'}` : '',
    result.correction.required ? `状态纠偏：本地 ${result.correction.localStage || '-'} → 平台 ${result.correction.remoteStage || result.task.remoteStage || '-'}（${result.correction.remoteStatus}）` : '',
    result.task.parentTaskId ? `父 Task：${result.task.parentTaskId}` : '',
    result.task.retirementStatus ? `历史快照：${result.task.retirementStatus}${result.task.historyArtifactRoot ? ` · ${result.task.historyArtifactRoot}` : ''}` : '',
    restartRequired ? '' : `当前：${stageLabel(result.workflow.currentStage || result.workflow.stage)}`,
    `下一步：${result.workflow.action}`,
    `原因：${result.workflow.reason}`,
    localRun ? '证据：测试与评审结果仅保留在本地' : restartRequired ? '' : result.reconciliation.needsDeliveryReconciliation ? `交付对账：发现 ${result.reconciliation.unrecordedCommits.length || 1} 个未登记提交，需补写平台 Delivery` : '交付对账：Git 与最近 Delivery 一致',
    localRun || restartRequired ? '' : result.reconciliation.pushRequired ? `远程验证门禁：当前 HEAD ${result.repository.head.slice(0, 12)} 尚未与上游分支对齐；创建 Test/Review Action 前需要明确授权并推送当前分支` : '远程验证门禁：当前 HEAD 已在上游分支可见',
    result.platform.pendingDeliveries?.total ? `Delivery 对账：本次发送 ${result.platform.pendingDeliveries.sent}${result.platform.pendingDeliveries.confirmed ? `，确认已到账 ${result.platform.pendingDeliveries.confirmed}` : ''}，剩余 ${result.platform.pendingDeliveries.pending}` : '',
    result.platform.outbox?.pending ? `当前 Task 离线待同步：${result.platform.outbox.pending} 条（可重放 ${result.platform.outbox.ready}，阻塞 ${result.platform.outbox.blocked}）${result.platform.outbox.next ? `；下一条 ${result.platform.outbox.next.type}` : ''}` : '',
    result.platform.outbox?.historicalPending ? `历史 Outbox 已隔离：${result.platform.outbox.historicalPending} 条（不阻塞当前 Task，不会自动补报）` : '',
    result.platform.outbox?.unscopedPending ? `无 Task 归属 Outbox 已隔离：${result.platform.outbox.unscopedPending} 条（待人工归属，不会自动补报）` : '',
    result.reasons.length ? `${restartRequired ? '状态原因' : '降级原因'}：${result.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const offline = argv.includes('--offline')
  const allowLocalFallback = argv.includes('--allow-local-once')
  const runtimeFlag = argv.find(arg => arg.startsWith('--mcp-runtime='))?.split('=')[1]
  const runtimeIndex = argv.indexOf('--mcp-runtime')
  const mcpRuntime = runtimeFlag || (runtimeIndex >= 0 ? argv[runtimeIndex + 1] : 'unknown')
  let repoArg = '.'
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mcp-runtime') { index += 1; continue }
    if (!argv[index].startsWith('-')) { repoArg = argv[index]; break }
  }
  const result = await inspectCapStatus({ repoRoot: repoArg, offline, mcpRuntime, allowLocalFallback, environment: process.env })
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
}
