import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCap, migrateLegacy } from '../runtime/ontology/import.mjs'
const scope={tenant:'alpha',project:'pay',provider:'bank-a',product:'repay',contractVersion:'1',environment:'test'}
async function fixture(t,state) { const root=await mkdtemp(join(tmpdir(),'cap ontology '));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'.cap'));await writeFile(join(root,'.cap/STATE.md'),state);return root }
test('O10: import actual STATE with hashes and keep PASS as claim',async t=>{
 const root=await fixture(t,`task-id: t1\nstage: review\nstatus: in-progress\nbranch: feature-a\nsource-commit: ${'a'.repeat(40)}\n`)
 await mkdir(join(root,'.cap/verify'));await writeFile(join(root,'.cap/verify/check.md'),'status: PASS\npassword=never-project-this\n')
 const task=await importCap(root,{scope,repo:'repo-a'})
 assert.equal(task.stage,'review');assert.equal(task.claims[0].status,'PASS');assert.ok(task.artifacts.every(a=>a.hash.length===64))
 assert.ok(!JSON.stringify(task).includes('never-project-this'))
})
test('O10: reject symlink evidence escape',async t=>{
 const root=await fixture(t,'stage: test');await mkdir(join(root,'.cap/verify'));await symlink('/etc/hosts',join(root,'.cap/verify/x.md'))
 await assert.rejects(importCap(root,{scope,repo:'repo-a'}),/symlink/)
})
test('O10: conflicting field is unknown rather than last-write-wins',async t=>{
 const root=await fixture(t,'stage: test\nstage: done\nstatus: done')
 const task=await importCap(root,{scope,repo:'repo-a'});assert.equal(task.stage,null);assert.ok(task.unknowns.includes('ambiguous_stage'))
})
test('O11: reject future schema and do not guess legacy commit',()=>{
 assert.throws(()=>migrateLegacy({schemaVersion:2}, {scope,repo:'repo-a'}),/unsupported/)
 const task=migrateLegacy({stage:'verify',status:'development-complete'}, {scope,repo:'repo-a'})
 assert.equal(task.stage,'test');assert.equal(task.commit,null);assert.ok(task.unknowns.length)
})

test('O10: source mutation is detected by a changed artifact hash',async t=>{
 const root=await fixture(t,'stage: test\nstatus: in-progress\ntask-id: t1\nbranch: f\n')
 const a=await importCap(root,{scope,repo:'repo-a'});await writeFile(join(root,'.cap/STATE.md'),'stage: review\nstatus: in-progress\ntask-id: t1\nbranch: f\n')
 const b=await importCap(root,{scope,repo:'repo-a'});assert.notEqual(a.artifacts[0].hash,b.artifacts[0].hash);assert.equal(b.stage,'review')
})
test('O10: oversized document rejected; unrelated history not traversed',async t=>{
 const root=await fixture(t,'stage: test');await mkdir(join(root,'.cap/history'));await symlink('/etc/hosts',join(root,'.cap/history/hidden'))
 assert.equal((await importCap(root,{scope,repo:'repo-a'})).stage,'test')
 await writeFile(join(root,'.cap/spec.md'),'x'.repeat(256*1024+1));await assert.rejects(importCap(root,{scope,repo:'repo-a'}),/size_limit/)
})
test('O10: detect stale context without turning base commit into candidate',async t=>{
 const root=await fixture(t,`stage: test\nbase-commit: ${'a'.repeat(40)}\nbranch: f\n`)
 await writeFile(join(root,'.cap/task-context.md'),`- head: ${'b'.repeat(40)}\n`)
 const result=await importCap(root,{scope,repo:'repo-a',expectedCommit:'a'.repeat(40),expectedBranch:'f'})
 assert.equal(result.commit,null);assert.ok(result.blockers.includes('context_commit_mismatch'));assert.ok(result.blockers.includes('candidate_commit_unconfirmed'))
})
test('O11: schema v1 migration is identity and does not mutate source',()=>{
 const v=migrateLegacy({stage:'test'},{scope,repo:'repo-a'});const before=JSON.stringify(v);assert.deepEqual(migrateLegacy(v,{scope,repo:'repo-a'}),v);assert.equal(JSON.stringify(v),before)
})

test('O11: migration cannot relabel a v1 instance as another tenant',()=>{
 const v=migrateLegacy({stage:'test'},{scope,repo:'repo-a'})
 assert.throws(()=>migrateLegacy(v,{scope:{...scope,tenant:'beta'},repo:'repo-a'}),/scope_mismatch/)
})
