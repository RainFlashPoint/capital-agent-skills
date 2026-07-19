#!/usr/bin/env node
import { readFile, appendFile } from 'fs/promises'
import { resolve } from 'path'
import { execFileSync } from 'child_process'

const messageFile = process.argv[2]
const source = String(process.argv[3] || '')
if (!messageFile || ['merge', 'squash', 'commit'].includes(source)) process.exit(0)
let repoRoot = ''
try { repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() } catch { process.exit(0) }
const state = await readFile(resolve(repoRoot, '.cap/STATE.md'), 'utf8').catch(() => '')
if (!state) process.exit(0)
const value = names => {
  for (const name of names) {
    const match = state.match(new RegExp(`^\\s*${name}\\s*:\\s*([^\\s#]+)`, 'im'))
    if (match?.[1]) return match[1].trim()
  }
  return ''
}
const taskId = value(['task-id', 'task_id'])
const sessionId = value(['session-id', 'session_id'])
if (taskId && !/^task_[a-zA-Z0-9_-]+$/.test(taskId)) process.exit(0)
const message = await readFile(messageFile, 'utf8').catch(() => '')
const lines = []
if (taskId && !/^Task\s*:/im.test(message)) lines.push(`Task: ${taskId}`)
if (sessionId && !/^Session\s*:/im.test(message)) lines.push(`Session: ${sessionId}`)
if (lines.length) await appendFile(messageFile, `\n${lines.join('\n')}\n`)
