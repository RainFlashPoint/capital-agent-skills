import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runLocalAction, inspectLocalExecution, doctorLocalExecution, compactExecutionResult } from '../runtime/execution/local-flow.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { captureContextBinding, captureCoverageRequirements } from './cap-context-gate.mjs'
import { createManifest } from './cap-context-checkpoint.mjs'
import { digest } from '../runtime/ontology/schema.mjs'
import { createTestImpact, freezeTestCandidate } from '../runtime/execution/test-state.mjs'
import { captureTaskBaseline } from './cap-worktree-baseline.mjs'

const cli=fileURLToPath(new URL('./cap-execute.mjs',import.meta.url))
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
async function fixture(t, stage = 'implement') {
 const root=await mkdtemp(join(tmpdir(),'cap-efficiency-'));t.after(()=>rm(root,{recursive:true,force:true}))
 git(root,'init','-q');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Fixture')
 await writeFile(join(root,'.gitignore'),'.cap/\n');await writeFile(join(root,'source.txt'),'base\n');git(root,'add','.');git(root,'commit','-qm','fixture')
 const baseCommit=git(root,'rev-parse','HEAD')
 await captureTaskBaseline(root,'task-a')
 if(stage==='test'){await writeFile(join(root,'source.txt'),'feature\n');git(root,'add','source.txt');git(root,'commit','-qm','feature')}
 await mkdir(join(root,'.cap'),{recursive:true});await writeFile(join(root,'.cap/STATE.md'),`stage: ${stage}\nstatus: in-progress\ntask-id: task-a\nsession-id: session-a\nbranch: ${git(root,'branch','--show-current')}\nbase-commit: ${baseCommit}\nworktree: ${root}\nexecution-required: true\n- [x] test: logic\n`)
 return root
}
const opts={environment:{},command:[process.execPath,'-e','process.stdout.write("ok; still argv")']}
const fullOptsCommand=[process.execPath,'-e','process.stdout.write("full-suite")']

async function prepareCliContext(root) {
 const f=await inspectContextFingerprint(root),branch=git(root,'branch','--show-current'),head=git(root,'rev-parse','HEAD')
 const stage=(await readFile(join(root,'.cap/STATE.md'),'utf8')).match(/^stage:\s*(.+)$/m)?.[1]?.trim()||'implement'
 await mkdir(join(root,'.cap/context'),{recursive:true})
 await writeFile(join(root,'.cap/task-context.md'),`- intent: Execute local regression\n- branch: ${branch}\n- head: ${head}\n- index-fingerprint: ${f.index}\n- worktree-fingerprint: ${f.worktree}\n- untracked-fingerprint: ${f.untracked}\n- profile-used-as: index-only\n\n## Entry points\n- \`source.txt\`\n## Call chain and data flow\n- source to test\n## Similar implementations\n- existing test\n## History usage\n- candidates: none\n- outcome: not_used\n- reason: no candidate\n- plan-impact: none\n- verification-impact: none\n## Tests and environment\n- \`source.txt\`\n## Evidence sources\n- \`source.txt\`\n## Reference contract\n- status: not-applicable\n- artifact: none\n- source: none\n- adopted: none\n- conflicts: none\n- invalidates-on: not-applicable\n## External operation boundary\n- environment: local\n- authorization: local only\n- minimum-impact: source.txt\n- recovery: git\n- invalidates-on: scope change\n## Impact surface\n- modify: \`source.txt\`\n## Profile drift\n- none\n`)
 const binding=await captureContextBinding(root,{stage,environment:{}}),requirements=await captureCoverageRequirements(root,{environment:{}})
 const scope={taskId:binding.taskId,repo:binding.repo,branch:binding.branch,commit:binding.commit}
 const atoms=requirements.map((item,index)=>({id:`atom-${index}`,type:item.types[0],assertion:`Retain ${item.label}: ${item.id}`,protection:item.minProtection,priority:index?80:100,scope,scopeBinding:'task',sourceRefs:[item.sourceRef],trust:'repository-observed',status:'active',certainty:'confirmed',recoverability:'source-backed',invalidation:[],supersedes:[]}))
 atoms.push({id:'acceptance-1',type:'acceptance_criterion',assertion:'Preserve local test outcome',protection:'P1',priority:80,scope,scopeBinding:'task',sourceRefs:['user-message:fixture'],trust:'user-stated',status:'active',certainty:'confirmed',recoverability:'source-backed',invalidation:[],supersedes:[]})
 atoms.push({id:'next-action-1',type:'next_action',assertion:'Run local tests',protection:'P1',priority:80,scope,scopeBinding:'task',sourceRefs:['user-message:fixture-next'],trust:'user-stated',status:'active',certainty:'confirmed',recoverability:'source-backed',invalidation:[],supersedes:[]})
 const checkpoint={schemaVersion:1,identity:{...scope,stage},atoms,coverage:requirements.map((item,index)=>({id:item.id,atomIds:[`atom-${index}`]}))}
 const log=atoms.map(item=>JSON.stringify(item)).join('\n')+'\n'
 const sources=Object.fromEntries(await Promise.all(['.cap/STATE.md','.cap/task-context.md'].map(async path=>[path,await readFile(join(root,path),'utf8')])))
 const manifest=createManifest(checkpoint,{checkpointPath:'checkpoint.json',atomLogPath:'atoms.jsonl',atomLogContent:log,sourceContents:sources,budgetTokens:20000,trigger:'stage-entry',pressure:'unknown'})
 manifest.entry=binding
 manifest.entry.previousManifest='none'
 manifest.entry.previousDigest=null
 await writeFile(join(root,'.cap/context/checkpoint.json'),JSON.stringify(checkpoint))
 await writeFile(join(root,'.cap/context/atoms.jsonl'),log)
 await writeFile(join(root,'.cap/context/manifest.json'),JSON.stringify(manifest))
 await writeFile(join(root,'.cap/STATE.md'),sources['.cap/STATE.md']+`\ncontext-manifest: .cap/context/manifest.json\ncontext-checkpoint: .cap/context/checkpoint.json\ncontext-checkpoint-digest: ${manifest.digest}\ncontext-previous-manifest: none\ncontext-previous-digest: none\n`)
}

