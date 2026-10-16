import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('public local end-to-end fixture exercises current, remote update and dirty safety states', () => {
  const output = execFileSync(process.execPath, [join(root, 'examples/e2e-local/run.mjs')], { cwd: root, encoding: 'utf8' })
  const result = JSON.parse(output)
  assert.equal(result.valid, true)
  assert.deepEqual(result.states, ['current', 'remote_update_available', 'working_tree_modified'])
})
