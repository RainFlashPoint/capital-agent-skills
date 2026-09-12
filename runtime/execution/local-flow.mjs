import { lstat, mkdir, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, canonical } from '../ontology/schema.mjs'
import { inspectContextFingerprint } from '../../scripts/cap-context-fingerprint.mjs'
import { inspectSessionRoot } from '../../scripts/cap-session-root.mjs'
import { fail, field, stageName, git, repoRoot, safePath, jsonFile, textFile, atomicJson, executionContract, versions, commandFor, argvCheck, timeoutCheck, observeCommand } from './local-support.mjs'
export { executionContract } from './local-support.mjs'

const hashPattern=/^[a-f0-9]{64}$/
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const same=(a,b)=>canonical(a)===canonical(b)
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
function actionStage(action){return {build:'implement',test:'test',package:'release'}[action]}
async function facts(path,options={}) {
 const repo=await repoRoot(path)
 if(options.checkSession){const session=await inspectSessionRoot({repoRoot:repo,environment:options.environment??process.env,capture:false});if(session.blocked)fail(session.code)}
 const state=await textFile(repo,'.cap/STATE.md')
 const task=field(state,'task-id'),session=field(state,'session-id')||null,branch=git(repo,['branch','--show-current']),commit=git(repo,['rev-parse','HEAD'])
 if(!task||!branch||!commit)fail('execution_local_task_identity_missing')
 if(field(state,'branch')&&field(state,'branch')!==branch)fail('execution_state_branch_mismatch')
 if(field(state,'worktree')&&await realpath(resolve(field(state,'worktree'))).catch(()=>null)!==repo)fail('execution_state_root_mismatch')
 const config=await textFile(repo,'.cap/execution-config.json').catch(e=>{if(e.code==='ENOENT')return '';throw e})
 return {state,identity:{repo,task,session,branch,commit},snapshot:{...await inspectContextFingerprint(repo),configuration:digest(config)},stage:stageName(field(state,'stage'))}
}
function makeEnvelope(f,options,stage,contract,command) {
 const id=options.id||`action-${randomUUID()}`;if(!idPattern.test(id))fail('execution_id_invalid')
 return {schemaVersion:2,trust:'local-observed',id,...f.identity,stage,action:contract.action,constraints:contract.constraints,commandHash:digest(command),versions,snapshot:f.snapshot,startedAt:new Date().toISOString()}
}
export async function buildLocalEnvelope(repoPath='.',options={}) {
 const f=await facts(repoPath,{...options,checkSession:true})
 const stage=stageName(options.stage||actionStage(options.action)||f.stage),contract=executionContract(stage)
 if(!contract.action)fail('execution_stage_uses_artifacts')
 if(options.action&&options.action!==contract.action)fail('execution_action_stage_mismatch')
 if(options.constraints&&!same(options.constraints,contract.constraints))fail('execution_constraints_not_supported')
 const command=await commandFor(f.identity.repo,stage,options.command,contract.action)
 if(!command.argv.length)fail('execution_command_missing: configure .cap/execution-config.json or pass argv after --')
 return makeEnvelope(f,options,stage,contract,command.argv)
}
function gateFor(envelope,receipt) {
 const blockers=[]
 if(receipt.status!=='passed'||receipt.exitCode!==0||receipt.signal)blockers.push(receipt.status==='failed'?'command_failed':receipt.status)
 if(!same(envelope.snapshot,receipt.afterSnapshot))blockers.push('source_changed_during_execution')
 return {schemaVersion:2,trust:'local-observed',gate:blockers.length?'BLOCKED':'PASS',passed:!blockers.length,stage:envelope.stage,action:envelope.action,envelopeId:envelope.id,blockers}
}
function verifyBundle(bundle,request,expected) {
 if(bundle.schemaVersion!==2||!same(bundle.envelope,request)||bundle.envelopeHash!==digest(request)||bundle.receiptHash!==digest(bundle.receipt))fail('execution_bundle_invalid')
 const e=bundle.envelope,r=bundle.receipt
 if(e.schemaVersion!==2||e.trust!=='local-observed'||r.authority!=='local-observed'||r.schemaVersion!==2||r.envelopeHash!==digest(e)||r.envelopeId!==e.id)fail('execution_bundle_invalid')
 if(!same(e.versions,versions))fail('execution_version_changed')
 for(const k of ['repo','task','session','branch','commit'])if(e[k]!==expected.identity[k]||r[k]!==e[k])fail('execution_identity_changed')
 const contract=executionContract(e.stage)
 if(e.stage!==expected.stage||e.action!==contract.action||!same(e.constraints,contract.constraints))fail('execution_contract_mismatch')
 if(!same(e.snapshot,expected.snapshot))fail('execution_source_changed')
 if(!validDate(e.startedAt)||!validDate(r.finishedAt)||r.finishedAt<e.startedAt||r.finishedAt>new Date().toISOString())fail('execution_time_invalid')
 if(!['passed','failed','timed_out','output_limit','spawn_failed'].includes(r.status)||!(r.exitCode===null||Number.isSafeInteger(r.exitCode))||!(r.signal===null||typeof r.signal==='string'&&r.signal.length>0)||!hashPattern.test(r.stdoutHash)||!hashPattern.test(r.stderrHash)||!hashPattern.test(e.commandHash))fail('execution_result_invalid')
 return gateFor(e,r)
}
export async function runLocalAction(repoPath='.',options={}) {
 const initial=await facts(repoPath,{...options,checkSession:true}),repo=initial.identity.repo
 const stage=stageName(options.stage||actionStage(options.action)||initial.stage),contract=executionContract(stage)
 if(!contract.action)fail('execution_stage_uses_artifacts')
 if(options.action&&options.action!==contract.action)fail('execution_action_stage_mismatch')
 if(options.constraints&&!same(options.constraints,contract.constraints))fail('execution_constraints_not_supported')
 const selected=await commandFor(repo,stage,options.command,contract.action)
 if(!selected.argv.length)fail('execution_command_missing: configure .cap/execution-config.json or pass argv after --')
 argvCheck(selected.argv);const timeoutMs=timeoutCheck(options.timeoutMs??120000)
 const envelope=makeEnvelope(initial,options,stage,contract,selected.argv)
 await safePath(repo,'.cap/execution',{create:true})
 const lock=join(repo,'.cap/execution/.lock')
 try{await mkdir(lock)}catch(e){if(e.code==='EEXIST')fail('execution_in_progress_or_interrupted');throw e}
 let artifactDir
 try {
  await atomicJson(join(lock,'owner.json'),{schemaVersion:2,pid:process.pid,id:envelope.id,startedAt:envelope.startedAt},{exclusive:true})
  artifactDir=join(repo,'.cap/execution',envelope.id)
  try{await mkdir(artifactDir)}catch(e){if(e.code==='EEXIST')fail('execution_id_used');throw e}
  await atomicJson(join(artifactDir,'request.json'),envelope,{exclusive:true})
  await atomicJson(join(repo,`.cap/execution/latest-${stage}.json`),{schemaVersion:2,id:envelope.id,requestHash:digest(envelope)})
  // The command runs with ordinary host permissions. This is observation, not authorization or an OS sandbox.
  const result=await observeCommand(selected.argv,{cwd:repo,env:options.env??process.env,timeoutMs})
  let after
  try{after=await facts(repo)}catch{after={snapshot:null,identity:null}}
  const identityChanged=!same(initial.identity,after.identity)
  const receipt={schemaVersion:2,authority:'local-observed',...initial.identity,envelopeId:envelope.id,envelopeHash:digest(envelope),finishedAt:new Date().toISOString(),exitCode:result.exitCode,signal:result.signal,status:result.status,stdoutHash:digest(result.stdout),stderrHash:digest(result.stderr),afterSnapshot:identityChanged?null:after.snapshot,runtime:{node:process.version,platform:process.platform,arch:process.arch}}
  const gate=gateFor(envelope,receipt)
  await atomicJson(join(artifactDir,'bundle.json'),{schemaVersion:2,envelope,receipt,envelopeHash:digest(envelope),receiptHash:digest(receipt)},{exclusive:true})
  // Human-facing summaries are derivatives; readers recompute from bundle.json, never trust these PASS fields.
  await atomicJson(join(artifactDir,'gate.json'),gate,{exclusive:true})
  return {envelope,receipt,gate,artifactDir,stdout:result.stdout,stderr:result.stderr}
 }finally {await rm(lock,{recursive:true,force:true})}
}
export async function inspectLocalExecution(repoPath='.',options={}) {
 let stage='',required=false,action=null
 try {
  const f=await facts(repoPath),repo=f.identity.repo
  stage=stageName(options.stage||f.stage)
  if(stage==='done')return {required:false,stage,action:null,passed:false,reason:'completed_cursor',artifactDir:''}
  const contract=executionContract(stage);action=contract.action
  if(!action)return {required:false,stage,action:null,passed:false,reason:'artifact_stage',artifactDir:''}
  required=field(f.state,'execution-required').toLowerCase()==='true'
  if(await lstat(join(repo,'.cap/execution/.lock')).catch(e=>{if(e.code==='ENOENT')return null;throw e}))fail('execution_in_progress_or_interrupted')
  const pointer=await jsonFile(repo,`.cap/execution/latest-${stage}.json`).catch(e=>{if(e.code==='ENOENT')return null;throw e})
  if(!pointer)return {required,stage,action,passed:false,reason:'execution_missing',artifactDir:''}
  if(pointer.schemaVersion!==2||!idPattern.test(pointer.id)||!hashPattern.test(pointer.requestHash))fail('execution_index_invalid')
  const dir=`.cap/execution/${pointer.id}`,request=await jsonFile(repo,`${dir}/request.json`)
  // Prior tasks never enroll a new task into mandatory execution.
  if(request.task!==f.identity.task||request.session!==f.identity.session)return {required,stage,action,passed:false,reason:'execution_identity_changed',artifactDir:dir}
  required=true
  if(request.id!==pointer.id||digest(request)!==pointer.requestHash)fail('execution_request_invalid')
  const bundle=await jsonFile(repo,`${dir}/bundle.json`).catch(e=>{if(e.code==='ENOENT')fail('execution_pending_or_interrupted');throw e})
  const gate=verifyBundle(bundle,request,{...f,stage})
  return {required,stage,action,passed:gate.passed,reason:gate.blockers[0]||'verified_local_evidence',artifactDir:dir,gate}
 }catch(error){return {required:true,stage,action,passed:false,reason:error.code==='ENOENT'?'execution_missing':String(error.message).startsWith('execution_')?error.message:'execution_artifact_invalid',artifactDir:''}}
}
export async function doctorLocalExecution(repoPath='.') {
 const f=await facts(repoPath),stage=f.stage,contract=stage==='done'?null:executionContract(stage)
 const command=contract?.action?await commandFor(f.identity.repo,stage,null,contract.action):{argv:[],source:'artifact-stage'}
 const gate=await inspectLocalExecution(repoPath)
 const locked=Boolean(await lstat(join(f.identity.repo,'.cap/execution/.lock')).catch(()=>null))
 return {schemaVersion:2,trust:'local-observed',requiresSecret:false,versions,node:process.version,platform:process.platform,stage,command,locked,gate,ready:!locked&&(!contract?.action||command.argv.length>0)}
}
export async function recoverLocalExecution(repoPath='.') {
 const repo=await repoRoot(repoPath);await safePath(repo,'.cap/execution/.lock')
 const owner=await jsonFile(repo,'.cap/execution/.lock/owner.json')
 if(!Number.isSafeInteger(owner.pid)||owner.pid<1)fail('execution_lock_owner_invalid')
 try{process.kill(owner.pid,0);fail('execution_process_still_running')}catch(e){if(e.code!=='ESRCH')throw e}
 await rm(join(repo,'.cap/execution/.lock'),{recursive:true})
 return {recovered:true,actionId:owner.id,receiptPreserved:true}
}
