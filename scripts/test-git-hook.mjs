import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const run = (cwd, command, args) => execFileSync(command, args, { cwd, encoding: 'utf8' })

test('project hook preserves existing hook and appends task metadata without blocking commit style', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-hook-'))
  run(repo, 'git', ['init', '-b', 'main'])
  run(repo, 'git', ['config', 'user.name', 'test'])
  run(repo, 'git', ['config', 'user.email', 'test@example.com'])
  const hooks = join(repo, '.git/hooks'); await mkdir(hooks, { recursive: true })
  const original = join(hooks, 'prepare-commit-msg')
  await writeFile(original, '#!/bin/sh\nprintf original > .original-hook-ran\n'); await chmod(original, 0o755)
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_demo123\nsession-id: session_demo456\n')
  await writeFile(join(repo, 'sample.txt'), 'ok\n')
  run(repo, 'git', ['add', 'sample.txt'])
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  run(repo, 'git', ['commit', '-m', 'small change'])
  const message = run(repo, 'git', ['log', '-1', '--pretty=%B'])
  assert.match(message, /Task: task_demo123/)
  assert.match(message, /Session: session_demo456/)
  assert.equal(await readFile(join(repo, '.original-hook-ran'), 'utf8'), 'original')
})
