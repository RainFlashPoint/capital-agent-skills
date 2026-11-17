import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runLocalAction, inspectLocalExecution, executionNextActions } from '../runtime/execution/local-flow.mjs'
import { commandFor, validateExecutionModel, contractModel } from '../runtime/execution/local-support.mjs'
import { createTestImpact, freezeTestCandidate, inspectTestState } from '../runtime/execution/test-state.mjs'
import { captureTaskBaseline } from './cap-worktree-baseline.mjs'

const audit=fileURLToPath(new URL('../runtime/execution/contract-audit.mjs',import.meta.url))
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const main=[process.execPath,'-e','process.stdout.write("main")']
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'contract-guard-'));t.after(()=>rm(root,{recursive:true,force:true}))
 git(root,'init','-q');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Fixture')
 await writeFile(join(root,'.gitignore'),'.cap/\n');await writeFile(join(root,'source.txt'),'base\n')
 git(root,'add','.');git(root,'commit','-qm','base');const base=git(root,'rev-parse','HEAD')
 await captureTaskBaseline(root,'task-guard')
 await writeFile(join(root,'source.txt'),'feature\n');git(root,'add','.');git(root,'commit','-qm','feature')
 await mkdir(join(root,'.cap'),{recursive:true});await writeFile(join(root,'.cap/STATE.md'),`stage: test\nstatus: in-progress\ntask-id: task-guard\nsession-id: session-guard\nbranch: ${git(root,'branch','--show-current')}\nbase-commit: ${base}\nworktree: ${root}\nexecution-required: true\n`)
 return root
}
async function file(root,path,text){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text)}
function scan(root,mode='diff') {const p=spawnSync(process.execPath,[audit,'--repo',root,'--mode',mode],{encoding:'utf8'});assert.ok(p.stdout,p.stderr);return {code:p.status,...JSON.parse(p.stdout)}}
async function run(root,{guard,command=main,id,full=false}={}) {
 if(guard)await writeFile(join(root,'.cap/execution-config.json'),JSON.stringify({schemaVersion:1,commands:{'contract-guard':guard}}))
 const fullCommand=[...command,'full-suite']
 await createTestImpact(root,{changedFiles:['source.txt'],activeChecks:['logic'],targetedCommands:[command],fullCommand})
 const targeted=await runLocalAction(root,{environment:{},stage:'test',testScope:'targeted',command,...(id?{id}:{})})
 if(!full)return targeted
 await freezeTestCandidate(root)
 return runLocalAction(root,{environment:{},stage:'test',testScope:'full',command:fullCommand,...(id?{id:id+'-full'}:{})})
}

