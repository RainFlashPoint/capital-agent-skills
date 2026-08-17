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
const clientId = String(process.env.CAPITAL_AGENT_CLIENT_ID || config.CAPITAL_AGENT_CLIENT_ID || '').trim()
const dnsFallback = join(import.meta.dirname, 'node-dns-fallback.cjs')

if (!serverUrl || !userKey) {
  process.stderr.write('缺少 CAPITAL_AGENT_SERVER_URL 或 CAPITAL_AGENT_USER_KEY。请只在研发本机环境变量中配置，不要写入项目仓库。\n')
  process.exit(1)
}

await fetch(`${serverUrl}/api/auth/handshake`, {
  method: 'PUT',
  headers: { 'x-user-key': userKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientId, clientName: 'mcp-remote', clientVersion: '1', mcpReachable: true, capabilities: { transport: 'stdio-remote' } }),
  signal: AbortSignal.timeout(5000),
}).catch(() => null)

const proxy = join(homedir(), '.capital-agent', 'mcp-runtime', 'node_modules', 'mcp-remote', 'dist', 'proxy.js')
const nodeOptions = `${process.env.NODE_OPTIONS || ''} --require=${dnsFallback}`.trim()
const child = spawn(process.execPath, [proxy, `${serverUrl}/api/mcp/message`, '--header', 'x-user-key:${CAPITAL_AGENT_MCP_USER_KEY}'], {
  stdio: 'inherit',
  env: { ...process.env, CAPITAL_AGENT_SERVER_URL: serverUrl, CAPITAL_AGENT_MCP_USER_KEY: userKey, CAPITAL_AGENT_MCP_RUNTIME_DIR: join(homedir(), '.capital-agent', 'mcp-runtime'), NODE_OPTIONS: nodeOptions },
})
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
child.on('exit', code => process.exit(code ?? 1))
