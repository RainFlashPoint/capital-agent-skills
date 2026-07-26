#!/usr/bin/env node
import { execFileSync } from 'child_process'
import { readFile } from 'fs/promises'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { checkPlatformHandshake } from './setup-lib.mjs'

function git(args) { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
function parseConfig(raw) { return Object.fromEntries(String(raw).split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]])) }

const raw = await readFile(join(homedir(), '.config/capital-agent/env'), 'utf8').catch(() => '')
const config = parseConfig(raw)
const serverUrl = String(process.env.CAPITAL_AGENT_SERVER_URL || config.CAPITAL_AGENT_SERVER_URL || '').trim().replace(/\/+$/, '')
const userKey = String(process.env.CAPITAL_AGENT_USER_KEY || config.CAPITAL_AGENT_USER_KEY || '').trim()
const clientId = String(process.env.CAPITAL_AGENT_CLIENT_ID || config.CAPITAL_AGENT_CLIENT_ID || '').trim()
const payload = {
  clientId,
  clientName: hostname(),
  clientVersion: 'cap-handshake/1',
  repoUrl: git(['remote', 'get-url', 'origin']) || process.cwd(),
  branch: git(['branch', '--show-current']),
  mcpReachable: true,
  capabilities: { taskWrite: true, commitReconcile: true, skillSession: true },
}
const result = await checkPlatformHandshake(serverUrl, userKey, fetch, payload)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.ok) process.exitCode = 1
