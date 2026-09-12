import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { verifyEnvelope, validateEnvelope, evidenceDigest, receiptSignature, signEnvelope } from './protocol.mjs'
const execFileAsync = promisify(execFile)

const SAFE_COMMANDS = new Set(['node','npm','pnpm','yarn','python3','pytest','go','mvn','gradle'])
const hash = value => createHash('sha256').update(String(value ?? '')).digest('hex')

export async function executeEnvelope(envelope, { secret, receiptSecret = secret, cwd = process.cwd(), workspaceRoot = process.cwd(), now = new Date().toISOString(), timeoutMs = 120000, env = process.env } = {}) {
  verifyEnvelope(envelope, secret, now)
  if (!SAFE_COMMANDS.has(envelope.command[0])) throw new Error('execution_command_not_allowlisted')
  const root = resolve(workspaceRoot); const workdir = resolve(cwd)
  if (workdir !== root && !workdir.startsWith(`${root}/`)) throw new Error('execution_workspace_escape')
  const start = new Date(now).toISOString()
  let stdout = '', stderr = '', exitCode = 1, status = 'failed'
  try {
    const selectedEnv = Object.fromEntries(envelope.allowedEnv.map(key => [key, env[key]]).filter(([, value]) => value !== undefined))
    const result = await execFileAsync(envelope.command[0], envelope.command.slice(1), { cwd: workdir, env: { PATH: env.PATH, ...selectedEnv }, timeout: timeoutMs, maxBuffer: 1024 * 1024 })
    stdout = result.stdout || ''; stderr = result.stderr || ''; exitCode = 0; status = 'passed'
  } catch (error) {
    stdout = error.stdout || ''; stderr = error.stderr || ''; exitCode = Number.isInteger(error.code) ? error.code : 124
    status = error.killed ? 'timed_out' : 'failed'
  }
  const finished = new Date().toISOString()
  const evidence = { schemaVersion: 1, envelopeId: envelope.id, task: envelope.task, repo: envelope.repo, branch: envelope.branch, commit: envelope.commit, runner: envelope.runner, startedAt: start, finishedAt: finished, exitCode, status, stdoutHash: hash(stdout), stderrHash: hash(stderr), commandHash: hash(JSON.stringify(envelope.command)), constraints: envelope.constraints }
  const receipt = { ...evidence, authority: 'trusted-executor', evidenceHash: evidenceDigest(evidence), evidence, signature: '' }
  receipt.signature = receiptSignature(receipt, receiptSecret)
  return { receipt, stdout, stderr }
}

export function createEnvelope(input, secret) {
  const envelope = { schemaVersion: 1, id: input.id || `action-${randomUUID()}`, ...input, authorization: { keyId: input.keyId || 'local-server' } }
  validateEnvelope({ ...envelope, authorization: { ...envelope.authorization, signature: '0'.repeat(64) } })
  envelope.authorization.signature = signEnvelope(envelope, secret)
  return envelope
}
