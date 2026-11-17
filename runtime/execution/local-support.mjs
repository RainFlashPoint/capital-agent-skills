import { readFile, lstat, mkdir, rename, writeFile, realpath, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, isAbsolute, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { digest } from '../ontology/schema.mjs'
import { parseJson, readJson } from '../ontology/json.mjs'

export const fail = code => { throw new Error(code) }
export const stageName = name => ({ map:'understand',shape:'define',build:'implement',verify:'test' }[name] || name)
export const resolveExecutionStage = (options = {}, fallback = '') => stageName(options.stage || ({build:'implement',test:'test',package:'release'}[options.action]) || fallback)
export function field(text, name) {
 const lines=String(text).split(/\r?\n/).filter(line=>line.startsWith(`${name}:`)).map(line=>line.slice(name.length+1).trim())
 if(lines.length>1)fail('execution_state_duplicate_field')
 return lines[0] || ''
}
export function git(repo,args) {
 try { return execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}).trim() }
 catch { fail('execution_git_failed') }
}
export function gitBuffer(repo,args) {
 try { return execFileSync('git',['-C',repo,...args],{stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}) }
 catch { fail('execution_git_failed') }
}
export async function repoRoot(path) { return realpath(git(resolve(path),['rev-parse','--show-toplevel'])) }
export async function safePath(root, subpath, { create=false }={}) {
 if(isAbsolute(subpath)||subpath.includes('\\')||subpath.split('/').some(x=>!x||x==='.'||x==='..'))fail('execution_path_invalid')
 let target=root
 for(const part of subpath.split('/')) {
  target=join(target,part)
  let info=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e})
  if(!info&&create){await mkdir(target).catch(e=>{if(e.code!=='EEXIST')throw e});info=await lstat(target)}
  if(info&&(info.isSymbolicLink()||!info.isDirectory()))fail('execution_path_invalid')
 }
 return target
}
export async function textFile(root,path) {
 const dir=dirname(path);if(dir!=='.')await safePath(root,dir)
 const full=join(root,path),info=await lstat(full)
 if(info.isSymbolicLink()||!info.isFile()||info.size>1024*1024)fail('execution_path_invalid')
 return readFile(full,'utf8')
}
export async function jsonFile(root,path) {
 const dir=dirname(path);if(dir!=='.')await safePath(root,dir)
 return readJson(join(root,path))
}

