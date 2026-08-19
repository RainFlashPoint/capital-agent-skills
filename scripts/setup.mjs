#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { activationRuleTargets, bootstrapLocalTestProvider, checkLocalTestProvider, checkPlatformHandshake, clientRestartNotice, codexConfigPath, cursorMcpConfigPath, hasActivationRule, hasSkillLink, inspectClaudeMcpConfig, inspectCodexMcpConfig, inspectCursorMcpConfig, inspectInstallManifest, inspectLegacyCodexSkills, inspectLocalTestProvider, installActivationRule, installCodexMcpConfig, installCursorActivationRule, installCursorMcpConfig, installLocalTestProvider, installSkillLinks, isCompatibleLocalNode, isCompatibleMcpNode, migrateLegacyCodexSkills, minimumLocalNodeVersion, minimumMcpNodeVersion, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization, skillTargets, writeInstallManifest } from './setup-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url)); const root = resolve(here, '..'); const args = parseSetupArgs(process.argv.slice(2))
const configDir = join(homedir(), '.config/capital-agent'); const configFile = join(configDir, 'env')
const mcpRuntimeDir = join(homedir(), '.capital-agent', 'mcp-runtime')
const mcpRuntimePackage = join(mcpRuntimeDir, 'node_modules', 'mcp-remote', 'package.json')
const MCP_REMOTE_VERSION = '0.1.38'
if (args.local && args.server) throw new Error('--local 与 --server 不能同时使用')
const compatibleNode = args.local ? isCompatibleLocalNode(process.versions.node) : isCompatibleMcpNode(process.versions.node)
const minimumNodeVersion = args.local ? minimumLocalNodeVersion : minimumMcpNodeVersion
if (!compatibleNode) throw new Error(`Capital Agent ${args.local ? '本地模式' : 'MCP Runtime'} 需要 Node.js ${minimumNodeVersion}+，当前为 ${process.version}。请改用 bash scripts/setup.sh，让安装器自动选择兼容 Node。`)
const existing = await readFile(configFile, 'utf8').catch(() => '')
const config = Object.fromEntries(existing.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1],match[2]]))
let serverUrl = ''
if (!args.local) serverUrl = normalizeServerUrl(args.server || process.env.CAPITAL_AGENT_SERVER_URL || config.CAPITAL_AGENT_SERVER_URL || '')
let userKey = String(process.env.CAPITAL_AGENT_USER_KEY || config.CAPITAL_AGENT_USER_KEY || '').trim()
let clientId = String(process.env.CAPITAL_AGENT_CLIENT_ID || config.CAPITAL_AGENT_CLIENT_ID || '').trim()
if (!clientId) clientId = `client_${randomUUID()}`

function commandExists(command) { try { execFileSync(command,['--version'],{stdio:'ignore'}); return true } catch { return false } }
function run(command, values, options={}) { return execFileSync(command,values,{stdio:'inherit',...options}) }
function installStateDetail(state, localMode = false) {
  if (state.ok) return `PASS（${state.current.sourceCommit.slice(0, 12)} / v${state.current.version || 'unknown'}）`
  const labels = { manifest_missing: '未找到安装清单', source_unavailable: '安装源码不可用', source_root_mismatch: '运行副本与本次源码目录不一致', version_drift: '版本号漂移', source_commit_drift: '源码 Commit 漂移', file_manifest_drift: '文件内容漂移' }
  return `FAIL（${labels[state.reason] || state.reason}${state.changedFiles.length ? `: ${state.changedFiles.slice(0, 5).join(', ')}` : ''}；请运行 ${localMode ? '--local --upgrade' : '--upgrade'}）`
}
function legacySkillDetail(state = {}) {
  if (state.ok) return 'PASS'
  return `FAIL（旧版重复 Skill: ${(state.entries || []).map(item => item.name).join(', ')}；请运行升级命令）`
}
function migrationDetail(result = {}) {
  const moved = [...(result.removed || []), ...(result.backedUp || []).map(item => item.name)]
  return moved.length ? `；已迁移旧版 Codex Skill: ${moved.join(', ')}` : ''
}
function probeInstalledMcp(state = {}) {
  if (!state.registered || !state.valid) return false
  try { return JSON.parse(execFileSync(process.execPath,[join(here,'probe-mcp.mjs'),state.command,...state.args],{encoding:'utf8',timeout:15_000})).ok === true } catch { return false }
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const values = process.platform === 'win32' ? ['/c','start','',url] : [url]
  try { spawn(command,values,{detached:true,stdio:'ignore'}).unref() } catch {}
}

