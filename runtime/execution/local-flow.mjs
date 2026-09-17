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
const diagnosticLimit=16*1024
function redactDiagnostic(value='') {
 let redacted=String(value)
 redacted=redacted.replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi,'[REDACTED PRIVATE KEY]')
 redacted=redacted.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,'$1[REDACTED]@')
 const key=String.raw`(?:(?:[a-z0-9]+[_-])*(?:authorization|cookie|password|passwd|token|secret|key(?:[_-]?id)?|credential(?:s)?|session(?:[_-]?id)?|database[_-]?url|db[_-]?url|connection[_-]?string)|accessToken|refreshToken|clientSecret|apiKey|privateKey|userKey|sessionToken|sessionId|databaseUrl|connectionString|secretAccessKey|accessKeyId)`
 redacted=redacted.replace(new RegExp(`(["'])(${key})\\1\\s*:\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,}\\n]*)`,'gi'),(_,quote,name)=>`${quote}${name}${quote}: "[REDACTED]"`)
 redacted=redacted.replace(new RegExp(`([?&]${key}=)[^&#\\s]*`,'gi'),'$1[REDACTED]')
 redacted=redacted.replace(new RegExp(`(^|[^a-z0-9_-])(${key})\\s*[:=]\\s*(?:"[^"\\n]*"|'[^'\\n]*'|[^\\n]*)`,'gim'),(_,prefix,name)=>`${prefix}${name}=[REDACTED]`)
 redacted=redacted.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,match=>`${match.split(/\s/,1)[0]} [REDACTED]`)
 redacted=redacted.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,'[REDACTED]')
 redacted=redacted.replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{12,}\b|\b(?:ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]')
 return redacted
}
function diagnosticText(value='') {
 const redacted=redactDiagnostic(value)
 if(redacted.length<=diagnosticLimit)return redacted
 const marker='\n… [truncated; showing head and tail] …\n',budget=diagnosticLimit-marker.length,head=Math.ceil(budget/2)
 return `${redacted.slice(0,head)}${marker}${redacted.slice(-(budget-head))}`
}
function executionDiagnostic(stdout='',stderr='') {
 return {schemaVersion:1,status:'',stdout:diagnosticText(stdout),stderr:diagnosticText(stderr),truncated:String(stdout).length>diagnosticLimit||String(stderr).length>diagnosticLimit}
}
export function compactExecutionResult(run={}) {
 const gate=run.gate||{},receipt=run.receipt||{},fallback=gate.passed!==true||gate.gate!=='PASS'||receipt.status!=='passed'||receipt.exitCode!==0||Boolean(receipt.signal)
 const projected={schemaVersion:1,outputMode:fallback?'full-fallback':'compact',trust:'local-observed',stage:gate.stage||run.envelope?.stage||'',action:gate.action||run.envelope?.action||'',gate,execution:{envelopeId:receipt.envelopeId||run.envelope?.id||'',status:receipt.status||'',exitCode:receipt.exitCode??null,signal:receipt.signal??null},output:{stdout:{bytes:Buffer.byteLength(String(run.stdout||'')),sha256:receipt.stdoutHash||digest(String(run.stdout||''))},stderr:{bytes:Buffer.byteLength(String(run.stderr||'')),sha256:receipt.stderrHash||digest(String(run.stderr||''))}},artifactDir:run.artifactDir||''}
 if(fallback){const diagnostic=executionDiagnostic(run.stdout,run.stderr);projected.diagnostic={...diagnostic,status:receipt.status||diagnostic.status||''}}
 return projected
}
function actionStage(action){return {build:'implement',test:'test',package:'release'}[action]}
// Stable, model-facing recovery contract.  These are recommendations for the
// local workflow, not permissions or an execution policy.  A model can carry
// them out without asking the user to memorise cap-execute flags.
export function executionNextActions(reason='', { stage='', action='' } = {}) {
 const code=String(reason||'').split(':')[0]
 if(code==='verified_local_evidence') return []
 const context={stage,action}
 const make=(kind,label,extra={})=>({kind,label,reason:String(reason||''),requiresUser:false,...context,...extra})
 if(code==='execution_missing'||code==='execution_command_missing'||code==='execution_command_disabled') return [make('configure_execution_command',code==='execution_command_disabled'?'PROFILE 明确声明当前阶段没有执行套件':'发现或补齐本地执行命令')]
 if(code==='command_failed'||code==='timed_out'||code==='output_limit'||code==='spawn_failed') return [make('diagnose_command_failure','检查失败输出并修复实现或测试命令'),make('rerun_with_new_action_id','修复后重新执行', {requiresSourceChange:false})]
 if(code==='source_changed_during_execution'||code==='execution_source_changed') return [make('inspect_source_changes','检查执行期间发生的源码变化'),make('rerun_with_new_action_id','确认代码稳定后重新执行')]
 if(code==='execution_pending_or_interrupted'||code==='execution_in_progress_or_interrupted') return [make('recover_interrupted_execution','恢复或清理中断的本地执行'),make('rerun_with_new_action_id','恢复后重新执行')]
 if(code==='execution_version_changed') return [make('upgrade_local_skills','升级本地 Skills 后重新检查'),make('rerun_with_new_action_id','使用新版本重新执行')]
 if(code==='execution_identity_changed'||code==='execution_contract_mismatch') return [make('rebind_current_task','按当前 Task、分支和阶段重新生成执行证据'),make('rerun_with_new_action_id','绑定完成后重新执行')]
 if(code==='execution_index_invalid'||code==='execution_request_invalid'||code==='execution_bundle_invalid'||code==='execution_artifact_invalid') return [make('repair_execution_evidence','修复损坏或不完整的本地执行证据'),make('rerun_with_new_action_id','修复后重新执行')]
 return reason? [make('inspect_local_execution','检查本地执行状态')]:[]
}
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
 if(!command.argv.length)fail(command.disabled?'execution_command_disabled: PROFILE declares no runner for this stage':'execution_command_missing: configure .cap/execution-config.json or pass argv after --')
 return makeEnvelope(f,options,stage,contract,command.argv)
}
function gateFor(envelope,receipt) {
 const blockers=[]
 if(receipt.status!=='passed'||receipt.exitCode!==0||receipt.signal)blockers.push(receipt.status==='failed'?'command_failed':receipt.status)
 if(!same(envelope.snapshot,receipt.afterSnapshot))blockers.push('source_changed_during_execution')
 const reason=blockers[0]||'verified_local_evidence'
 return {schemaVersion:2,trust:'local-observed',gate:blockers.length?'BLOCKED':'PASS',passed:!blockers.length,stage:envelope.stage,action:envelope.action,envelopeId:envelope.id,blockers,nextActions:executionNextActions(reason,{stage:envelope.stage,action:envelope.action}),remediation:blockers.length?'检查 nextActions 后修复并用新的 action ID 重跑':'证据与当前源码快照一致'}
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
 if(!selected.argv.length)fail(selected.disabled?'execution_command_disabled: PROFILE declares no runner for this stage':'execution_command_missing: configure .cap/execution-config.json or pass argv after --')
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
  const diagnostic={...executionDiagnostic(result.stdout,result.stderr),status:result.status}
  receipt.diagnosticPath='diagnostic.json';receipt.diagnosticHash=digest(diagnostic)
  await atomicJson(join(artifactDir,'diagnostic.json'),diagnostic,{exclusive:true})
  await atomicJson(join(artifactDir,'bundle.json'),{schemaVersion:2,envelope,receipt,envelopeHash:digest(envelope),receiptHash:digest(receipt)},{exclusive:true})
  // Human-facing summaries are derivatives; readers recompute from bundle.json, never trust these PASS fields.
  await atomicJson(join(artifactDir,'gate.json'),gate,{exclusive:true})
  return {envelope,receipt,gate,artifactDir,stdout:result.stdout,stderr:result.stderr,diagnostic}
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
  if(!pointer){const reason='execution_missing';return {required,stage,action,passed:false,reason,artifactDir:'',nextActions:executionNextActions(reason,{stage,action}),remediation:'发现或补齐本地执行命令'} }
  if(pointer.schemaVersion!==2||!idPattern.test(pointer.id)||!hashPattern.test(pointer.requestHash))fail('execution_index_invalid')
  const dir=`.cap/execution/${pointer.id}`,request=await jsonFile(repo,`${dir}/request.json`)
  // Prior tasks never enroll a new task into mandatory execution.
  if(request.task!==f.identity.task||request.session!==f.identity.session)return {required,stage,action,passed:false,reason:'execution_identity_changed',artifactDir:dir}
  required=true
  if(request.id!==pointer.id||digest(request)!==pointer.requestHash)fail('execution_request_invalid')
  const bundle=await jsonFile(repo,`${dir}/bundle.json`).catch(e=>{if(e.code==='ENOENT')fail('execution_pending_or_interrupted');throw e})
  if(bundle.receipt?.diagnosticPath !== 'diagnostic.json' || !hashPattern.test(bundle.receipt?.diagnosticHash || '')) fail('execution_diagnostic_invalid')
  const diagnostic=await jsonFile(repo,`${dir}/diagnostic.json`).catch(()=>null)
  if(!diagnostic || digest(diagnostic)!==bundle.receipt.diagnosticHash) fail('execution_diagnostic_invalid')
  const gate=verifyBundle(bundle,request,{...f,stage})
  const reason=gate.blockers[0]||'verified_local_evidence'
  return {required,stage,action,passed:gate.passed,reason,artifactDir:dir,gate,nextActions:gate.nextActions,remediation:gate.remediation}
 }catch(error){const reason=error.code==='ENOENT'?'execution_missing':String(error.message).startsWith('execution_')?error.message:'execution_artifact_invalid';return {required:true,stage,action,passed:false,reason,artifactDir:'',nextActions:executionNextActions(reason,{stage,action}),remediation:'检查本地执行证据并按 nextActions 修复'}}
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
