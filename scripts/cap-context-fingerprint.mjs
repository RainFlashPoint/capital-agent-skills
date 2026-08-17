#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const digest = value => createHash('sha256').update(value).digest('hex')

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repo, ...args], { encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
}

async function untrackedFingerprint(repo) {
  const raw = git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).cap/**'], 'buffer')
  const paths = raw.toString('utf8').split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    const absolute = resolve(repo, path)
    const stat = await lstat(absolute)
    hash.update(path).update('\0')
    if (stat.isSymbolicLink()) hash.update('symlink\0').update(await readlink(absolute))
    else hash.update('file\0').update(await readFile(absolute))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function inspectContextFingerprint(repoPath = '.') {
  const requested = resolve(repoPath)
  const root = await realpath(String(git(requested, ['rev-parse', '--show-toplevel'])).trim())
  const indexPatch = git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--', '.', ':(exclude).cap/**'], 'buffer')
  const worktreePatch = git(root, ['diff', '--binary', '--no-ext-diff', '--', '.', ':(exclude).cap/**'], 'buffer')
  return {
    root,
    index: digest(indexPatch),
    worktree: digest(worktreePatch),
    untracked: await untrackedFingerprint(root),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await inspectContextFingerprint(process.argv[2] || '.')
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`${result.index} ${result.worktree} ${result.untracked}\n`)
}
