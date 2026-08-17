import { chmod, copyFile, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
export const { resolveSystemAddresses } = require('./system-dns.cjs')

export const publicSkillNames = ['cap']
export const legacySkillNames = ['cap-map', 'cap-shape', 'cap-build', 'cap-verify']
export const minimumMcpNodeVersion = '20.18.1'
export const minimumLocalNodeVersion = '18.0.0'
export const clientRestartNotice = () => '重要：已经打开的客户端不会热加载新 Skill/MCP。请完全退出并重新打开 ChatGPT/Codex/Claude/Cursor，然后新建任务继续；现有分支和工作区改动不会丢失。'

function isCompatibleNode(version = '', minimum = [18, 0, 0]) {
  const parts = String(version).replace(/^v/, '').split('.').map(Number)
  if (parts.length < 3 || parts.some(Number.isNaN)) return false
  const [major, minor, patch] = parts
  const [minimumMajor, minimumMinor, minimumPatch] = minimum
  return major > minimumMajor || (major === minimumMajor && (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)))
}

export function isCompatibleMcpNode(version = '') {
  return isCompatibleNode(version, [20, 18, 1])
}

export const isCompatibleLocalNode = version => isCompatibleNode(version, [18, 0, 0])

export function parseSetupArgs(argv = []) {
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] || '' : '' }
  return { server: value('--server'), local: argv.includes('--local'), project: argv.includes('--project'), doctor: argv.includes('--doctor'), upgrade: argv.includes('--upgrade'), configOnly: argv.includes('--config-only'), codexOnly: argv.includes('--codex-only'), claudeOnly: argv.includes('--claude-only') }
}

export const skillTargets = home => ({ codex: join(home, '.agents/skills'), claude: join(home, '.claude/skills'), cursor: join(home, '.cursor/skills') })
export const activationRuleTargets = home => ({ codex: join(home, '.codex', 'AGENTS.md'), claude: join(home, '.claude', 'CLAUDE.md'), cursor: join(home, '.cursor', 'rules', 'capital-agent.mdc') })
export const codexConfigPath = home => join(home, '.codex', 'config.toml')
export const cursorMcpConfigPath = home => join(home, '.cursor', 'mcp.json')

const ACTIVATION_START = '<!-- capital-agent:auto-activation:start -->'
const ACTIVATION_END = '<!-- capital-agent:auto-activation:end -->'
export const activationRuleBlock = `${ACTIVATION_START}
## Capital Agent 自动研发入口

当当前目录位于 Git 仓库中，且用户意图是实现功能、修复问题、重构、补测试、代码评审或发布交付时，必须在实质分析或修改前加载已安装的 \`cap\` Skill。检查当前宿主是否实际暴露 Capital Agent MCP 工具，并把结果作为 \`loaded\` / \`missing\` 传给 \`scripts/cap-status.mjs --mcp-runtime\`。若返回 \`restart_required\`，先提示用户选择“重启后使用团队模式”或“本次明确改用本地模式继续”；用户选择本地继续后，使用 \`--allow-local-once\` 重跑状态检查，本任务不创建平台 Task、不回写经验或 Server Gate，但不修改机器的团队模式配置。若 \`CAPITAL_AGENT_MODE=local\`，按纯本地流程完成代码侦察、实现和本地证据，不连接平台、不创建 Task、不写 Outbox；否则按 Skill 要求完成平台握手、创建或绑定统一 Task、实现和证据回写。不要等待用户显式输入 \`$cap\` 或 \`/cap\`。

纯问答、概念讨论、调研、翻译、状态查询，以及明确不需要代码或仓库变更的请求，不创建平台 Task。MCP 已加载但远端调用临时失败时，必须明确报告离线降级及影响，不得宣称已经同步；MCP 未加载且团队模式已配置时，必须先取得用户“本次本地继续”的明确选择，不能静默降级。用户的显式指令始终优先。
${ACTIVATION_END}`

export const cursorActivationRuleBlock = activationRuleBlock

