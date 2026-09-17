#!/usr/bin/env node
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

function parseConfig(content = '') {
  return Object.fromEntries(String(content).split(/\r?\n/)
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map(match => [match[1], match[2]]))
}

export async function buildMcpHttpHeaders({ home = homedir(), env = process.env } = {}) {
  const content = await readFile(join(home, '.config', 'capital-agent', 'env'), 'utf8').catch(() => '')
  const config = parseConfig(content)
  // The installer-owned 0600 file is authoritative so a rotated key is not
  // shadowed by a stale environment inherited when the client first started.
  const userKey = String(config.CAPITAL_AGENT_USER_KEY || env.CAPITAL_AGENT_USER_KEY || '').trim()
  if (!userKey) throw new Error('missing CAPITAL_AGENT_USER_KEY')
  if (/\r|\n/.test(userKey)) throw new Error('invalid CAPITAL_AGENT_USER_KEY')
  return { 'x-user-key': userKey }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.stdout.write(`${JSON.stringify(await buildMcpHttpHeaders())}\n`)
  } catch {
    process.stderr.write('Capital Agent MCP identity is unavailable; rerun the team-mode installer.\n')
    process.exitCode = 1
  }
}