if (args.doctor && args.local) {
  const targets = skillTargets(homedir())
  const rules = activationRuleTargets(homedir())
  const codexSkill = await hasSkillLink(join(root, 'skills'), targets.codex)
  const claudeSkill = await hasSkillLink(join(root, 'skills'), targets.claude)
  const cursorSkill = await hasSkillLink(join(root, 'skills'), targets.cursor)
  const codexActivation = await hasActivationRule(rules.codex)
  const claudeActivation = await hasActivationRule(rules.claude)
  const cursorActivation = await hasActivationRule(rules.cursor)
  const installState = await inspectInstallManifest(homedir(), root)
  const legacySkills = await inspectLegacyCodexSkills(homedir(), join(root, 'skills'))
  const installDetail = installStateDetail(installState, true)
  process.stdout.write(`运行模式: 本地（显式）\n安装源码一致性: ${installDetail}\n旧版 Codex Skill 隔离: ${legacySkillDetail(legacySkills)}\nCodex Skill: ${codexSkill?'PASS':'未安装'}\nClaude Skill: ${claudeSkill?'PASS':'未安装'}\nCursor Skill: ${cursorSkill?'PASS':'未安装'}\nCodex 自动进入 Cap: ${codexActivation?'PASS':'FAIL'}\nClaude 自动进入 Cap: ${claudeActivation?'PASS':'FAIL'}\nCursor 自动进入 Cap: ${cursorActivation?'PASS':'FAIL'}\n平台 / MCP / Test Provider: 本地模式跳过\n当前会话加载状态: Doctor 只能验证磁盘配置；已打开的客户端需重启后才会加载更新。\n`)
  if (!installState.ok || !legacySkills.ok || (!codexSkill && !claudeSkill && !cursorSkill) || !codexActivation || !claudeActivation || !cursorActivation) process.exitCode = 1
  process.exit()
}