export async function installActivationRule(filePath, block = activationRuleBlock) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const existing = await readFile(filePath, 'utf8').catch(() => '')
  const start = existing.indexOf(ACTIVATION_START)
  const end = existing.indexOf(ACTIVATION_END)
  let next
  if (start >= 0 && end >= start) {
    next = `${existing.slice(0, start)}${block}${existing.slice(end + ACTIVATION_END.length)}`
  } else {
    next = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`
  }
  await writeFile(filePath, next, { mode: 0o600 })
  return { filePath, changed: next !== existing }
}

export async function hasActivationRule(filePath) {
  const content = await readFile(filePath, 'utf8').catch(() => '')
  return content.includes(ACTIVATION_START) && content.includes(ACTIVATION_END)
}

export async function hasSkillLink(sourceDir, targetDir, name = 'cap') {
  try {
    const target = join(targetDir, name)
    const stat = await lstat(target)
    return stat.isSymbolicLink() && await readlink(target) === join(sourceDir, name)
  } catch { return false }
}

export async function installCursorActivationRule(filePath) {
  const result = await installActivationRule(filePath, cursorActivationRuleBlock)
  const content = await readFile(filePath, 'utf8')
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content)) return result
  const next = `---\ndescription: Automatically use Capital Agent for real development work\nalwaysApply: true\n---\n\n${content}`
  await writeFile(filePath, next, { mode: 0o600 })
  return { filePath, changed: true }
}

const CODEX_MCP_START = '# capital-agent:mcp:start'
const CODEX_MCP_END = '# capital-agent:mcp:end'
export async function installCodexMcpConfig(filePath, nodePath, wrapperPath) {
  await mkdir(join(filePath, '..'), { recursive: true, mode: 0o700 })
  const existing = await readFile(filePath, 'utf8').catch(() => '')
  const block = `${CODEX_MCP_START}\n[mcp_servers.capital-agent]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(wrapperPath)}]\n${CODEX_MCP_END}`
  let base = existing
  const managedStart = base.indexOf(CODEX_MCP_START); const managedEnd = base.indexOf(CODEX_MCP_END)
  if (managedStart >= 0 && managedEnd >= managedStart) base = `${base.slice(0, managedStart)}${base.slice(managedEnd + CODEX_MCP_END.length)}`
  const lines = base.split(/\r?\n/); const kept = []; let skipping = false
  for (const line of lines) {
    if (line.trim() === '[mcp_servers.capital-agent]') { skipping = true; continue }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (skipping) continue
    if (line.trim() === `args = [${JSON.stringify(wrapperPath)}]`) continue
    kept.push(line)
  }
  base = kept.join('\n')
  const next = `${base.trimEnd()}${base.trim() ? '\n\n' : ''}${block}\n`
  await writeFile(filePath, next, { mode: 0o600 })
  return { filePath, changed: next !== existing }
}

export async function hasCodexMcpConfig(filePath, wrapperPath = '') {
  const state = await inspectCodexMcpConfig(filePath, wrapperPath)
  return state.registered && state.valid
}

function parseStdioEntry(entry = {}) {
  const command = String(entry.command || '').trim()
  const args = Array.isArray(entry.args) ? entry.args.filter(value => typeof value === 'string') : []
  const wrapperPath = args.find(value => basename(value) === 'mcp-remote.mjs') || ''
  return { registered: Boolean(command && wrapperPath), command, args, wrapperPath }
}

async function withEntryValidity(entry = {}, expectedWrapperPath = '') {
  const valid = entry.registered ? await lstat(entry.wrapperPath).then(stat => stat.isFile() || stat.isSymbolicLink()).catch(() => false) : false
  return { ...entry, ...(expectedWrapperPath ? { current: entry.wrapperPath === expectedWrapperPath } : {}), valid }
}

export async function inspectCodexMcpConfig(filePath, expectedWrapperPath = '') {
  const content = await readFile(filePath, 'utf8').catch(() => '')
  const marker = '[mcp_servers.capital-agent]'
  const start = content.indexOf(marker)
  if (start < 0) return withEntryValidity({}, expectedWrapperPath)
  const remainder = content.slice(start + marker.length)
  const nextSection = remainder.search(/^\s*\[/m)
  const section = nextSection >= 0 ? remainder.slice(0, nextSection) : remainder
  const command = section.match(/^\s*command\s*=\s*("(?:\\.|[^"])*")/m)?.[1]
  const argsLiteral = section.match(/^\s*args\s*=\s*(\[[^\r\n]*\])/m)?.[1]
  try {
    return withEntryValidity(parseStdioEntry({ command: command ? JSON.parse(command) : '', args: argsLiteral ? JSON.parse(argsLiteral) : [] }), expectedWrapperPath)
  } catch {
    return withEntryValidity({}, expectedWrapperPath)
  }
}

export async function installCursorMcpConfig(filePath, nodePath, wrapperPath) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const existing = await readFile(filePath, 'utf8').catch(() => '')
  let config = {}
  if (existing.trim()) {
    try { config = JSON.parse(existing) } catch { throw new Error(`Cursor MCP 配置不是有效 JSON，未覆盖：${filePath}`) }
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error(`Cursor MCP 配置必须是 JSON 对象，未覆盖：${filePath}`)
  const mcpServers = config.mcpServers && !Array.isArray(config.mcpServers) && typeof config.mcpServers === 'object' ? config.mcpServers : {}
  const nextConfig = { ...config, mcpServers: { ...mcpServers, 'capital-agent': { command: nodePath, args: [wrapperPath] } } }
  const next = `${JSON.stringify(nextConfig, null, 2)}\n`
  await writeFile(filePath, next, { mode: 0o600 })
  return { filePath, changed: next !== existing }
}

export async function hasCursorMcpConfig(filePath, wrapperPath = '') {
  const state = await inspectCursorMcpConfig(filePath)
  return state.registered && state.valid && (!wrapperPath || state.wrapperPath === wrapperPath)
}

export async function inspectCursorMcpConfig(filePath) {
  try {
    const config = JSON.parse(await readFile(filePath, 'utf8'))
    return withEntryValidity(parseStdioEntry(config?.mcpServers?.['capital-agent']))
  } catch { return withEntryValidity({}) }
}

export async function inspectClaudeMcpConfig(filePath) {
  try {
    const config = JSON.parse(await readFile(filePath, 'utf8'))
    return withEntryValidity(parseStdioEntry(config?.mcpServers?.['capital-agent']))
  } catch { return withEntryValidity({}) }
}

export async function installSkillLinks(sourceDir, targetDir, skillNames = publicSkillNames) {
  const { readdir } = await import('fs/promises')
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const available = new Set(entries.filter(item => item.isDirectory()).map(item => item.name))
  const selected = [...new Set(skillNames)].filter(name => available.has(name))

  // 升级时清理旧版本安装的内部阶段链接。只删除仍指向本技能包 sourceDir 的软链接，
  // 不碰用户自己创建的目录、文件或指向其他来源的同名 Skill。
  for (const entry of entries.filter(item => item.isDirectory() && !selected.includes(item.name))) {
    const target = join(targetDir, entry.name)
    try {
      const stat = await lstat(target)
      if (stat.isSymbolicLink() && (await readlink(target)) === join(sourceDir, entry.name)) await unlink(target)
    } catch {}
  }
  for (const name of legacySkillNames) {
    const target = join(targetDir, name)
    try {
      const stat = await lstat(target)
      const linked = stat.isSymbolicLink() ? await readlink(target) : ''
      if (linked === join(sourceDir, name)) await unlink(target)
    } catch {}
  }

  const installed = []
  for (const name of selected) {
    const source = join(sourceDir, name); const target = join(targetDir, name)
    try {
      const stat = await lstat(target)
      if (!stat.isSymbolicLink()) continue
      if (await readlink(target) === source) { installed.push(name); continue }
      await unlink(target)
    } catch {}
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    installed.push(name)
  }
  return installed
}

export const normalizeServerUrl = value => {
  const url = new URL(String(value || '').trim().replace(/\/+$/, ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('平台地址必须是 HTTP(S)')
  return url.toString().replace(/\/+$/, '')
}

export async function pollDeviceAuthorization(serverUrl, secret, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), expiresIn = 600, interval = 2 } = {}) {
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    const response = await fetchImpl(`${serverUrl}/api/device-auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_secret: secret }) })
    const body = await response.json()
    if (response.ok && body.data?.user_key) return body.data.user_key
    if (response.status !== 202) throw new Error(body.msg || '设备授权失败')
    await wait(interval * 1000)
  }
  throw new Error('设备授权已超时，请重新运行安装')
}

