#!/usr/bin/env node
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function localConfig() {
  try {
    return Object.fromEntries(readFileSync(join(homedir(), '.config/capital-agent/env'), 'utf8').split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]))
  } catch { return {} }
}

const config = localConfig()
const serverUrl = String(process.env.CAPITAL_AGENT_SERVER_URL || config.CAPITAL_AGENT_SERVER_URL || '').trim().replace(/\/+$/, '')
const userKey = String(process.env.CAPITAL_AGENT_USER_KEY || config.CAPITAL_AGENT_USER_KEY || '').trim()

if (!serverUrl || !userKey) {
  process.stderr.write('缺少 CAPITAL_AGENT_SERVER_URL 或 CAPITAL_AGENT_USER_KEY。请只在研发本机环境变量中配置，不要写入项目仓库。\n')
  process.exit(1)
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const child = spawn(command, ['-y', 'mcp-remote', `${serverUrl}/api/mcp/message`, '--header', `x-user-key:${userKey}`], { stdio: 'inherit', env: process.env })
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
child.on('exit', code => process.exit(code ?? 1))
