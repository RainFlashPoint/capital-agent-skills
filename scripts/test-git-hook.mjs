import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const run = (cwd, command, args) => execFileSync(command, args, { cwd, encoding: 'utf8' })
const runPrePush = (repo, branch, state = '') => {
  const hook = join(root, 'skills/cap-flow/references/templates/hooks/pre-push')
  if (state) {
    mkdirSync(join(repo, '.cap'), { recursive: true })
    writeFileSync(join(repo, '.cap/STATE.md'), state)
  }
  const sha = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  return execFileSync('sh', [hook], { cwd: repo, input: `refs/heads/${branch} ${sha} refs/heads/${branch} 0000000000000000000000000000000000000000\n`, encoding: 'utf8' })
}

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
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  run(repo, 'git', ['add', 'sample.txt', '.cap'])
  run(repo, 'git', ['commit', '-m', 'small change'])
  const message = run(repo, 'git', ['log', '-1', '--pretty=%B'])
  assert.match(message, /Task: task_demo123/)
  assert.match(message, /Session: session_demo456/)
  assert.equal(await readFile(join(repo, '.original-hook-ran'), 'utf8'), 'original')
})

test('governance installer refreshes an opted-in Capital Agent pre-push hook', async () => {
  const repo = await fixtureRepo('cap-hook-refresh-')
  const hooks = join(repo, '.git/hooks')
  await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\n# cap-flow pre-push 检查\necho old\n')
  await chmod(join(hooks, 'pre-push'), 0o755)
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  const refreshed = await readFile(join(hooks, 'pre-push'), 'utf8')
  assert.match(refreshed, /开发\/测试分支允许先交付代码/)
  assert.doesNotMatch(refreshed, /echo old/)
})

test('project hook blocks code commit when cap delivery artifacts are not staged', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cap-hook-artifacts-'))
  run(repo, 'git', ['init', '-b', 'main'])
  run(repo, 'git', ['config', 'user.name', 'test'])
  run(repo, 'git', ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap'), { recursive: true })
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_demo123\nsession-id: session_demo456\n')
  await writeFile(join(repo, '.cap/spec.md'), '# spec\n')
  await writeFile(join(repo, 'sample.txt'), 'ok\n')
  run(repo, 'git', ['add', 'sample.txt'])
  run(repo, process.execPath, [join(root, 'scripts/install-git-governance.mjs')])
  assert.throws(() => run(repo, 'git', ['commit', '-m', 'small change']), /\.cap 研发产物/)
})

test('pre-push allows development branch while environment verification is pending', async () => {
  const repo = await fixtureRepo('cap-pre-push-dev-')
  const output = runPrePush(repo, 'feature/example', 'task-id: task_demo\nstatus: gated\ndelivery-status: ENV_PENDING\ncap-gate: BLOCK\n')
  assert.match(output, /开发\/测试分支代码交付放行/)
})

test('pre-push blocks protected branch without a complete review gate', async () => {
  const repo = await fixtureRepo('cap-pre-push-main-')
  const state = 'task-id: task_demo\nstatus: gated\ndelivery-status: ENV_PENDING\ncap-gate: BLOCK\n'
  mkdirSync(join(repo, '.cap'), { recursive: true })
  writeFileSync(join(repo, '.cap/STATE.md'), state)
  const sha = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const result = spawnSync('sh', [join(root, 'skills/cap-flow/references/templates/hooks/pre-push')], {
    cwd: repo,
    input: `refs/heads/main ${sha} refs/heads/main 0000000000000000000000000000000000000000\n`,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}${result.stderr}`, /受保护分支/)
})

async function fixtureRepo(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  run(repo, 'git', ['init', '-b', 'main'])
  run(repo, 'git', ['config', 'user.name', 'test'])
  run(repo, 'git', ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'sample.txt'), 'ok\n')
  run(repo, 'git', ['add', 'sample.txt'])
  run(repo, 'git', ['commit', '-m', 'fixture'])
  return repo
}
