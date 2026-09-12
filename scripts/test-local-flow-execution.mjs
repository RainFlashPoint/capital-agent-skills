import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runLocalAction } from '../runtime/execution/local-flow.mjs'

const secret = 'local-flow-test-secret-long-enough'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cap-flow-execution-'))
  execFileSync('git', ['init', '-q'], { cwd:root }); execFileSync('git', ['config','user.email','test@example.invalid'], { cwd:root }); execFileSync('git', ['config','user.name','test'], { cwd:root })
  await mkdir(join(root, '.cap'), { recursive:true }); await writeFile(join(root, '.cap','STATE.md'), 'stage: implement\nstatus: in-progress\ntask-id: task-local-flow\n')
  await writeFile(join(root, 'README.md'), 'fixture\n'); execFileSync('git', ['add','.'], { cwd:root }); execFileSync('git', ['commit','-qm','fixture'], { cwd:root })
  return root
}

test('local flow creates bound artifacts and PASS gate', async () => {
  const root = await fixture()
  try { const result = await runLocalAction(root, { secret, action:'test', command:['node','-e','process.stdout.write("local-pass")'] }); assert.equal(result.gate.gate, 'PASS'); assert.match(await readFile(join(result.artifactDir,'gate.json'),'utf8'), /PASS/) } finally { await rm(root, { recursive:true, force:true }) }
})

test('local flow fails closed for command failure', async () => {
  const root = await fixture()
  try { const result = await runLocalAction(root, { secret, action:'test', command:['node','-e','process.exit(3)'] }); assert.equal(result.gate.gate, 'BLOCKED'); assert.ok(result.gate.blockers.includes('execution_failed')) } finally { await rm(root, { recursive:true, force:true }) }
})
