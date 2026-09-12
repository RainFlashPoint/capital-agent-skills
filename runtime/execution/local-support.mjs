import { readFile, lstat, mkdir, rename, writeFile, realpath, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, isAbsolute, dirname, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { digest } from '../ontology/schema.mjs'
import { parseJson, readJson } from '../ontology/json.mjs'

export const fail = code => { throw new Error(code) }
export const stageName = name => ({ map:'understand',shape:'define',build:'implement',verify:'test' }[name] || name)
export function field(text, name) {
 const lines=String(text).split(/\r?\n/).filter(line=>line.startsWith(`${name}:`)).map(line=>line.slice(name.length+1).trim())
 if(lines.length>1)fail('execution_state_duplicate_field')
 return lines[0] || ''
}
export function git(repo,args) {
 try { return execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}).trim() }
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
export async function atomicJson(path,value,{exclusive=false}={}) {
 const data=`${JSON.stringify(value,null,2)}\n`
 if(exclusive){await writeFile(path,data,{flag:'wx'});return}
 const temp=`${path}.${randomUUID()}.tmp`
 try { await writeFile(temp,data,{flag:'wx'});await rename(temp,path) } finally { await rm(temp,{force:true}) }
}
export const contractModel=parseJson(readFileSync(new URL('../../ontology/execution.json',import.meta.url),'utf8'))
export function validateExecutionModel(model=contractModel) {
 if(model.schemaVersion!==2||model.trust!=='local-observed')fail('execution_contract_version')
 const stages=['understand','define','plan','implement','test','review','release']
 if(JSON.stringify(Object.keys(model.stages).sort())!==JSON.stringify([...stages].sort()))fail('execution_contract_stages')
 for(const s of stages){const c=model.stages[s];if(!c||!['build','test','package',null].includes(c.action)||!Array.isArray(c.constraints)||typeof c.evidence!=='string')fail('execution_contract_invalid')
  if(JSON.stringify(c.constraints)!==JSON.stringify(c.action?['source-snapshot','command-exit-zero']:[]))fail('execution_constraint_without_enforcer')
 }
 return model
}
validateExecutionModel()
export function executionContract(stage) { const c=contractModel.stages[stageName(stage)];if(!c)fail('execution_stage_contract_missing');return structuredClone(c) }
export const versions={ protocol:2, ontology:digest(contractModel), recorder:digest(['local-flow.mjs','local-support.mjs'].map(name=>readFileSync(new URL(name,import.meta.url),'utf8'))) }
export function argvCheck(argv) { if(!Array.isArray(argv)||!argv.length||argv.length>256||argv.some(s=>typeof s!=='string'||s.includes('\0')||s.length>16384)||!argv[0])fail('execution_command_invalid');return argv }
export function timeoutCheck(ms) { if(!Number.isSafeInteger(ms)||ms<1||ms>3600000)fail('execution_timeout_invalid');return ms }
export async function commandFor(repo,stage,explicit,action) {
 if(explicit!==undefined&&explicit!==null)return {argv:argvCheck(explicit),source:'explicit'}
 const path='.cap/execution-config.json'
 const config=await jsonFile(repo,path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(config){if(config.schemaVersion!==1||!config.commands||typeof config.commands!=='object')fail('execution_config_invalid');const value=config.commands[stage]||config.commands[action];if(value)return {argv:argvCheck(value),source:path}}
 const pkg=await jsonFile(repo,'package.json').catch(e=>{if(e.code==='ENOENT')return null;throw e})
 const script={implement:'build',test:'test',release:'build'}[stage]
 if(pkg?.scripts?.[script]) {
  let manager='npm'
  for(const [lock,tool] of [['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn']])if(await lstat(join(repo,lock)).catch(()=>null))manager=tool
  return {argv:[manager,'run',script],source:'package.json'}
 }
 return {argv:[],source:'missing'}
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
  let child,stdout='',stderr='',bytes=0,reason='',timer
  const finish=(exitCode,signal)=>{clearTimeout(timer);resolveResult({exitCode:Number.isInteger(exitCode)?exitCode:null,signal:signal||null,status:reason||((exitCode===0&&!signal)?'passed':'failed'),stdout,stderr})}
  const stop=why=>{if(reason)return;reason=why
   if(process.platform==='win32'){try {const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});killer.on('error',()=>child.kill())} catch {child.kill()}}
   else {try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}}
  }
  try{const inherited={...env};delete inherited.CAP_LOCAL_EXECUTION_SECRET
   child=spawn(argv[0],argv.slice(1),{cwd,env:inherited,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
  }catch{reason='spawn_failed';finish(null,null);return}
  child.on('error',()=>{reason='spawn_failed'})
  for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',data=>{
   const remaining=Math.max(0,maxOutputBytes-bytes),chunk=data.subarray(0,remaining).toString('utf8');bytes+=data.length
   if(key==='stdout')stdout+=chunk;else stderr+=chunk
   if(bytes>maxOutputBytes)stop('output_limit')
  })
  timer=setTimeout(()=>stop('timed_out'),timeoutMs)
  child.on('close',finish)
 })
}