if (args.doctor) {
  const health = await checkPlatformHandshake(serverUrl,userKey,fetch,{clientId,clientName:hostname(),clientVersion:'setup',mcpReachable:true,capabilities:{doctor:true}})
  const expectedWrapper = join(here,'mcp-remote.mjs')
  const codexMcp = await inspectCodexMcpConfig(codexConfigPath(homedir()),expectedWrapper)
  const cursorMcp = await inspectCursorMcpConfig(cursorMcpConfigPath(homedir()))
  const claudeMcp = await inspectClaudeMcpConfig(join(homedir(),'.claude.json'))
  const mcpRuntime = await readFile(mcpRuntimePackage,'utf8').then(value=>JSON.parse(value).version===MCP_REMOTE_VERSION).catch(()=>false)
  const clientMcpStates = [codexMcp,claudeMcp,cursorMcp]
  const clientMcpProbes = clientMcpStates.map(state => probeInstalledMcp(state))
  const mcpRegistered = clientMcpStates.some(state => state.registered && state.valid)
  const mcpTools = mcpRuntime && clientMcpStates.every((state,index) => !state.registered || clientMcpProbes[index])
  const provider = await inspectLocalTestProvider(homedir())
  const providerAuth = provider.ok ? await checkLocalTestProvider(provider.config) : { ok: false }
  const rules = activationRuleTargets(homedir())
  const codexActivation = await hasActivationRule(rules.codex)
  const claudeActivation = await hasActivationRule(rules.claude)
  const cursorActivation = await hasActivationRule(rules.cursor)
  const installState = await inspectInstallManifest(homedir(), root)
  const legacySkills = await inspectLegacyCodexSkills(homedir(), join(root, 'skills'))
  const installDetail = installStateDetail(installState)
  const label = (state,index) => !state.registered ? '未注册' : !state.valid ? 'FAIL（配置路径不可用）' : clientMcpProbes[index] ? 'PASS' : 'FAIL（实际调用失败）'
  process.stdout.write(`安装源码一致性: ${installDetail}\n旧版 Codex Skill 隔离: ${legacySkillDetail(legacySkills)}\n平台身份连接: ${health.ok?'PASS':'FAIL'}\nTask 写能力: ${health.capabilities?.taskWrite?'PASS':'FAIL'}\nCommit 自动补报: ${health.capabilities?.commitReconcile?'PASS':'FAIL'}\nMCP 固定运行时: ${mcpRuntime?'PASS':'FAIL'}\nMCP 工具真实调用: ${mcpTools?'PASS':'FAIL'}\nCodex MCP: ${label(codexMcp,0)}\nClaude MCP: ${label(claudeMcp,1)}\nCursor MCP: ${label(cursorMcp,2)}\nCodex 自动进入 Cap: ${codexActivation?'PASS':'FAIL'}\nClaude 自动进入 Cap: ${claudeActivation?'PASS':'FAIL'}\nCursor 自动进入 Cap: ${cursorActivation?'PASS':'FAIL'}\n本机配置: ${existing&&userKey?'PASS':'FAIL'}\n本地 Test Provider: ${provider.ok&&providerAuth.ok?'PASS':'FAIL'}\nProvider 权限: ${provider.ok?'test-only':'不可用'}\n当前会话加载状态: Doctor 已验证磁盘配置与独立 MCP 调用，但不能让已打开的客户端热加载；当前任务仍无 MCP 工具时请完全重启客户端。\n`)
  if (!installState.ok || !legacySkills.ok || !health.ok || !mcpRuntime || !mcpTools || !mcpRegistered || !provider.ok || !providerAuth.ok || !codexActivation || !claudeActivation || !cursorActivation) process.exitCode=1
  process.exit()
}

