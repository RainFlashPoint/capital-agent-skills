#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { bootstrapLocalTestProvider, checkLocalTestProvider, checkPlatformHandshake, inspectLocalTestProvider, installLocalTestProvider, installSkillLinks, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization, skillTargets } from './setup-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url)); const root = resolve(here, '..'); const args = parseSetupArgs(process.argv.slice(2))
const configDir = join(homedir(), '.config/capital-agent'); const configFile = join(configDir, 'env')
const existing = await readFile(configFile, 'utf8').catch(() => '')
const config = Object.fromEntries(existing.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1],match[2]]))
let serverUrl = normalizeServerUrl(args.server || process.env.CAPITAL_AGENT_SERVER_URL || config.CAPITAL_AGENT_SERVER_URL || '')
let userKey = String(process.env.CAPITAL_AGENT_USER_KEY || config.CAPITAL_AGENT_USER_KEY || '').trim()
let clientId = String(process.env.CAPITAL_AGENT_CLIENT_ID || config.CAPITAL_AGENT_CLIENT_ID || '').trim()
if (!clientId) clientId = `client_${randomUUID()}`

function commandExists(command) { try { execFileSync(command,['--version'],{stdio:'ignore'}); return true } catch { return false } }
function run(command, values, options={}) { return execFileSync(command,values,{stdio:'inherit',...options}) }
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const values = process.platform === 'win32' ? ['/c','start','',url] : [url]
  try { spawn(command,values,{detached:true,stdio:'ignore'}).unref() } catch {}
}

if (args.doctor) {
  const health = await checkPlatformHandshake(serverUrl,userKey,fetch,{clientId,clientName:hostname(),clientVersion:'setup',mcpReachable:true,capabilities:{doctor:true}})
  const codexMcp = commandExists('codex') ? (() => { try { return /capital-agent/.test(execFileSync('codex',['mcp','list'],{encoding:'utf8'})) } catch { return false } })() : false
  const claudeMcp = commandExists('claude') ? (() => { try { return /capital-agent/.test(execFileSync('claude',['mcp','list'],{encoding:'utf8'})) } catch { return false } })() : false
  const provider = await inspectLocalTestProvider(homedir())
  const providerAuth = provider.ok ? await checkLocalTestProvider(provider.config) : { ok: false }
  process.stdout.write(`平台身份连接: ${health.ok?'PASS':'FAIL'}\nTask 写能力: ${health.capabilities?.taskWrite?'PASS':'FAIL'}\nCommit 自动补报: ${health.capabilities?.commitReconcile?'PASS':'FAIL'}\nCodex MCP: ${codexMcp?'PASS':'未注册'}\nClaude MCP: ${claudeMcp?'PASS':'未注册'}\n本机配置: ${existing&&userKey?'PASS':'FAIL'}\n本地 Test Provider: ${provider.ok&&providerAuth.ok?'PASS':'FAIL'}\nProvider 权限: ${provider.ok?'test-only':'不可用'}\n`)
  if (!health.ok || (!codexMcp && !claudeMcp) || !provider.ok || !providerAuth.ok) process.exitCode=1
  process.exit()
}

if (args.upgrade) run('git',['pull','--ff-only'],{cwd:root})
if (!userKey) {
  const response = await fetch(`${serverUrl}/api/device-auth/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  const body = await response.json(); if (!response.ok) throw new Error(body.msg || '无法启动设备授权')
  const data = body.data; const verifyUrl = `${serverUrl}/device/authorize?code=${encodeURIComponent(data.userCode)}`
  process.stdout.write(`请在浏览器确认授权码 ${data.userCode}\n${verifyUrl}\n`); openBrowser(verifyUrl)
  userKey = await pollDeviceAuthorization(serverUrl,data.deviceSecret,{expiresIn:data.expiresIn,interval:data.interval})
}
if (/\r|\n/.test(serverUrl) || /\r|\n/.test(userKey)) throw new Error('平台配置不能包含换行符')
await mkdir(configDir,{recursive:true,mode:0o700}); await writeFile(configFile,`CAPITAL_AGENT_SERVER_URL=${serverUrl}\nCAPITAL_AGENT_USER_KEY=${userKey}\nCAPITAL_AGENT_CLIENT_ID=${clientId}\n`,{mode:0o600}); await chmod(configFile,0o600)

const registration = await bootstrapLocalTestProvider(serverUrl,userKey,{clientId,clientName:hostname()})
const localProvider = await installLocalTestProvider({ home: homedir(), source: join(root,'runtime','local-test-provider.mjs'), serverUrl, registration, clientId })

const installed = []
const targets = skillTargets(homedir())
if (!args.claudeOnly) installed.push(`Codex: ${(await installSkillLinks(join(root,'skills'),targets.codex)).length}`)
if (!args.codexOnly) installed.push(`Claude: ${(await installSkillLinks(join(root,'skills'),targets.claude)).length}`)
const wrapper = join(here,'mcp-remote.mjs')
if (!args.configOnly && !args.claudeOnly && commandExists('codex')) { try { run('codex',['mcp','remove','capital-agent']) } catch {}; run('codex',['mcp','add','capital-agent','--',process.execPath,wrapper]) }
if (!args.configOnly && !args.codexOnly && commandExists('claude')) { try { run('claude',['mcp','remove','capital-agent','-s','user']) } catch {}; run('claude',['mcp','add','-s','user','capital-agent','--',process.execPath,wrapper]) }
if (args.project) run(process.execPath,[join(here,'install-git-governance.mjs')])
process.stdout.write(`Capital Agent 安装完成。${installed.join('，')}。本地 Test Provider 已启用（按需运行、test-only）。配置仅保存在 ${configFile} 与 ${localProvider.configPath}。\n`)
