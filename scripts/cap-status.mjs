#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPlatformHandshake, normalizeServerUrl } from './setup-lib.mjs'
import { flushPendingDeliveries } from './client-delivery.mjs'
import { inspectOutbox } from './cap-outbox.mjs'

const STAGES = ['understand', 'define', 'plan', 'implement', 'test', 'review', 'release', 'done']
const LEGACY_STAGE = { map: 'understand', shape: 'define', build: 'implement', verify: 'test' }

function text(value = '') { return String(value || '').trim() }
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

function activeFollowUpId(task = {}) {
  if (task?.status !== 'done') return ''
  const nextId = text(task?.nextAction?.taskId)
  if (nextId) return nextId
  const related = Array.isArray(task?.relatedTasks) ? task.relatedTasks : []
  return text(related.find(item => item?.relationType === 'follow_up' && item?.status !== 'done')?.id)
}

function nextFromPlatformTask(task = {}, fallback = {}) {
  const action = task?.nextAction || {}
  const executionMode = text(task?.executionMode || task?.taskContract?.executionMode)
  const stage = executionMode === 'verify_only' ? 'test' : canonicalStage(task?.currentStage) || fallback.stage || 'test'
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

export function resolveNextAction({ stateText = '', artifacts = {}, dirty = false } = {}) {
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
      return checked(stateText, 'test：logic') || checked(stateText, 'test: logic') ? { stage: 'review', action: '代码评审', reason: '基础验证已通过' } : { stage, action: '测试验证', reason: '仍需形成通过的验证证据' }
    case 'review':
      return /cap-gate:\s*pass/i.test(stateText) || checked(stateText, 'review') ? { stage: 'release', action: '交付收口', reason: '评审门已通过' } : { stage, action: '代码评审', reason: '评审门尚未通过' }
    case 'release': return { stage: 'done', action: '完成退场', reason: '进入交付收口' }
    case 'done': return { stage: 'done', action: '归档并沉淀经验', reason: '任务已完成' }
    default: return { stage: 'understand', action: '项目了解', reason: '无法识别当前阶段' }
  }
}

export function stageLabel(stage = '') {
  return ({ understand: '项目了解', define: '需求确认', plan: '开发计划', implement: '编码实现', test: '测试验证', review: '代码评审', release: '交付收口', done: '完成退场' })[stage] || '项目了解'
}

