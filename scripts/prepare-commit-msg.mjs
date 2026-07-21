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
const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const stagedFiles = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .split(/\r?\n/).map(item => item.trim()).filter(Boolean)
const stagedCode = stagedFiles.some(item => !item.startsWith('.cap/'))
if (stagedCode) {
  let stateIgnored = false
  try { git(['check-ignore', '-q', '.cap/STATE.md']); stateIgnored = true } catch {}
  if (stateIgnored) {
    process.stderr.write('✗ cap: .cap/STATE.md 被 Git ignore/exclude，研发产物无法随代码交付。\n  请从 .gitignore 或 .git/info/exclude 移除 .cap 规则后，执行 git add .cap。\n')
    process.exit(1)
  }
  const pendingCap = git(['status', '--porcelain', '--untracked-files=all', '--', '.cap'])
    .split(/\r?\n/).filter(Boolean)
    .filter(item => item.startsWith('??') || item[1] !== ' ')
  if (pendingCap.length > 0) {
    process.stderr.write(`✗ cap: 本次提交包含代码，但仍有未暂存的 .cap 研发产物：\n${pendingCap.map(item => `  ${item}`).join('\n')}\n  请执行 git add .cap，把规格、计划、验证和评审证据与代码一起提交。\n`)
    process.exit(1)
  }
}
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
