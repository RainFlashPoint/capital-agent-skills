#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { execFileSync } from 'child_process'

const here = dirname(fileURLToPath(import.meta.url))
const serverUrl = String(process.env.CAPITAL_AGENT_SERVER_URL || '').trim().replace(/\/+$/, '')
const userKey = String(process.env.CAPITAL_AGENT_USER_KEY || '').trim()
if (!serverUrl || !userKey) {
  process.stderr.write('请先设置 CAPITAL_AGENT_SERVER_URL 和 CAPITAL_AGENT_USER_KEY，再运行安装。\n')
  process.exit(1)
}
if (/\r|\n/.test(serverUrl) || /\r|\n/.test(userKey)) {
  process.stderr.write('平台地址和 Key 不能包含换行符。\n')
  process.exit(1)
}
try {
  const parsed = new URL(serverUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
} catch {
  process.stderr.write('CAPITAL_AGENT_SERVER_URL 必须是有效的 HTTP(S) 地址。\n')
  process.exit(1)
}

const configDir = join(homedir(), '.config/capital-agent')
const configFile = join(configDir, 'env')
await mkdir(configDir, { recursive: true, mode: 0o700 })
await writeFile(configFile, `CAPITAL_AGENT_SERVER_URL=${serverUrl}\nCAPITAL_AGENT_USER_KEY=${userKey}\n`, { mode: 0o600 })
await chmod(configFile, 0o600)

const wrapper = join(here, 'mcp-remote.mjs')
function commandExists(command) {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}
function run(command, args) { execFileSync(command, args, { stdio: 'inherit' }) }

if (!process.argv.includes('--config-only') && !process.argv.includes('--claude-only') && commandExists('codex')) {
  try { run('codex', ['mcp', 'remove', 'capital-agent']) } catch {}
  run('codex', ['mcp', 'add', 'capital-agent', '--', process.execPath, wrapper])
}
if (!process.argv.includes('--config-only') && !process.argv.includes('--codex-only') && commandExists('claude')) {
  try { run('claude', ['mcp', 'remove', 'capital-agent', '-s', 'user']) } catch {}
  run('claude', ['mcp', 'add', '-s', 'user', 'capital-agent', '--', process.execPath, wrapper])
}

if (process.argv.includes('--project')) {
  run(process.execPath, [join(here, 'install-git-governance.mjs')])
}
process.stdout.write(`Capital Agent 已初始化。配置保存在 ${configFile}（0600），平台地址和 Key 未写入项目仓库。\n`)