async function completeTestSequence(root, targetedCommand, fullCommand = fullOptsCommand) {
 await createTestImpact(root,{changedFiles:['source.txt'],activeChecks:['logic'],targetedCommands:[targetedCommand],fullCommand})
 const targeted=await runLocalAction(root,{environment:{},stage:'test',testScope:'targeted',command:targetedCommand})
 if(!targeted.gate.passed)return {targeted,full:null}
 await freezeTestCandidate(root)
 const full=await runLocalAction(root,{environment:{},stage:'test',testScope:'full',command:fullCommand})
 return {targeted,full}
}

test('ordinary local run needs no key and persisted evidence can be recomputed',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,opts)
 assert.equal(run.gate.gate,'PASS');assert.equal(run.receipt.authority,'local-observed');assert.equal(run.envelope.stage,'implement')
 assert.equal((await inspectLocalExecution(root)).passed,true)
 assert.deepEqual(await readdir(run.artifactDir),['gate.json'])
 assert.equal((await readFile(join(run.artifactDir,'gate.json'),'utf8')).includes('CAP_LOCAL_EXECUTION_SECRET'),false)
})
test('failed execution keeps bounded redacted diagnostics for model recovery',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,{environment:{TOKEN:'hidden'},command:[process.execPath,'-e','console.error("token=sk-123456789012345");process.exit(2)']})
 const diagnostic=JSON.parse(await readFile(join(run.artifactDir,'gate.json'),'utf8')).diagnostic
 assert.equal(run.gate.gate,'BLOCKED');assert.match(diagnostic.stderr,/REDACTED/);assert.doesNotMatch(diagnostic.stderr,/sk-123456789012345/);assert.ok(run.gate.nextActions.some(item=>item.kind==='diagnose_command_failure'))
 const multiline=await runLocalAction(root,{environment:{},command:[process.execPath,'-e','console.error("password=super secret phrase\\ntoken=\\\"quoted secret\\\"");process.exit(2)']})
 const multilineDiagnostic=JSON.parse(await readFile(join(multiline.artifactDir,'gate.json'),'utf8')).diagnostic
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
test('tampered canonical evidence and embedded PASS fields cannot open the gate',async t=>{
 const root=await fixture(t);const run=await runLocalAction(root,opts)
 const path=join(run.artifactDir,'gate.json');const body=JSON.parse(await readFile(path,'utf8'));body.gate={gate:'PASS',passed:true};body.receipt.exitCode=42;await writeFile(path,JSON.stringify(body))
 assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('wrong Task/session, branch and commit never reuse old execution',async t=>{
 const root=await fixture(t);await runLocalAction(root,opts)
 const p=join(root,'.cap/STATE.md'),state=await readFile(p,'utf8');await writeFile(p,state.replace('session-a','session-b'))
 assert.equal((await inspectLocalExecution(root)).passed,false)
 await writeFile(p,state);git(root,'checkout','-qb','another');assert.equal((await inspectLocalExecution(root)).passed,false)
})
test('project package test command is discovered without manually entering argv',async t=>{
 const root=await fixture(t,'test');await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}))
 const report=await doctorLocalExecution(root);assert.equal(report.command.source,'package.json');assert.ok(report.command.argv.includes('test'))
})
test('PROFILE test-commands are preferred for test and build discovery',async t=>{
 const root=await fixture(t,'test')
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { unit: "python3 -m pytest tests/unit", build: "python3 -m compileall src" }\n')
 let report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['python3','-m','pytest','tests/unit']);assert.equal(report.command.source,'.cap/PROFILE.md#test-commands')
 await writeFile(join(root,'.cap/STATE.md'),(await readFile(join(root,'.cap/STATE.md'),'utf8')).replace('stage: test','stage: implement'))
 report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['python3','-m','compileall','src'])
})
test('PROFILE explicit none prevents unintended test auto-discovery',async t=>{
 const root=await fixture(t,'test')
 await writeFile(join(root,'.cap/PROFILE.md'),'test-commands: { unit: "none — 项目无测试套件" }\n')
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}))
 await assert.rejects(runLocalAction(root,{environment:{}}),/execution_command_disabled/)
})
test('release discovery prefers package, pack, then prepare over build',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'.cap/STATE.md'),(await readFile(join(root,'.cap/STATE.md'),'utf8')).replace('stage: implement','stage: release'))
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'echo build',prepare:'echo prepare',pack:'echo pack',package:'echo package'}}))
 let report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['npm','run','package'])
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'echo build',prepare:'echo prepare',pack:'echo pack'}}));report=await doctorLocalExecution(root);assert.deepEqual(report.command.argv,['npm','run','pack'])
})
test('lightweight project file discovery supplies non-Node test runners',async t=>{
 const root=await fixture(t,'test');await writeFile(join(root,'pyproject.toml'),'[tool.pytest.ini_options]\n')
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
 run=await runLocalAction(root,{environment:{},command:[process.execPath,'-e','process.stdout.write("x".repeat(2*1024*1024));process.stderr.write("FINAL_DIAGNOSTIC_MARKER\\n")']})
 assert.equal(run.receipt.status,'output_limit');assert.equal(run.gate.gate,'BLOCKED')
 assert.match(run.stderr,/FINAL_DIAGNOSTIC_MARKER/)
 const projected=compactExecutionResult(run);assert.equal(projected.outputMode,'full-fallback');assert.match(projected.diagnostic.stderr,/FINAL_DIAGNOSTIC_MARKER/)
})
test('CLI help/doctor and malformed inputs do not require secrets or echo input',async t=>{
 const root=await fixture(t)
 let r=spawnSync(process.execPath,[cli,'doctor','--repo',root,'--json'],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).trust,'local-observed')
 r=spawnSync(process.execPath,[cli,'--repo',root,'--command','["private-marker"'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.doesNotMatch(r.stderr,/private-marker|SyntaxError|at file/)
 r=spawnSync(process.execPath,[cli,'--unknown'],{encoding:'utf8'});assert.notEqual(r.status,0)
})

test('CLI compact mode suppresses successful noise and restores failed diagnostics',async t=>{
 const root=await fixture(t),env={...process.env,CAPITAL_AGENT_MODE:'local',CAPITAL_AGENT_SESSION_LOCK_DIR:join(root,'.cap/session-locks')}
 await inspectSessionRoot({repoRoot:root,environment:env})
 await prepareCliContext(root)
 let r=spawnSync(process.execPath,[cli,'run','--repo',root,'--compact','--',process.execPath,'-e','process.stdout.write("success-noise\\n".repeat(2000))'],{encoding:'utf8',env})
 assert.equal(r.status,0,r.stderr+r.stdout)
 let projected=JSON.parse(r.stdout)
 assert.equal(projected.outputMode,'compact');assert.equal(projected.gate.gate,'PASS');assert.doesNotMatch(r.stdout,/success-noise/)
 r=spawnSync(process.execPath,[cli,'run','--repo',root,'--compact','--',process.execPath,'-e','console.error("first clue\\n"+"noise\\n".repeat(5000)+"last clue\\ntoken=sk-123456789012345");process.exitCode=3'],{encoding:'utf8',env})
 assert.equal(r.status,1)
 projected=JSON.parse(r.stdout)
 assert.equal(projected.outputMode,'full-fallback');assert.equal(projected.gate.gate,'BLOCKED');assert.match(projected.diagnostic.stderr,/first clue/);assert.match(projected.diagnostic.stderr,/REDACTED/);assert.doesNotMatch(r.stdout,/sk-123456789012345/)
 r=spawnSync(process.execPath,[cli,'run','--repo',root,'--compact','--json','--',process.execPath,'-e',''],{encoding:'utf8',env})
 assert.notEqual(r.status,0);assert.match(r.stderr,/execution_output_mode_conflict/)
})

test('cap-status consumes real evidence and blocks stale or failed results despite declared next',async t=>{
 const {inspectCapStatus}=await import('./cap-status.mjs')
 const root=await fixture(t,'test')
 const state=await readFile(join(root,'.cap/STATE.md'),'utf8')
 await writeFile(join(root,'.cap/STATE.md'),state.replace('- [x] test: logic','')+'\n## Next action\n-> cap-release\n')
 const status=()=>inspectCapStatus({repoRoot:root,homeDir:root,environment:{CAPITAL_AGENT_MODE:'local'},fetchImpl:()=>{throw new Error('local must not fetch')}})
 await completeTestSequence(root,opts.command)
 let report=await status();assert.equal(report.task.localExecution.executionGate,'PASS');assert.equal(report.workflow.stage,'review');assert.deepEqual(report.task.localExecution.nextActions,[])
 await writeFile(join(root,'source.txt'),'changed\n')
 report=await status();assert.equal(report.task.localExecution.executionGate,'BLOCKED');assert.equal(report.workflow.stage,'test');assert.equal(report.nextActions[0].kind,'refresh_test_impact');assert.equal(report.nextActions.length,1);assert.equal(report.nextActions[0].requiresUser,false)
 const failed=[process.execPath,'-e','process.exit(2)']
 await createTestImpact(root,{changedFiles:['source.txt'],activeChecks:['logic'],targetedCommands:[failed],fullCommand:fullOptsCommand})
 await runLocalAction(root,{environment:{},stage:'test',testScope:'targeted',command:failed})
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
 const path=join(run.artifactDir,'gate.json'),evidence=JSON.parse(await readFile(path,'utf8'))
 await writeFile(path,JSON.stringify({schemaVersion:3,status:'pending',envelope:evidence.envelope,envelopeHash:evidence.envelopeHash}))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_pending_or_interrupted')
})

test('legacy four-file actions remain readable',async t=>{
 const root=await fixture(t),run=await runLocalAction(root,opts)
 const evidence=JSON.parse(await readFile(join(run.artifactDir,'gate.json'),'utf8'))
 const receipt={...evidence.receipt,diagnosticPath:'diagnostic.json',diagnosticHash:evidence.diagnosticHash}
 await writeFile(join(run.artifactDir,'request.json'),JSON.stringify(evidence.envelope))
 await writeFile(join(run.artifactDir,'diagnostic.json'),JSON.stringify(evidence.diagnostic))
 await writeFile(join(run.artifactDir,'bundle.json'),JSON.stringify({schemaVersion:2,envelope:evidence.envelope,receipt,envelopeHash:evidence.envelopeHash,receiptHash:digest(receipt)}))
 await writeFile(join(run.artifactDir,'gate.json'),JSON.stringify(evidence.gate))
 assert.equal((await inspectLocalExecution(root)).passed,true)
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
 const p=join(root,'.cap/execution/latest-implement.json');const pointer=JSON.parse(await readFile(p,'utf8'));pointer.schemaVersion=99;await writeFile(p,JSON.stringify(pointer))
 assert.equal((await inspectLocalExecution(root)).reason,'execution_index_invalid')
})
test('deferred marker cannot skip an unsatisfied independent review',async()=>{
 const {resolveNextAction}=await import('./cap-status.mjs')
 const next=resolveNextAction({stateText:'stage: review\nstatus: gated\ncomplexity: L4\nindependent-review: required\ndeferred-only: true\n## Next action\n-> cap-release\n'})
 assert.equal(next.stage,'review');assert.equal(next.gated,true)
})

test('CLI dogfood runs discovered project tests and detects changed source on status',async t=>{
 const root=await fixture(t)
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'node check.cjs'}}))
 await writeFile(join(root,'check.cjs'),'if (require("fs").readFileSync("source.txt","utf8") !== "base\\n") process.exit(7)\n')
 const env={...process.env,CAPITAL_AGENT_MODE:'local',CAPITAL_AGENT_SESSION_LOCK_DIR:join(root,'.cap/session-locks')}
 await inspectSessionRoot({repoRoot:root,environment:env})
 await prepareCliContext(root)
 const run=(...args)=>spawnSync(process.execPath,[cli,...args,'--repo',root,'--json'],{encoding:'utf8',env})
 let r=run('run');assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(JSON.parse(r.stdout).gate.gate,'PASS')
 await writeFile(join(root,'source.txt'),'regression\n')
 r=run('status');assert.equal(JSON.parse(r.stdout).reason,'execution_source_changed')
 r=run('run');assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).gate.gate,'BLOCKED')
 await writeFile(join(root,'source.txt'),'base\n')
 r=run('run');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).gate.gate,'PASS')
})
