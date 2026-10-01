import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = name => join(root, 'skills', 'cap', 'scripts', name)

test('cap status compatibility entrypoint executes the package CLI', () => {
  const result = spawnSync(process.execPath, [entry('cap-status.mjs'), root, '--compact', '--mcp-runtime', 'missing'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  })
  assert.equal(result.status, 0, result.stderr)
  const status = JSON.parse(result.stdout)
  assert.equal(status.repository.root, root)
  assert.equal(status.mode, 'local_explicit')
})

test('cap task request compatibility entrypoint forwards stdin and stdout', () => {
  const result = spawnSync(process.execPath, [entry('cap-task-request.mjs')], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({ title: 'path fix', requirementText: 'keep token=secret local' }),
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.title, 'path fix')
  assert.match(output.requirementText, /token=\[仅本地配置\]/)
})