export async function checkPlatformConnection(serverUrl, userKey, fetchImpl = fetch) {
  if (!serverUrl || !userKey) return false
  try {
    const response = await fetchImpl(`${serverUrl}/api/auth/heartbeat`, { method: 'PUT', headers: { 'x-user-key': userKey } })
    return response.ok
  } catch { return false }
}

export async function checkPlatformHandshake(serverUrl, userKey, fetchImpl = fetch, client = {}) {
  if (!serverUrl || !userKey) return { ok: false, reason: 'missing_config' }
  try {
    const response = await fetchImpl(`${serverUrl}/api/auth/handshake`, { method: 'PUT', headers: { 'x-user-key': userKey, 'Content-Type': 'application/json' }, body: JSON.stringify(client && typeof client === 'object' ? client : {}) })
    const body = await response.json().catch(() => ({}))
    const data = body.data || {}
    return { ok: response.ok && data.capabilities?.taskWrite === true && data.capabilities?.commitReconcile === true, status: response.status, reason: response.ok ? '' : 'http_rejected', ...data }
  } catch (error) {
    const fallback = systemCurlJson(`${serverUrl}/api/auth/handshake`, {
      method: 'PUT', headers: { 'x-user-key': userKey, 'Content-Type': 'application/json' }, body: JSON.stringify(client && typeof client === 'object' ? client : {}),
    })
    if (fallback) {
      const data = fallback.body?.data || {}
      return { ok: fallback.ok && data.capabilities?.taskWrite === true && data.capabilities?.commitReconcile === true, status: fallback.status, reason: fallback.ok ? '' : 'http_rejected', transport: 'system_curl', ...data }
    }
    return { ok: false, reason: 'direct_probe_unavailable', errorCode: String(error?.cause?.code || error?.code || '').slice(0, 80) }
  }
}