test('unwired added and renamed contracts are rejected, including untracked paths with spaces',async t=>{
 const root=await fixture(t);await file(root,'docs/contracts/new contract.schema.json','{}')
 const a=scan(root);assert.equal(a.code,1);assert.equal(a.failures[0].code,'contract_not_wired')
 git(root,'add','docs');assert.equal(scan(root).code,1)
})
test('production references wire a new contract; test-only references do not',async t=>{
 const root=await fixture(t);await file(root,'docs/contracts/evidence-v1.schema.json','{}')
 await file(root,'scripts/test-evidence.mjs','const schema="evidence-v1.schema.json"')
 assert.equal(scan(root).code,1)
 await file(root,'src/validator.mjs','import schema from "../docs/contracts/evidence-v1.schema.json" with { type: "json" }')
 assert.equal(scan(root).code,0)
})
test('new opt-in safety checks fail; test files and ordinary feature flags are excluded',async t=>{
 const root=await fixture(t)
 await file(root,'src/gate.mjs','if (input.enforceX === true) check()\n')
 assert.ok(scan(root).failures.some(f=>f.code==='safety_opt_in'))
 await file(root,'src/gate.mjs','check()\n')
 await file(root,'test/gate.mjs','if (input.enforceX === true) check()\n')
 await file(root,'src/theme.mjs','if (input.darkMode === true) render()\n')
 assert.equal(scan(root).code,0)
})
test('diff does not block legacy modifications; full inventory finds committed unwired contracts',async t=>{
 const root=await fixture(t);await file(root,'docs/contracts/old.schema.json','{}');git(root,'add','.');git(root,'commit','-qm','legacy')
 await file(root,'docs/contracts/old.schema.json','{"changed":true}')
 assert.equal(scan(root).code,0);assert.equal(scan(root,'full').code,1)
})
test('unknown audit mode or invalid repository cannot yield PASS',async t=>{
 const root=await fixture(t);assert.notEqual(scan(root,'anything').code,0)
 assert.notEqual(scan(join(root,'absent')).code,0)
})
test('explicit main argv still selects the builtin guard; unknown constraints are rejected',async t=>{
 const root=await fixture(t);const selected=await commandFor(root,'test',main,'test')
 assert.equal(selected.guard.source,'builtin');assert.ok(selected.guard.argv.includes(audit))
 const invalid=structuredClone(contractModel);invalid.stages.test.constraints.push('not-enforced')
 assert.throws(()=>validateExecutionModel(invalid),/execution_constraint_without_enforcer/)
})
test('guard failure AND successful main remains blocked after pointer inspection',async t=>{
 const root=await fixture(t);const r=await run(root,{guard:[process.execPath,'-e','process.exit(4)']})
 assert.equal(r.receipt.exitCode,0);assert.equal(r.gate.passed,false);assert.equal(r.gate.guard.passed,false)
 const pointer=JSON.parse(await readFile(join(root,'.cap/execution/latest-test.json'),'utf8'))
 assert.equal(pointer.guard.gate,'BLOCKED');assert.equal((await inspectLocalExecution(root)).reason,'execution_guard_failed')
})
test('successful guard AND failing main stays blocked',async t=>{
 const root=await fixture(t);const r=await run(root,{guard:[process.execPath,'-e','process.exit(0)'],command:[process.execPath,'-e','process.exit(3)']})
 assert.equal(r.gate.guard.passed,true);assert.equal(r.gate.passed,false)
 assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('guard precedes explicit main and extra metadata is covered by evidence hashes',async t=>{
 const root=await fixture(t)
 const guard=[process.execPath,'-e','require("fs").writeFileSync(".cap/order","guard")']
 const command=[process.execPath,'-e','if(require("fs").readFileSync(".cap/order","utf8")!=="guard")process.exit(8)']
 const r=await run(root,{guard,command,id:'explicit-main',full:true})
 assert.equal(r.gate.passed,true);assert.equal((await inspectLocalExecution(root)).passed,true)
 const pointer=JSON.parse(await readFile(join(root,'.cap/execution/latest-test.json'),'utf8'))
 assert.notEqual(pointer.guard.id,r.envelope.id)
 const g=JSON.parse(await readFile(join(root,'.cap/execution',pointer.guard.id,'gate.json'),'utf8'))
 assert.equal(g.envelope.kind,'guard');assert.equal(g.envelope.guardOf,r.envelope.id)
 g.envelope.kind='tampered';await writeFile(join(root,'.cap/execution',pointer.guard.id,'gate.json'),JSON.stringify(g))
 assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('missing guard pointer fails distinctly and cannot be disabled by request options',async t=>{
 const root=await fixture(t);const r=await run(root)
 assert.equal(r.gate.guard.source,'builtin')
 const path=join(root,'.cap/execution/latest-test.json'),p=JSON.parse(await readFile(path,'utf8'));delete p.guard;await writeFile(path,JSON.stringify(p))
 const status=await inspectLocalExecution(root);assert.equal(status.reason,'execution_guard_missing');assert.equal(status.passed,false)
 assert.equal(executionNextActions(status.reason)[0].kind,'run_contract_guard')
})
test('PROFILE reasoned exemption is recorded, bare none and malformed config fail closed',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { contract-guard: "none — legacy migration inventory" }\n')
 const r=await run(root,{full:true});assert.equal(r.gate.guard.disabled,true);assert.equal(r.gate.guard.source,'.cap/PROFILE.md#contract-guard')
 assert.equal((await inspectLocalExecution(root)).passed,true)
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { contract-guard: "none" }\n')
 await assert.rejects(commandFor(root,'test',main,'test'),/execution_guard_exemption_reason_required/)
})
test('forged PASS summary cannot hide failed guard artifacts or substitute another main guard',async t=>{
 const root=await fixture(t);await run(root,{guard:[process.execPath,'-e','process.exit(6)']})
 const path=join(root,'.cap/execution/latest-test.json'),p=JSON.parse(await readFile(path,'utf8'));p.guard.gate='PASS';await writeFile(path,JSON.stringify(p))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_guard_failed')
})
test('request opt-outs cannot suppress the builtin guard',async t=>{
 const root=await fixture(t)
 await createTestImpact(root,{changedFiles:['source.txt'],activeChecks:['logic'],targetedCommands:[main],fullCommand:[...main,'full-suite']})
 const r=await runLocalAction(root,{environment:{},stage:'test',testScope:'targeted',command:main,guard:false,skipGuard:true,enforcePreflight:false})
 assert.equal(r.gate.guard.source,'builtin');assert.equal(r.guardRun.envelope.kind,'guard')
})
test('targeted guard can pass while full guard fails without promoting terminal state',async t=>{
 const root=await fixture(t)
 const guard=[process.execPath,'-e','const fs=require("fs"),p=".cap/guard-count";const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));process.exit(n?5:0)']
 const r=await run(root,{guard,full:true})
 assert.equal(r.receipt.exitCode,0);assert.equal(r.gate.passed,false)
 assert.equal(r.gate.guard.passed,false);assert.equal((await inspectTestState(root)).phase,'full_failed')
 assert.equal((await inspectLocalExecution(root)).reason,'execution_guard_failed')
 assert.equal((await inspectTestState(root)).phase,'full_failed')
})

test('renamed contracts are audited and deleted inventory entries do not crash scans',async t=>{
 const root=await fixture(t)
 await file(root,'docs/contracts/old.schema.json','{}');git(root,'add','.');git(root,'commit','-qm','legacy schema')
 git(root,'mv','docs/contracts/old.schema.json','docs/contracts/renamed.schema.json')
 assert.equal(scan(root).failures[0].file,'docs/contracts/renamed.schema.json')
 await rm(join(root,'docs/contracts/renamed.schema.json'))
 assert.equal(scan(root,'full').ok,true)
})
test('tampered targeted guard cannot freeze a current-recorder candidate',async t=>{
 const root=await fixture(t);const r=await run(root)
 const p=join(root,'.cap/execution',r.envelope.guard.id,'gate.json')
 const evidence=JSON.parse(await readFile(p,'utf8'));evidence.envelope.kind='forged';await writeFile(p,JSON.stringify(evidence))
 await assert.rejects(freezeTestCandidate(root),/test_targeted_evidence_invalid/)
})