if (args.upgrade) run('git',['pull','--ff-only'],{cwd:root})
if (args.local) {
  await mkdir(configDir,{recursive:true,mode:0o700})
  const retainedConfig = existing.split(/\r?\n/).filter(line => line && !line.startsWith('CAPITAL_AGENT_MODE=')).join('\n')
  await writeFile(configFile,`CAPITAL_AGENT_MODE=local\n${retainedConfig}${retainedConfig ? '\n' : ''}`,{mode:0o600})
  await chmod(configFile,0o600)
  const installed = []
  const legacyMigration = await migrateLegacyCodexSkills(homedir(), join(root, 'skills'))
  const targets = skillTargets(homedir())
  const rules = activationRuleTargets(homedir())
  await installActivationRule(rules.codex)
  await installActivationRule(rules.claude)
  await installCursorActivationRule(rules.cursor)
  if (!args.claudeOnly) installed.push(`Codex: ${(await installSkillLinks(join(root,'skills'),targets.codex)).length}`)
  if (!args.codexOnly) installed.push(`Claude: ${(await installSkillLinks(join(root,'skills'),targets.claude)).length}`)
  if (!args.codexOnly && !args.claudeOnly) installed.push(`Cursor: ${(await installSkillLinks(join(root,'skills'),targets.cursor)).length}`)
  if (args.project) run(process.execPath,[join(here,'install-git-governance.mjs')])
  await writeInstallManifest(homedir(), root)
  process.stdout.write(`Capital Agent 本地模式安装完成。${installed.join('，')}${migrationDetail(legacyMigration)}。不会连接平台、创建 Task、调用 MCP/Harness 或累积 Outbox；测试与评审证据保留在本地。配置保存在 ${configFile}。\n${clientRestartNotice()}\n`)
  process.exit()
}
if (!userKey) {
  const response = await fetch(`${serverUrl}/api/device-auth/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  const body = await response.json(); if (!response.ok) throw new Error(body.msg || '无法启动设备授权')
  const data = body.data; const verifyUrl = `${serverUrl}/device/authorize?code=${encodeURIComponent(data.userCode)}`
  process.stdout.write(`请在浏览器确认授权码 ${data.userCode}\n${verifyUrl}\n`); openBrowser(verifyUrl)
  userKey = await pollDeviceAuthorization(serverUrl,data.deviceSecret,{expiresIn:data.expiresIn,interval:data.interval})
}
if (/\r|\n/.test(serverUrl) || /\r|\n/.test(userKey)) throw new Error('平台配置不能包含换行符')
await mkdir(configDir,{recursive:true,mode:0o700}); await writeFile(configFile,`CAPITAL_AGENT_MODE=server\nCAPITAL_AGENT_SERVER_URL=${serverUrl}\nCAPITAL_AGENT_USER_KEY=${userKey}\nCAPITAL_AGENT_CLIENT_ID=${clientId}\n`,{mode:0o600}); await chmod(configFile,0o600)

const registration = await bootstrapLocalTestProvider(serverUrl,userKey,{clientId,clientName:hostname()})
const localProvider = await installLocalTestProvider({ home: homedir(), source: join(root,'runtime','local-test-provider.mjs'), serverUrl, registration, clientId })
const installedMcpVersion = await readFile(mcpRuntimePackage,'utf8').then(value=>JSON.parse(value).version).catch(()=> '')
if (installedMcpVersion !== MCP_REMOTE_VERSION) {
  if (!commandExists('npm')) throw new Error('未找到与 Node 配套的 npm，无法安装固定 MCP 运行时')
  await mkdir(mcpRuntimeDir,{recursive:true,mode:0o700})
  run('npm',['install','--prefix',mcpRuntimeDir,'--no-audit','--no-fund',`mcp-remote@${MCP_REMOTE_VERSION}`])
}

const installed = []
const legacyMigration = await migrateLegacyCodexSkills(homedir(), join(root, 'skills'))
const targets = skillTargets(homedir())
const rules = activationRuleTargets(homedir())
await installActivationRule(rules.codex)
await installActivationRule(rules.claude)
await installCursorActivationRule(rules.cursor)
if (!args.claudeOnly) installed.push(`Codex: ${(await installSkillLinks(join(root,'skills'),targets.codex)).length}`)
if (!args.codexOnly) installed.push(`Claude: ${(await installSkillLinks(join(root,'skills'),targets.claude)).length}`)
if (!args.codexOnly && !args.claudeOnly) installed.push(`Cursor: ${(await installSkillLinks(join(root,'skills'),targets.cursor)).length}`)
const wrapper = join(here,'mcp-remote.mjs')
if (!args.configOnly && !args.claudeOnly) await installCodexMcpConfig(codexConfigPath(homedir()),process.execPath,wrapper)
if (!args.configOnly && !args.codexOnly && !args.claudeOnly) await installCursorMcpConfig(cursorMcpConfigPath(homedir()),process.execPath,wrapper)
if (!args.configOnly && !args.codexOnly && commandExists('claude')) { try { run('claude',['mcp','remove','capital-agent','-s','user']) } catch {}; run('claude',['mcp','add','-s','user','capital-agent','--',process.execPath,wrapper]) }
if (args.project) run(process.execPath,[join(here,'install-git-governance.mjs')])
await writeInstallManifest(homedir(), root)
process.stdout.write(`Capital Agent 安装完成。${installed.join('，')}${migrationDetail(legacyMigration)}。真实研发请求将自动进入 Cap；本地 Test Provider 已启用（按需运行、test-only）。配置仅保存在 ${configFile} 与 ${localProvider.configPath}。\n${clientRestartNotice()}\n`)
