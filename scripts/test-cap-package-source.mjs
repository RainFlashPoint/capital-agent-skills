import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function installation(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'cap-package-source-')))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const fixture = async (name, version) => {
    const pkg = join(temp, name)
    for (const path of ['skills/cap/scripts', 'skills/cap-flow', 'scripts', '.claude-plugin']) await mkdir(join(pkg, path), { recursive: true })
    for (const file of ['cap-package.mjs', '_forward.mjs', 'cap-status.mjs']) await copyFile(join(root, 'skills/cap/scripts', file), join(pkg, 'skills/cap/scripts', file))
    await copyFile(join(root, 'skills/cap/SKILL.md'), join(pkg, 'skills/cap/SKILL.md'))
    await writeFile(join(pkg, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'capital-agent-skills', version }))
    await writeFile(join(pkg, 'skills/cap-flow/SKILL.md'), `${name} protocol`)
    await writeFile(join(pkg, 'scripts/cap-status.mjs'), `console.log(JSON.stringify({source:${JSON.stringify(name)},args:process.argv.slice(2)}))\n`)
    return pkg
  }
  const current = await fixture('current', '1.0.0')
  const old = await fixture('old-worktree', '0.1.0')
  const installed = join(temp, '.agents/skills/cap')
  await mkdir(dirname(installed), { recursive: true })
  await symlink(join(current, 'skills/cap'), installed, 'dir')
  const run = (args, options = {}) => spawnSync(process.execPath, [...(options.nodeArgs || []), join(installed, 'scripts/cap-package.mjs'), ...args], {
    cwd: old,
    env: { ...process.env, CAPITAL_AGENT_SOURCE_ROOT: old },
    encoding: 'utf8',
  })
  return { current, old, installed, run }
}

test('only-public-cap symlink resolves the loaded package, not cwd or old clone', async t => {
  const { current, run } = await installation(t)
  const result = run(['resolve', 'skills/cap-flow/SKILL.md'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const resolved = JSON.parse(result.stdout)
  assert.equal(resolved.packageRoot, current)
  assert.equal(resolved.packageVersion, '1.0.0')
  assert.equal(resolved.resourcePath, join(current, 'skills/cap-flow/SKILL.md'))
  assert.match(resolved.resourceDigest, /^[a-f0-9]{64}$/)
  assert.equal(await readFile(resolved.resourcePath, 'utf8'), 'current protocol')
})

test('entrypoint remains anchored when Node preserves main symlinks', async t => {
  const { current, run } = await installation(t)
  const result = run(['resolve', 'skills/cap-flow/SKILL.md'], { nodeArgs: ['--preserve-symlinks-main'] })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(JSON.parse(result.stdout).packageRoot, current)
})

test('run and compatibility entrypoints execute only current-package scripts', async t => {
  const { installed, old, run } = await installation(t)
  const direct = run(['run', 'scripts/cap-status.mjs', 'repo with spaces', '--compact'])
  assert.equal(direct.status, 0, direct.stdout + direct.stderr)
  assert.deepEqual(JSON.parse(direct.stdout), { source: 'current', args: ['repo with spaces', '--compact'] })
  const wrapper = spawnSync(process.execPath, [join(installed, 'scripts/cap-status.mjs'), 'repo', '--compact'], { cwd: old, encoding: 'utf8' })
  assert.equal(wrapper.status, 0, wrapper.stdout + wrapper.stderr)
  assert.deepEqual(JSON.parse(wrapper.stdout), { source: 'current', args: ['repo', '--compact'] })
})

test('missing current resource never falls back to a valid old worktree', async t => {
  const { current, run } = await installation(t)
  await unlink(join(current, 'skills/cap-flow/SKILL.md'))
  const result = run(['resolve', 'skills/cap-flow/SKILL.md'])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).reason, 'cap_package_resource_missing')
  await unlink(join(current, 'scripts/cap-status.mjs'))
  const execute = run(['run', 'scripts/cap-status.mjs'])
  assert.equal(execute.status, 1)
  assert.equal(JSON.parse(execute.stdout).reason, 'cap_package_resource_missing')
})

test('cross-package symlinks and escaping resource paths are rejected', async t => {
  const { current, old, run } = await installation(t)
  const resource = join(current, 'skills/cap-flow/SKILL.md')
  await unlink(resource)
  await symlink(join(old, 'skills/cap-flow/SKILL.md'), resource)
  const linked = run(['resolve', 'skills/cap-flow/SKILL.md'])
  assert.equal(linked.status, 1)
  assert.equal(JSON.parse(linked.stdout).reason, 'cap_resource_source_mismatch')
  for (const path of ['../old-worktree/skills/cap-flow/SKILL.md', join(old, 'skills/cap-flow/SKILL.md'), 'skills/../scripts/cap-status.mjs']) {
    const result = run(['resolve', path])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).reason, 'cap_resource_path_invalid')
  }
})

test('a broken package identity fails rather than searching another clone', async t => {
  const { current, run } = await installation(t)
  await writeFile(join(current, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'other-package', version: '1.0.0' }))
  const result = run(['resolve', 'skills/cap-flow/SKILL.md'])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).reason, 'cap_package_invalid')
})

test('public instructions expose same-source resolution and visible recovery', async () => {
  const skill = await readFile(join(root, 'skills/cap/SKILL.md'), 'utf8')
  assert.doesNotMatch(skill, /\.\.\/cap-(?:flow|implement|release)/)
  assert.match(skill, /cap-package\.mjs resolve skills\/cap-flow\/SKILL\.md/)
  assert.match(skill, /禁止递归搜索其他 clone\/worktree/)
  assert.match(skill, /恢复必须先于继续读取业务代码/)
  assert.match(skill, /cap-context-checkpoint\.mjs resume <repo> --event/)
  assert.match(skill, /没有可信压缩回调时不能承诺每次自动监听/)
})