export async function inspectCapStatus({ repoRoot = '.', homeDir = homedir(), fetchImpl = fetch, offline = false } = {}) {
  const repo = resolve(repoRoot)
  const configPath = join(homeDir, '.config/capital-agent/env')
  const configText = await readFile(configPath, 'utf8').catch(() => '')
  const config = Object.fromEntries(configText.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
  let serverUrl = ''
  try { serverUrl = normalizeServerUrl(config.CAPITAL_AGENT_SERVER_URL || '') } catch {}
  const userKey = text(config.CAPITAL_AGENT_USER_KEY)
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel'])
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstreamHead = upstream ? git(repo, ['rev-parse', upstream]) : ''
  const remote = git(repo, ['remote', 'get-url', 'origin'])
  const dirty = Boolean(git(repo, ['status', '--porcelain']))
  const statePath = join(repo, '.cap/STATE.md')
  const stateText = await readFile(statePath, 'utf8').catch(() => '')
  const taskId = field(stateText, 'task-id')
  const sessionId = field(stateText, 'session-id')
  const parentTaskId = field(stateText, 'parent-task-id')
  const retirementStatus = field(stateText, 'retirement-status') || (stateText ? 'active' : '')
  const historyArtifactRoot = field(stateText, 'history-artifact-root') || (taskId && await exists(join(repo, `.cap/history/${taskId}/manifest.json`)) ? `.cap/history/${taskId}` : '')
  const artifacts = {
    profile: await exists(join(repo, '.cap/PROFILE.md')),
    spec: await exists(join(repo, '.cap/spec.md')),
    plan: await exists(join(repo, '.cap/plan.md')),
  }
  const handshake = offline ? null : (serverUrl && userKey ? await checkPlatformHandshake(serverUrl, userKey, fetchImpl) : null)
  const platform = offline ? null : Boolean(handshake?.ok)
  const stateTask = platform ? await fetchPlatformTask(serverUrl, userKey, taskId, fetchImpl) : null
  const followUpTaskId = activeFollowUpId(stateTask)
  const followUpTask = followUpTaskId ? await fetchPlatformTask(serverUrl, userKey, followUpTaskId, fetchImpl) : null
  const remoteTask = followUpTask?.status && followUpTask.status !== 'done' ? followUpTask : stateTask
  const switchingTask = Boolean(remoteTask?.id && taskId && remoteTask.id !== taskId)
  const pendingDeliveries = gitRoot && !offline ? await flushPendingDeliveries(repo, { fetchImpl, homeDir }).catch(() => ({ total: 0, sent: 0, pending: 0 })) : { total: 0, sent: 0, pending: 0 }
  const outbox = gitRoot ? await inspectOutbox(repo).catch(() => ({ pending: 0, ready: 0, blocked: 0, oldestCreatedAt: '', next: null, events: [] })) : { pending: 0, ready: 0, blocked: 0, oldestCreatedAt: '', next: null, events: [] }
  const localNext = resolveNextAction({ stateText, artifacts, dirty })
  const next = switchingTask
    ? nextFromPlatformTask(remoteTask, localNext)
    : remoteTask?.status === 'done'
    ? { stage: 'done', action: '归档并沉淀经验', reason: '平台 Task 的同 Commit 交付门禁已全部通过' }
    : nextFromPlatformTask(remoteTask, localNext)
  const followUpBaseCommit = switchingTask ? text(remoteTask?.baseCommit || remoteTask?.taskContract?.baseCommit) : ''
  const deliveredHead = followUpBaseCommit || field(stateText, 'delivery-head')
  const stateHead = field(stateText, 'head') || field(stateText, 'task-context').match(/@\s*([0-9a-f]{7,40})/i)?.[1] || ''
  const compareBase = deliveredHead || stateHead
  const commits = compareBase && gitSucceeds(repo, ['cat-file', '-e', `${compareBase}^{commit}`])
    ? git(repo, ['log', '--format=%H%x09%s', `${compareBase}..${head}`]).split(/\r?\n/).filter(Boolean)
    : head ? [git(repo, ['log', '-1', '--format=%H%x09%s', head])].filter(Boolean) : []
  const reconciliation = reconcileRepositoryState({ head, upstreamHead, deliveredHead, stateHead, commits })
  const reasons = []
  if (!gitRoot) reasons.push('not_git_repository')
  if (!serverUrl) reasons.push('missing_server_url')
  if (!userKey) reasons.push('missing_user_key')
  if (!offline && serverUrl && userKey && platform === false) reasons.push('platform_probe_failed_needs_mcp_confirmation')
  if (!taskId) reasons.push('task_not_attached')
  if (reconciliation.needsDeliveryReconciliation) reasons.push('git_delivery_reconciliation_needed')
  return {
    mode: !gitRoot || !serverUrl || !userKey
      ? 'local_degraded'
      : platform === true
        ? taskId ? 'platform_attached' : 'platform_ready'
        : taskId ? 'platform_attached_unverified' : 'platform_unverified',
    platform: { configured: Boolean(serverUrl && userKey), connected: platform, serverUrl: serverUrl || '', handshake, pendingDeliveries, outbox },
    repository: { root: gitRoot || repo, remote, branch, head, upstream, upstreamHead, dirty },
    task: {
      id: remoteTask?.id || taskId,
      previousId: switchingTask ? taskId : '',
      sessionId: switchingTask ? '' : sessionId,
      previousSessionId: switchingTask ? sessionId : '',
      requiresNewSession: switchingTask,
      remoteStatus: remoteTask?.status || '',
      remoteStage: remoteTask?.currentStage || '',
      gatesReady: remoteTask?.gates?.ready === true,
      nextAction: remoteTask?.nextAction || null,
      executionMode: remoteTask?.executionMode || remoteTask?.taskContract?.executionMode || '',
      verificationCommands: remoteTask?.verificationCommands || remoteTask?.taskContract?.verificationCommands || [],
      parentTaskId: remoteTask?.parentTaskId || parentTaskId,
      retirementStatus: remoteTask?.status === 'done' && !historyArtifactRoot ? 'pending' : historyArtifactRoot ? 'snapshotted' : retirementStatus,
      historyArtifactRoot,
    },
    reconciliation,
    workflow: { currentStage: canonicalStage(field(stateText, 'stage')), status: field(stateText, 'status'), ...next },
    reasons,
  }
}

function render(result) {
  const connected = result.platform.connected === true ? '已连接' : result.platform.connected === false ? '待 MCP 确认' : result.platform.configured ? '未探测' : '未配置'
  const task = result.task.id || (result.mode === 'platform_ready' ? '待创建' : '未关联')
  return [
    'CAP CLIENT HANDSHAKE',
    `模式：${result.mode}`,
    `平台：${connected}`,
    `仓库：${result.repository.remote || result.repository.root}`,
    `分支：${result.repository.branch || '-'}`,
    `Task：${task}`,
    result.task.requiresNewSession ? `任务接续：${result.task.previousId} → ${result.task.id}（必须新建 Session）` : '',
    result.task.remoteStatus ? `平台 Task：${result.task.remoteStatus}${result.task.gatesReady ? ' · Gate 已通过' : ''}` : '',
    result.task.parentTaskId ? `父 Task：${result.task.parentTaskId}` : '',
    result.task.retirementStatus ? `历史快照：${result.task.retirementStatus}${result.task.historyArtifactRoot ? ` · ${result.task.historyArtifactRoot}` : ''}` : '',
    `当前：${stageLabel(result.workflow.currentStage || result.workflow.stage)}`,
    `下一步：${result.workflow.action}`,
    `原因：${result.workflow.reason}`,
    result.reconciliation.needsDeliveryReconciliation ? `交付对账：发现 ${result.reconciliation.unrecordedCommits.length || 1} 个未登记提交，需补写平台 Delivery` : '交付对账：Git 与最近 Delivery 一致',
    result.reconciliation.pushRequired ? `远程验证门禁：当前 HEAD ${result.repository.head.slice(0, 12)} 尚未与上游分支对齐；创建 Test/Review Action 前需要明确授权并推送当前分支` : '远程验证门禁：当前 HEAD 已在上游分支可见',
    result.platform.pendingDeliveries?.total ? `待发送补报：本次发送 ${result.platform.pendingDeliveries.sent}，剩余 ${result.platform.pendingDeliveries.pending}` : '',
    result.platform.outbox?.pending ? `离线待同步：${result.platform.outbox.pending} 条（可重放 ${result.platform.outbox.ready}，阻塞 ${result.platform.outbox.blocked}）${result.platform.outbox.next ? `；下一条 ${result.platform.outbox.next.type}` : ''}` : '',
    result.reasons.length ? `降级原因：${result.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const json = process.argv.includes('--json')
  const offline = process.argv.includes('--offline')
  const repoArg = process.argv.slice(2).find(arg => !arg.startsWith('-')) || '.'
  const result = await inspectCapStatus({ repoRoot: repoArg, offline })
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
}
