import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createEnvelope, executeEnvelope } from './executor.mjs'
import { evaluateGate } from './gate.mjs'
import { readFileSync } from 'node:fs'
const executionModel = JSON.parse(readFileSync(new URL('../../ontology/execution.json', import.meta.url), 'utf8'))

const field = (text, name) => String(text).match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || ''
const git = (repo, args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() } catch { return '' } }

export async function buildLocalEnvelope(repoPath = '.', { action = 'test', command = [], constraints = [], secret, now = new Date().toISOString(), runner = 'local-runner', agent = 'local-agent', tenant = 'local', project = 'local' } = {}) {
  const repo = resolve(repoPath)
  const state = await readFile(join(repo, '.cap', 'STATE.md'), 'utf8').catch(() => '')
  const branch = git(repo, ['branch', '--show-current'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  const remote = git(repo, ['remote', 'get-url', 'origin']) || repo
  const task = field(state, 'task-id')
  if (!task || !branch || !commit) throw new Error('execution_local_task_identity_missing')
  if (!Array.isArray(command) || command.length === 0) throw new Error('execution_local_command_missing')
  const issued = new Date(now); const expires = new Date(issued.getTime() + 15 * 60 * 1000).toISOString()
  return createEnvelope({ task, repo: remote, branch, commit, tenant, project, agent, runner, action, command, allowedEnv: [], constraints, issuedAt: issued.toISOString(), expiresAt: expires }, secret)
}

export function executionContract(stage = '') {
  const contract = executionModel.stages[stage]
  if (!contract) throw new Error('execution_stage_contract_missing')
  return contract
}

export async function runLocalAction(repoPath = '.', options = {}) {
  const repo = resolve(repoPath)
  const contract = options.stage ? executionContract(options.stage) : null
  const envelope = await buildLocalEnvelope(repo, { ...options, action: options.action || contract?.action || 'test', constraints: options.constraints || contract?.constraints || [] })
  const result = await executeEnvelope(envelope, { ...options, cwd: repo, workspaceRoot: repo })
  const gate = evaluateGate(envelope, result.receipt, { envelopeSecret: options.secret, receiptSecret: options.receiptSecret || options.secret, now: new Date().toISOString() })
  const dir = join(repo, '.cap', 'execution', envelope.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`)
  await writeFile(join(dir, 'receipt.json'), `${JSON.stringify(result.receipt, null, 2)}\n`)
  await writeFile(join(dir, 'gate.json'), `${JSON.stringify(gate, null, 2)}\n`)
  return { envelope, receipt: result.receipt, gate, artifactDir: dir }
}
