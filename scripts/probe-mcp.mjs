#!/usr/bin/env node
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const wrapper = join(dirname(fileURLToPath(import.meta.url)), 'mcp-remote.mjs')
const command = process.argv[2] || process.execPath
const args = process.argv.length > 3 ? process.argv.slice(3) : [wrapper]
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
let buffer = ''; let stderr = ''; let finished = false

function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`) }
function finish(ok, detail) {
  if (finished) return
  finished = true; clearTimeout(timer); child.kill('SIGTERM')
  process.stdout.write(`${JSON.stringify({ ok, detail, stderr: stderr.slice(-500) })}\n`)
  process.exitCode = ok ? 0 : 1
}

child.stderr.on('data', chunk => { stderr += String(chunk) })
child.stdout.on('data', chunk => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf('\n'); if (newline < 0) break
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
    if (!line.startsWith('{')) continue
    let message; try { message = JSON.parse(line) } catch { continue }
    if (message.id === 1 && message.result) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    } else if (message.id === 2) {
      const names = (message.result?.tools || []).map(item => item.name)
      finish(names.includes('create_or_attach_task') && names.includes('enrich_context'), `tools=${names.length}`)
    }
  }
})
child.on('error', error => finish(false, error.message))
child.on('exit', code => { if (!finished) finish(false, `proxy_exit_${code}`) })
const timer = setTimeout(() => finish(false, 'mcp_probe_timeout'), 12_000)
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'capital-agent-doctor', version: '1' } } })