function curlConfigValue(value = '') { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '') }

export function systemCurlJson(url, { method = 'GET', headers = {}, body = '' } = {}, { platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  try {
    const target = new URL(url); const address = resolveSystemAddresses(target.hostname, { platform, execFileSyncImpl })[0]
    const lines = ['silent', 'show-error', 'connect-timeout = 5', 'max-time = 15', `url = "${curlConfigValue(url)}"`, `request = "${curlConfigValue(method)}"`]
    if (address) lines.push(`resolve = "${curlConfigValue(target.hostname)}:${target.port || (target.protocol === 'https:' ? '443' : '80')}:${curlConfigValue(address)}"`)
    for (const [name, value] of Object.entries(headers)) lines.push(`header = "${curlConfigValue(name)}: ${curlConfigValue(value)}"`)
    if (body) lines.push(`data = "${curlConfigValue(body)}"`)
    lines.push('write-out = "\\n%{http_code}"')
    const output = execFileSyncImpl(platform === 'win32' ? 'curl.exe' : 'curl', ['--config', '-'], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'pipe', 'ignore'] })
    const split = output.lastIndexOf('\n'); if (split < 0) return null
    const status = Number(output.slice(split + 1).trim()); const rawBody = output.slice(0, split)
    return { ok: status >= 200 && status < 300, status, body: JSON.parse(rawBody || '{}') }
  } catch { return null }
}

export async function bootstrapLocalTestProvider(serverUrl, userKey, client = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${serverUrl}/api/auth/local-test-provider/bootstrap`, {
    method: 'POST',
    headers: { 'x-user-key': userKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: client.clientId, clientName: client.clientName }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.data?.runnerId || !body.data?.runnerCredential) throw new Error(body.msg || '本地 Test Provider 注册失败')
  return body.data
}

export async function installLocalTestProvider({ home, source, serverUrl, registration, clientId }) {
  const directory = join(home, '.capital-agent', 'runner')
  const runtimePath = join(directory, 'local-test-provider.mjs')
  const configPath = join(directory, 'config.json')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await copyFile(source, runtimePath)
  await chmod(runtimePath, 0o700)
  await writeFile(configPath, `${JSON.stringify({
    serverUrl,
    runnerId: registration.runnerId,
    runnerCredential: registration.runnerCredential,
    clientId,
    capabilities: ['test'],
    runtimeVersion: 'skills-local-test-provider-v1',
  }, null, 2)}\n`, { mode: 0o600 })
  await chmod(configPath, 0o600)
  return { runtimePath, configPath }
}

export async function inspectLocalTestProvider(home) {
  const directory = join(home, '.capital-agent', 'runner')
  const runtimePath = join(directory, 'local-test-provider.mjs')
  const configPath = join(directory, 'config.json')
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const runtime = await lstat(runtimePath)
    const credentialsReady = Boolean(config.serverUrl && config.runnerId && config.runnerCredential && Array.isArray(config.capabilities) && config.capabilities.length === 1 && config.capabilities[0] === 'test')
    return { ok: runtime.isFile() && credentialsReady, runtimePath, configPath, config }
  } catch {
    return { ok: false, runtimePath, configPath, config: {} }
  }
}

export async function checkLocalTestProvider(config = {}, fetchImpl = fetch) {
  if (!config.serverUrl || !config.runnerId || !config.runnerCredential) return { ok: false, reason: 'missing_config' }
  try {
    const response = await fetchImpl(`${config.serverUrl}/api/execution/runner/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runner-id': config.runnerId, 'x-runner-token': config.runnerCredential },
      body: JSON.stringify({ capabilities: { doctor: true, test: true, patch: false } }),
    })
    return { ok: response.ok, status: response.status }
  } catch {
    const fallback = systemCurlJson(`${config.serverUrl}/api/execution/runner/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-runner-id': config.runnerId, 'x-runner-token': config.runnerCredential },
      body: JSON.stringify({ capabilities: { doctor: true, test: true, patch: false } }),
    })
    if (fallback) return { ok: fallback.ok, status: fallback.status, transport: 'system_curl' }
    return { ok: false, reason: 'network_error' }
  }
}
