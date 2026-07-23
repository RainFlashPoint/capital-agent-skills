#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPlatformConnection, normalizeServerUrl } from './setup-lib.mjs'

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

export function resolveNextAction({ stateText = '', artifacts = {}, dirty = false } = {}) {
  if (!stateText) {
    return artifacts.profile
      ? { stage: 'define', action: '需求确认', reason: '尚无任务 STATE，已有项目画像' }
      : { stage: 'understand', action: '项目了解', reason: '尚无任务 STATE 与项目画像' }
  }

  const stage = canonicalStage(field(stateText, 'stage')) || 'understand'
  const status = field(stateText, 'status').toLowerCase() || 'in-progress'
  const declared = nextFromState(stateText)
  if (status === 'blocked' || status === 'gated') {
    return { stage, action: '解除当前门禁', reason: `${stage} 状态为 ${status}`, gated: true, declaredNext: declared }
  }
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
  const remote = git(repo, ['remote', 'get-url', 'origin'])
  const dirty = Boolean(git(repo, ['status', '--porcelain']))
  const statePath = join(repo, '.cap/STATE.md')
  const stateText = await readFile(statePath, 'utf8').catch(() => '')
  const artifacts = {
    profile: await exists(join(repo, '.cap/PROFILE.md')),
    spec: await exists(join(repo, '.cap/spec.md')),
    plan: await exists(join(repo, '.cap/plan.md')),
  }
  const platform = offline ? null : Boolean(serverUrl && userKey && await checkPlatformConnection(serverUrl, userKey, fetchImpl))
  const next = resolveNextAction({ stateText, artifacts, dirty })
  const taskId = field(stateText, 'task-id')
  const sessionId = field(stateText, 'session-id')
  const reasons = []
  if (!gitRoot) reasons.push('not_git_repository')
  if (!serverUrl) reasons.push('missing_server_url')
  if (!userKey) reasons.push('missing_user_key')
  if (!offline && serverUrl && userKey && platform === false) reasons.push('platform_probe_failed_needs_mcp_confirmation')
  if (!taskId) reasons.push('task_not_attached')
  return {
    mode: !gitRoot || !serverUrl || !userKey
      ? 'local_degraded'
      : platform === true
        ? taskId ? 'platform_attached' : 'platform_ready'
        : taskId ? 'platform_attached_unverified' : 'platform_unverified',
    platform: { configured: Boolean(serverUrl && userKey), connected: platform, serverUrl: serverUrl || '' },
    repository: { root: gitRoot || repo, remote, branch, head, dirty },
    task: { id: taskId, sessionId },
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
    `当前：${stageLabel(result.workflow.currentStage || result.workflow.stage)}`,
    `下一步：${result.workflow.action}`,
    `原因：${result.workflow.reason}`,
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