// PROFILE is intentionally a small, dependency-free map rather than a general
// YAML document.  It lets local execution reuse the project's declared test
// entry points without teaching the recorder a second configuration language.
function profileCommandMap(text) {
 const line=String(text).split(/\r?\n/).find(value=>/^test-commands\s*:/.test(value.trim()))
 if(!line)return {}
 let body=line.trim().replace(/^test-commands\s*:\s*/, '').trim()
 if(body.startsWith('{')&&body.endsWith('}'))body=body.slice(1,-1)
 const result={};let key='',value='',quote='',escaped=false,readingKey=true
 const commit=()=>{const k=key.trim().replace(/^['"]|['"]$/g,'').toLowerCase();const v=value.trim().replace(/^['"]|['"]$/g,'');if(k&&v)result[k]=v;key='';value='';readingKey=true}
 for(let i=0;i<=body.length;i++) {
  const c=body[i]??','
  if(quote){if(escaped){if(readingKey)key+=c;else value+=c;escaped=false;continue}if(c==='\\'){escaped=true;continue}if(c===quote){quote='';continue}if(readingKey)key+=c;else value+=c;continue}
  if(c==='"'||c==="'"){quote=c;continue}
  if(readingKey&&c===':'){readingKey=false;continue}
  if(!readingKey&&c===','){commit();continue}
  if(readingKey)key+=c;else value+=c
 }
 return result
}
function commandArgv(value) {
 if(typeof value!=='string'||!value.trim())return null
 if(/^none(?:\s|$)/i.test(value.trim()))return {disabled:true}
 // PROFILE stores argv as text for portability, but the recorder never sends
 // it through a shell. Reject shell control/glob syntax instead of guessing.
 const out=[];let token='',quote='',escaped=false
 const flush=()=>{if(token){out.push(token);token=''}}
 for(const c of value.trim()) {
  if(quote){if(escaped){token+=c;escaped=false;continue}if(c==='\\'){escaped=true;continue}if(c===quote){quote='';continue}token+=c;continue}
  if(c==='"'||c==="'"){quote=c;continue}
  if(c==='\\'){escaped=true;continue}
  if(/\s/.test(c)){flush();continue}
  if(/[|;&<>*?`$]/.test(c))return null
  token+=c
 }
 if(quote||escaped)return null
 flush();return out.length?argvCheck(out):null
}
async function profileCommands(repo) {
 const profile=await textFile(repo,'.cap/PROFILE.md').catch(e=>{if(e.code==='ENOENT')return '';throw e})
 return profileCommandMap(profile)
}
async function exists(repo,name){return Boolean(await lstat(join(repo,name)).catch(()=>null))}
async function makeFileCommand(repo,stage) {
 const py=await exists(repo,'pyproject.toml')||await exists(repo,'pytest.ini')||await exists(repo,'tox.ini')||await exists(repo,'setup.cfg')
 if(py&&stage==='test')return ['python3','-m','pytest']
 if(await exists(repo,'Cargo.toml'))return stage==='test'?['cargo','test']:stage==='implement'?['cargo','check']:stage==='release'?['cargo','build','--release']:null
 if(await exists(repo,'go.mod'))return stage==='test'?['go','test','./...']:stage==='implement'||stage==='release'?['go','build','./...']:null
 if(await exists(repo,'pom.xml'))return stage==='test'?['mvn','test']:stage==='implement'?['mvn','-DskipTests','package']:stage==='release'?['mvn','package','-DskipTests']:null
 if(await exists(repo,'gradlew'))return stage==='test'?['./gradlew','test']:stage==='implement'?['./gradlew','build']:stage==='release'?['./gradlew','assemble']:null
 if(await exists(repo,'build.gradle')||await exists(repo,'build.gradle.kts'))return stage==='test'?['gradle','test']:stage==='implement'?['gradle','build']:stage==='release'?['gradle','assemble']:null
 if(await exists(repo,'Makefile')) {
  const make=await textFile(repo,'Makefile').catch(()=>''),target=stage==='test'?'test':stage==='implement'?'build':stage==='release'?'package':null
  if(target&&new RegExp(`^${target}\\s*:`,'m').test(make))return ['make',target]
 }
 return null
}
export async function atomicJson(path,value,{exclusive=false}={}) {
 const data=`${JSON.stringify(value,null,2)}\n`
 if(exclusive){await writeFile(path,data,{flag:'wx'});return}
 const temp=`${path}.${randomUUID()}.tmp`
 try { await writeFile(temp,data,{flag:'wx'});await rename(temp,path) } finally { await rm(temp,{force:true}) }
}
export const contractModel=parseJson(readFileSync(new URL('../../ontology/execution.json',import.meta.url),'utf8'))
export const ENFORCED_CONSTRAINTS=Object.freeze(['source-snapshot','command-exit-zero','contract-wired','no-opt-in-safety'])
export const GUARD_CONSTRAINTS=Object.freeze(['contract-wired','no-opt-in-safety'])
export function validateExecutionModel(model=contractModel) {
 if(model.schemaVersion!==2||model.trust!=='local-observed')fail('execution_contract_version')
 const stages=['understand','define','plan','implement','test','review','release']
 if(JSON.stringify(Object.keys(model.stages).sort())!==JSON.stringify([...stages].sort()))fail('execution_contract_stages')
 for(const s of stages){const c=model.stages[s];if(!c||!['build','test','package',null].includes(c.action)||!Array.isArray(c.constraints)||typeof c.evidence!=='string')fail('execution_contract_invalid')
  if(!c.action&&c.constraints.length)fail('execution_constraint_without_enforcer')
  if(new Set(c.constraints).size!==c.constraints.length||c.constraints.some(value=>!ENFORCED_CONSTRAINTS.includes(value)))fail('execution_constraint_without_enforcer')
  if(c.action&&['source-snapshot','command-exit-zero'].some(value=>!c.constraints.includes(value)))fail('execution_constraint_without_enforcer')
  if(s!=='test'&&c.constraints.some(value=>GUARD_CONSTRAINTS.includes(value)))fail('execution_constraint_without_enforcer')
  if(s==='test'&&GUARD_CONSTRAINTS.some(value=>!c.constraints.includes(value)))fail('execution_constraint_without_enforcer')
 }
 return model
}
validateExecutionModel()
export function executionContract(stage) { const c=contractModel.stages[stageName(stage)];if(!c)fail('execution_stage_contract_missing');return structuredClone(c) }
export const versions={ protocol:2, ontology:digest(contractModel), recorder:digest(['local-flow.mjs','local-support.mjs','test-state.mjs','contract-audit.mjs'].map(name=>readFileSync(new URL(name,import.meta.url),'utf8'))) }
export function argvCheck(argv) { if(!Array.isArray(argv)||!argv.length||argv.length>256||argv.some(s=>typeof s!=='string'||s.includes('\0')||s.length>16384)||!argv[0])fail('execution_command_invalid');return argv }
export function timeoutCheck(ms) { if(!Number.isSafeInteger(ms)||ms<1||ms>3600000)fail('execution_timeout_invalid');return ms }
export async function commandFor(repo,stage,explicit,action) {
 const contract=executionContract(stage),needsGuard=contract.constraints.some(value=>GUARD_CONSTRAINTS.includes(value))
 const guard=needsGuard?await guardCommand(repo,stage):null
 const decorate=value=>({...value,guard})
 if(explicit!==undefined&&explicit!==null)return decorate({argv:argvCheck(explicit),source:'explicit'})
 const profile=await profileCommands(repo)
 const profileKeys=stage==='test'?['unit','test']:stage==='implement'?['build']:stage==='release'?['package','pack','prepare','build']:[]
 for(const key of profileKeys){const argv=commandArgv(profile[key]);if(argv?.disabled)return decorate({argv:[],source:'.cap/PROFILE.md#test-commands',disabled:true});if(argv)return decorate({argv,source:'.cap/PROFILE.md#test-commands'}) }
 const path='.cap/execution-config.json'
 const config=await jsonFile(repo,path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(config){if(config.schemaVersion!==1||!config.commands||typeof config.commands!=='object')fail('execution_config_invalid');const value=config.commands[stage]||config.commands[action];if(value)return decorate({argv:argvCheck(value),source:path})}
 const pkg=await jsonFile(repo,'package.json').catch(e=>{if(e.code==='ENOENT')return null;throw e})
 const scripts=pkg?.scripts&&typeof pkg.scripts==='object'?pkg.scripts:null
 const scriptKeys=stage==='test'?['test']:stage==='implement'?['build']:stage==='release'?['package','pack','prepare','build']:[]
 const script=scriptKeys.find(key=>typeof scripts?.[key]==='string'&&scripts[key].trim())
 if(script) {
  let manager='npm'
  for(const [lock,tool] of [['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn']])if(await lstat(join(repo,lock)).catch(()=>null))manager=tool
  return decorate({argv:[manager,'run',script],source:'package.json'})
 }
 const discovered=await makeFileCommand(repo,stage)
 if(discovered)return decorate({argv:argvCheck(discovered),source:'project-files'})
 return decorate({argv:[],source:'missing'})
}
export async function guardCommand(repo,stage) {
 if(stage!=='test')return null
 const profile=await profileCommands(repo),declaredValue=profile['contract-guard']
 if(declaredValue!==undefined) {
  const declared=commandArgv(declaredValue)
  if(declared?.disabled) {
   const reason=declaredValue.replace(/^none\s*(?:—|–|-|:)\s*/i,'').trim()
   if(!/^none\s*(?:—|–|-|:)\s*\S/i.test(declaredValue)||!reason)fail('execution_guard_exemption_reason_required')
   return {argv:[],source:'.cap/PROFILE.md#contract-guard',disabled:true,reason}
  }
  if(!declared)fail('execution_guard_command_invalid')
  return {argv:declared,source:'.cap/PROFILE.md#contract-guard'}
 }
 const config=await jsonFile(repo,'.cap/execution-config.json').catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(config&&(config.schemaVersion!==1||!config.commands||typeof config.commands!=='object'))fail('execution_config_invalid')
 if(config&&Object.hasOwn(config.commands,'contract-guard'))return {argv:argvCheck(config.commands['contract-guard']),source:'.cap/execution-config.json#contract-guard'}
 return {argv:[process.execPath,fileURLToPath(new URL('./contract-audit.mjs',import.meta.url)),'--repo',repo,'--mode','diff'],source:'builtin'}
}
// Shared by status and canonical test-state completion/reconciliation. Main
// requests bind a separate immutable guard, so older targeted runs remain
// verifiable after the latest pointer advances to the full run.
export async function verifyRecordedGuard(repo,request,pointer=request.guard) {
 if(!executionContract(request.stage).constraints.some(value=>GUARD_CONSTRAINTS.includes(value)))return null
 if(!request.guard||!pointer)fail('execution_guard_missing')
 const policy=await guardCommand(repo,request.stage),bound=request.guard
 if(request.guardPolicyHash!==digest(policy))fail('execution_guard_failed')
 if(policy.disabled) {
  const expected={disabled:true,source:policy.source,reason:policy.reason,policyHash:digest(policy)}
  if(digest(bound)!==digest(expected)||digest(pointer)!==digest(expected))fail('execution_guard_failed')
  return {...expected,passed:true}
 }
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(bound.id||'')||bound.id===request.id||!/^[a-f0-9]{64}$/.test(bound.requestHash||''))fail('execution_guard_failed')
 if(pointer.id!==bound.id||pointer.requestHash!==bound.requestHash||pointer.source!==bound.source||bound.source!==policy.source||pointer.disabled)fail('execution_guard_failed')
 const evidence=await jsonFile(repo,`.cap/execution/${bound.id}/gate.json`)
 const e=evidence.envelope,r=evidence.receipt
 if(evidence.schemaVersion!==3||evidence.status!=='terminal'||evidence.envelopeHash!==digest(e)||evidence.envelopeHash!==bound.requestHash||evidence.receiptHash!==digest(r)||evidence.diagnosticHash!==digest(evidence.diagnostic))fail('execution_guard_failed')
 if(e?.schemaVersion!==2||e.trust!=='local-observed'||r?.schemaVersion!==2||r.authority!=='local-observed'||r.envelopeId!==e.id||r.envelopeHash!==evidence.envelopeHash)fail('execution_guard_failed')
 for(const key of ['repo','task','session','branch','commit'])if(e[key]!==request[key]||r[key]!==request[key])fail('execution_guard_failed')
 if(e.id!==bound.id||e.kind!=='guard'||e.guardOf!==request.id||e.guardSource!==policy.source||e.commandHash!==digest(policy.argv)||e.stage!==request.stage||e.action!==request.action||digest(e.constraints)!==digest(executionContract(request.stage).constraints)||digest(e.versions)!==digest(request.versions)||digest(e.snapshot)!==digest(request.snapshot))fail('execution_guard_failed')
 const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
 if(!validDate(e.startedAt)||!validDate(r.finishedAt)||r.finishedAt<e.startedAt||r.finishedAt>new Date().toISOString())fail('execution_guard_failed')
 if(!['passed','failed','timed_out','output_limit','spawn_failed'].includes(r.status)||!(r.exitCode===null||Number.isSafeInteger(r.exitCode))||!(r.signal===null||typeof r.signal==='string'&&r.signal.length>0)||!['stdoutHash','stderrHash'].every(key=>/^[a-f0-9]{64}$/.test(r[key]||'')))fail('execution_guard_failed')
 const passed=r.status==='passed'&&r.exitCode===0&&!r.signal&&digest(r.afterSnapshot)===digest(e.snapshot)
 return {...bound,gate:passed?'PASS':'BLOCKED',passed}
}
export async function nativeArgv(argv,env) {
 // Native .exe + node script paths are portable. npm's Windows .cmd shim must not introduce implicit shell parsing.
 if(process.platform==='win32'&&argv[0]==='npm') {
  const script=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')
  if(await lstat(script).catch(()=>null))return [process.execPath,script,...argv.slice(1)]
  fail('execution_windows_use_node_cli_path')
 }
 return argv
}
export async function observeCommand(argv,{cwd,env=process.env,timeoutMs=120000,maxOutputBytes=1024*1024}) {
 argv=await nativeArgv(argv,env);timeoutCheck(timeoutMs)
 return new Promise(resolveResult=>{
  const boundedCapture=limit=>{
   const headLimit=Math.ceil(limit/2),tailLimit=limit-headLimit
   let total=0,head=Buffer.alloc(0),tail=Buffer.alloc(0)
   return {append(data){const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);total+=chunk.length
    let offset=0
    if(head.length<headLimit){const take=Math.min(headLimit-head.length,chunk.length);head=Buffer.concat([head,chunk.subarray(0,take)]);offset=take}
    if(offset<chunk.length&&tailLimit>0){tail=Buffer.concat([tail,chunk.subarray(offset)]);if(tail.length>tailLimit)tail=tail.subarray(tail.length-tailLimit)}
   },text(){if(total<=limit)return Buffer.concat([head,tail]).toString('utf8')
    const lastLineBreak=Math.max(head.lastIndexOf(10),head.lastIndexOf(13))
    const tailBreaks=[tail.indexOf(10),tail.indexOf(13)].filter(index=>index>=0),firstLineBreak=tailBreaks.length?Math.min(...tailBreaks):-1
    if(lastLineBreak<0&&firstLineBreak<0)return `… [oversized single line removed for credential safety; bytes=${total}] …\n`
    const safeHead=lastLineBreak<0?Buffer.alloc(0):head.subarray(0,lastLineBreak+1)
    const safeTail=firstLineBreak<0?Buffer.alloc(0):tail.subarray(firstLineBreak+1)
    return `${safeHead.toString('utf8')}… [output truncated; incomplete boundary lines removed] …\n${safeTail.toString('utf8')}`
   }}
  }
  let child,bytes=0,reason='',timer,killTimer
  const stdoutCapture=boundedCapture(maxOutputBytes),stderrCapture=boundedCapture(maxOutputBytes)
  const finish=(exitCode,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolveResult({exitCode:Number.isInteger(exitCode)?exitCode:null,signal:signal||null,status:reason||((exitCode===0&&!signal)?'passed':'failed'),stdout:stdoutCapture.text(),stderr:stderrCapture.text()})}
  const kill=()=>{
   if(process.platform==='win32'){try {const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});killer.on('error',()=>child.kill())} catch {child.kill()}}
   else {try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}}
  }
  const stop=(why,{graceMs=0}={})=>{if(reason)return;reason=why;if(graceMs>0)killTimer=setTimeout(kill,graceMs);else kill()
  }
  try{const inherited={...env};delete inherited.CAP_LOCAL_EXECUTION_SECRET
   child=spawn(argv[0],argv.slice(1),{cwd,env:inherited,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
  }catch{reason='spawn_failed';finish(null,null);return}
  child.on('error',()=>{reason='spawn_failed'})
  for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',data=>{
   bytes+=data.length
   if(key==='stdout')stdoutCapture.append(data);else stderrCapture.append(data)
   if(bytes>maxOutputBytes)stop('output_limit',{graceMs:100})
  })
  timer=setTimeout(()=>stop('timed_out'),timeoutMs)
  child.on('close',finish)
 })
}
