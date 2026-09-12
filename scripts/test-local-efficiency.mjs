import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runLocalAction, inspectLocalExecution, doctorLocalExecution } from '../runtime/execution/local-flow.mjs'

const cli=fileURLToPath(new URL('./cap-execute.mjs',import.meta.url))
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'cap-efficiency-'));t.after(()=>rm(root,{recursive:true,force:true}))
 git(root,'init','-q');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Fixture')
 await writeFile(join(root,'.gitignore'),'.cap/\n');await writeFile(join(root,'source.txt'),'base\n');git(root,'add','.');git(root,'commit','-qm','fixture')
 await mkdir(join(root,'.cap'));await writeFile(join(root,'.cap/STATE.md'),`stage: test\nstatus: in-progress\ntask-id: task-a\nsession-id: session-a\nbranch: ${git(root,'branch','--show-current')}\nworktree: ${root}\nexecution-required: true\n- [x] test: logic\n`)
 return root
}
const opts={environment:{},command:[process.execPath,'-e','process.stdout.write("ok; still argv")']}

test('ordinary local run needs no key and persisted evidence can be recomputed',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,opts)
 assert.equal(run.gate.gate,'PASS');assert.equal(run.receipt.authority,'local-observed');assert.equal(run.envelope.stage,'test')
 assert.equal((await inspectLocalExecution(root)).passed,true)
 assert.equal((await readFile(join(run.artifactDir,'bundle.json'),'utf8')).includes('CAP_LOCAL_EXECUTION_SECRET'),false)
})
test('failed execution keeps bounded redacted diagnostics for model recovery',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,{environment:{TOKEN:'hidden'},command:[process.execPath,'-e','console.error("token=sk-123456789012345");process.exit(2)']})
 const diagnostic=JSON.parse(await readFile(join(run.artifactDir,'diagnostic.json'),'utf8'))
 assert.equal(run.gate.gate,'BLOCKED');assert.match(diagnostic.stderr,/REDACTED/);assert.doesNotMatch(diagnostic.stderr,/sk-123456789012345/);assert.ok(run.gate.nextActions.some(item=>item.kind==='diagnose_command_failure'))
 const multiline=await runLocalAction(root,{environment:{},command:[process.execPath,'-e','console.error("password=super secret phrase\\ntoken=\\\"quoted secret\\\"");process.exit(2)']})
 const multilineDiagnostic=JSON.parse(await readFile(join(multiline.artifactDir,'diagnostic.json'),'utf8'))
 assert.doesNotMatch(multilineDiagnostic.stderr,/super secret phrase|quoted secret/)
})
test('current dirty snapshot is supported, later source edit invalidates old evidence',async t=>{
 const root=await fixture(t);await writeFile(join(root,'source.txt'),'dirty-before\n')
 assert.equal((await runLocalAction(root,opts)).gate.gate,'PASS')
 await writeFile(join(root,'source.txt'),'dirty-after\n');assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('a command changing source cannot attest the original snapshot',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,{environment:{},command:[process.execPath,'-e','require("fs").writeFileSync("source.txt","changed")']})
 assert.equal(run.gate.gate,'BLOCKED');assert.ok(run.gate.blockers.includes('source_changed_during_execution'))
})
test('newest failure replaces earlier pass; explicit IDs cannot run twice',async t=>{
 const root=await fixture(t);await runLocalAction(root,{...opts,id:'once'})
 await assert.rejects(runLocalAction(root,{...opts,id:'once'}),/execution_id_used/)
 await runLocalAction(root,{environment:{},command:[process.execPath,'-e','process.exit(4)']})
 const status=await inspectLocalExecution(root);assert.equal(status.passed,false);assert.equal(status.reason,'command_failed')
})
test('tampered bundle and standalone PASS files cannot open the gate',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,opts)
 await writeFile(join(run.artifactDir,'gate.json'),JSON.stringify({gate:'PASS'}))
 const path=join(run.artifactDir,'bundle.json');const body=JSON.parse(await readFile(path,'utf8'));body.receipt.exitCode=42;await writeFile(path,JSON.stringify(body))
 assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('wrong Task/session, branch and commit never reuse old execution',async t=>{
 const root=await fixture(t);await runLocalAction(root,opts)
 const p=join(root,'.cap/STATE.md'),state=await readFile(p,'utf8');await writeFile(p,state.replace('session-a','session-b'))
 assert.equal((await inspectLocalExecution(root)).passed,false)
 await writeFile(p,state);git(root,'checkout','-qb','another');assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('project package test command is discovered without manually entering argv',async t=>{
 const root=await fixture(t);await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}))
 const report=await doctorLocalExecution(root);assert.equal(report.command.source,'package.json');assert.ok(report.command.argv.includes('test'))
})
test('PROFILE test-commands are preferred for test and build discovery',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { unit: "python3 -m pytest tests/unit", build: "python3 -m compileall src" }\n')
 let report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['python3','-m','pytest','tests/unit']);assert.equal(report.command.source,'.cap/PROFILE.md#test-commands')
 await writeFile(join(root,'.cap/STATE.md'),(await readFile(join(root,'.cap/STATE.md'),'utf8')).replace('stage: test','stage: implement'))
 report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['python3','-m','compileall','src'])
})
test('PROFILE explicit none prevents unintended test auto-discovery',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { unit: "none — 项目无测试套件" }\n')
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}))
 await assert.rejects(runLocalAction(root,{environment:{}}),/execution_command_disabled/)
})
test('release discovery prefers package, pack, then prepare over build',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'.cap/STATE.md'),(await readFile(join(root,'.cap/STATE.md'),'utf8')).replace('stage: test','stage: release'))
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'echo build',prepare:'echo prepare',pack:'echo pack',package:'echo package'}}))
 let report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['npm','run','package'])
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'echo build',prepare:'echo prepare',pack:'echo pack'}}));report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['npm','run','pack'])
})
test('lightweight project file discovery supplies non-Node test runners',async t=>{
 const root=await fixture(t);await writeFile(join(root,'pyproject.toml'),'[tool.pytest.ini_options]\n')
 const report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['python3','-m','pytest']);assert.equal(report.command.source,'project-files')
})
test('missing command gets a useful diagnostic; document/review stages never invent execution',async t=>{
 const root=await fixture(t);await assert.rejects(runLocalAction(root,{environment:{}}),/execution_command_missing/)
 await assert.rejects(runLocalAction(root,{...opts,stage:'review'}),/execution_stage_uses_artifacts/)
 await assert.rejects(runLocalAction(root,{...opts,action:'deploy'}),/execution_action_stage_mismatch/)
})
test('symlinked evidence directory is rejected without touching target',async t=>{
 const root=await fixture(t),external=await mkdtemp(join(tmpdir(),'cap-external-'));t.after(()=>rm(external,{recursive:true,force:true}))
 await symlink(external,join(root,'.cap/execution'),'dir')
 await assert.rejects(runLocalAction(root,opts),/execution_path_invalid/)
})
test('timeouts and capped output are failures, not zero-exit success',async t=>{
 const root=await fixture(t)
 let run=await runLocalAction(root,{environment:{},timeoutMs:100,command:[process.execPath,'-e','setInterval(()=>{},1000)']})
 assert.equal(run.receipt.status,'timed_out');assert.equal(run.gate.gate,'BLOCKED')
 run=await runLocalAction(root,{environment:{},command:[process.execPath,'-e','process.stdout.write("x".repeat(2*1024*1024))']})
 assert.equal(run.receipt.status,'output_limit');assert.equal(run.gate.gate,'BLOCKED')
})
test('CLI help/doctor and malformed inputs do not require secrets or echo input',async t=>{
 const root=await fixture(t)
 let r=spawnSync(process.execPath,[cli,'doctor','--repo',root,'--json'],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).trust,'local-observed')
 r=spawnSync(process.execPath,[cli,'--repo',root,'--command','["private-marker"'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.doesNotMatch(r.stderr,/private-marker|SyntaxError|at file/)
 r=spawnSync(process.execPath,[cli,'--unknown'],{encoding:'utf8'});assert.notEqual(r.status,0)
})

test('cap-status consumes real evidence and blocks stale or failed results despite declared next',async t=>{
 const {inspectCapStatus}=await import('./cap-status.mjs')
 const root=await fixture(t)
 const state=await readFile(join(root,'.cap/STATE.md'),'utf8')
 await writeFile(join(root,'.cap/STATE.md'),state.replace('- [x] test: logic','')+'\n## Next action\n-> cap-release\n')
 const status=()=>inspectCapStatus({repoRoot:root,homeDir:root,environment:{CAPITAL_AGENT_MODE:'local'},fetchImpl:()=>{throw new Error('local must not fetch')}})
 await runLocalAction(root,opts)
 let report=await status();assert.equal(report.task.localExecution.executionGate,'PASS');assert.equal(report.workflow.stage,'review');assert.deepEqual(report.task.localExecution.nextActions,[])
 await writeFile(join(root,'source.txt'),'changed\n')
 report=await status();assert.equal(report.task.localExecution.executionGate,'BLOCKED');assert.equal(report.workflow.stage,'test');assert.equal(report.nextActions[0].kind,'inspect_source_changes');assert.equal(report.nextActions[1].kind,'rerun_with_new_action_id');assert.equal(report.nextActions[0].requiresUser,false)
 await runLocalAction(root,{environment:{},command:[process.execPath,'-e','process.exit(2)']})
 report=await status();assert.equal(report.task.localExecution.executionGate,'BLOCKED');assert.equal(report.workflow.stage,'test');assert.equal(report.nextActions[0].kind,'diagnose_command_failure');assert.equal(report.nextActions[1].kind,'rerun_with_new_action_id')
})

test('missing local execution exposes a stable automatic remediation contract',async t=>{
 const root=await fixture(t);const report=await inspectLocalExecution(root)
 assert.equal(report.reason,'execution_missing');assert.equal(report.nextActions[0].kind,'configure_execution_command');assert.equal(report.nextActions[0].requiresUser,false);assert.match(report.remediation,/执行命令/)
})
test('active lock rejects concurrent run; pending latest cannot reuse old success',async t=>{
 const root=await fixture(t);await runLocalAction(root,opts)
 await mkdir(join(root,'.cap/execution/.lock'))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_in_progress_or_interrupted')
 await assert.rejects(runLocalAction(root,opts),/execution_in_progress_or_interrupted/)
 await rm(join(root,'.cap/execution/.lock'),{recursive:true})
 const run=await runLocalAction(root,opts)
 await rm(join(run.artifactDir,'bundle.json'))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_pending_or_interrupted')
})
test('recover refuses live PID and clears only a stopped-process lock',async t=>{
 const {recoverLocalExecution}=await import('../runtime/execution/local-flow.mjs')
 const root=await fixture(t);await runLocalAction(root,opts)
 const lock=join(root,'.cap/execution/.lock');await mkdir(lock)
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,id:'live'}))
 await assert.rejects(recoverLocalExecution(root),/execution_process_still_running/)
 // Child has exited and has been reaped before its PID is recorded.
 const child=spawnSync(process.execPath,['-e',''],{encoding:'utf8'})
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:child.pid,id:'interrupted'}))
 assert.equal((await recoverLocalExecution(root)).recovered,true)
 assert.equal((await inspectLocalExecution(root)).passed,true)
})
test('invalid identifiers, empty explicit argv and unknown pointer version fail closed',async t=>{
 const root=await fixture(t)
 await assert.rejects(runLocalAction(root,{...opts,id:'../outside'}),/execution_id_invalid/)
 await assert.rejects(runLocalAction(root,{environment:{},command:[]}),/execution_command_invalid/)
 await runLocalAction(root,opts)
 const p=join(root,'.cap/execution/latest-test.json');const pointer=JSON.parse(await readFile(p,'utf8'));pointer.schemaVersion=99;await writeFile(p,JSON.stringify(pointer))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_index_invalid')
})
test('deferred marker cannot skip an unsatisfied independent review',async()=>{
 const {resolveNextAction}=await import('./cap-status.mjs')
 const next=resolveNextAction({stateText:'stage: review\nstatus: gated\ncomplexity: L4\nindependent-review: required\ndeferred-only: true\n## Next action\n-> cap-release\n'})
 assert.equal(next.stage,'review');assert.equal(next.gated,true)
})

test('CLI dogfood runs discovered project tests and detects changed source on status',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}))
 await writeFile(join(root,'check.cjs'),'if (require("fs").readFileSync("source.txt","utf8") !== "base\\n") process.exit(7)\n')
 const env={...process.env,CAPITAL_AGENT_MODE:'local',CAPITAL_AGENT_SESSION_LOCK_DIR:join(root,'.cap/session-locks')}
 const run=(...args)=>spawnSync(process.execPath,[cli,...args,'--repo',root,'--json'],{encoding:'utf8',env})
 let r=run('run');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).gate.gate,'PASS')
 await writeFile(join(root,'source.txt'),'regression\n')
 r=run('status');assert.equal(JSON.parse(r.stdout).reason,'execution_source_changed')
 r=run('run');assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).gate.gate,'BLOCKED')
 await writeFile(join(root,'source.txt'),'base\n')
 r=run('run');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).gate.gate,'PASS')
})
