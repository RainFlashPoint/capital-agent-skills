#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_KEYS = [
  ['capital-agent', 'CAPITAL_AGENT_RUNTIME_SESSION_ID'],
  ['codex-thread', 'CODEX_THREAD_ID'],
  ['codex-session', 'CODEX_SESSION_ID'],
  ['claude-session', 'CLAUDE_CODE_SESSION_ID'],
]

function gitRoot(candidate = '.') {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: resolve(candidate),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  return root
}

async function canonicalGitRoot(candidate = '.') {
  return realpath(gitRoot(candidate))
}

function sessionIdentity(environment = {}) {
  for (const [kind, name] of SESSION_KEYS) {
    const value = String(environment[name] || '').trim()
    if (value) return { kind, value }
  }
  return null
}

function defaultRegistryRoot(environment = {}) {
  return resolve(String(environment.CAPITAL_AGENT_SESSION_LOCK_DIR || join(tmpdir(), 'capital-agent', 'session-roots')))
}

async function ensureSafeRegistry(registryRoot) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 })
  const info = await lstat(registryRoot)
  if (info.isSymbolicLink()) throw new Error('session_root_registry_symlink')
  if (!info.isDirectory()) throw new Error('session_root_registry_not_directory')
  return realpath(registryRoot)
}

async function writeLockOnce(path, payload) {
  const temp = join(resolve(path, '..'), `.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temp, path)
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return false
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function readLock(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('session_root_lock_unsafe_type')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed?.schema !== 1 || typeof parsed?.root !== 'string' || !parsed.root) throw new Error('session_root_lock_invalid')
  return parsed
}

export async function inspectSessionRoot({ repoRoot = '.', environment = {}, registryRoot = '', capture = true, requireExisting = false } = {}) {
  const currentRoot = await canonicalGitRoot(repoRoot)
  const identity = sessionIdentity(environment)
  if (!identity) {
    return { enforced: false, blocked: false, code: '', reason: 'session_identity_unavailable', currentRoot }
  }

  const registry = await ensureSafeRegistry(resolve(registryRoot || defaultRegistryRoot(environment)))
  const identityHash = createHash('sha256').update(`${identity.kind}:${identity.value}`).digest('hex')
  const lockPath = join(registry, `${identityHash}.json`)
  let created = false
  try {
    await lstat(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (!capture) {
      return {
        enforced: true,
        blocked: requireExisting,
        code: requireExisting ? 'session_root_uninitialized' : '',
        reason: 'session_root_uninitialized',
        currentRoot,
      }
    }
    created = await writeLockOnce(lockPath, { schema: 1, kind: identity.kind, root: currentRoot })
  }

  const lock = await readLock(lockPath)
  const expectedRoot = await realpath(lock.root).catch(() => resolve(lock.root))
  const blocked = expectedRoot !== currentRoot
  return {
    enforced: true,
    blocked,
    code: blocked ? 'session_root_mismatch' : '',
    reason: blocked ? '当前命令目标仓库与本会话首次锁定仓库不一致' : 'session_root_verified',
    expectedRoot,
    currentRoot,
    created,
  }
}

function render(result) {
  if (!result.enforced) return 'cap-session-root: SKIP — 当前宿主没有稳定会话 ID，沿用仓库 STATE 边界守卫'
  if (result.blocked) {
    if (result.code === 'session_root_uninitialized') return 'cap-session-root: BLOCKED — 本会话尚未锁定启动仓库；先从用户当前打开的仓库运行 cap-status'
    return `cap-session-root: BLOCKED — 本会话锁定 ${result.expectedRoot}，拒绝切换到 ${result.currentRoot}`
  }
  return `cap-session-root: PASS — ${result.currentRoot}`
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [command = 'capture', repoRoot = '.'] = process.argv.slice(2)
  if (!['capture', 'verify'].includes(command)) throw new Error(`unknown command: ${command}`)
  const result = await inspectSessionRoot({
    repoRoot,
    environment: process.env,
    capture: command === 'capture',
    requireExisting: command === 'verify',
  })
  process.stdout.write(`${render(result)}\n`)
  if (result.blocked) process.exitCode = 2
}
