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
 const profile=await profileCommands(repo)
 const profileKeys=stage==='test'?['unit','test']:stage==='implement'?['build']:stage==='release'?['package','pack','prepare','build']:[]
 for(const key of profileKeys){const argv=commandArgv(profile[key]);if(argv?.disabled)return {argv:[],source:'.cap/PROFILE.md#test-commands',disabled:true};if(argv)return {argv,source:'.cap/PROFILE.md#test-commands'} }
 const path='.cap/execution-config.json'
 const config=await jsonFile(repo,path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(config){if(config.schemaVersion!==1||!config.commands||typeof config.commands!=='object')fail('execution_config_invalid');const value=config.commands[stage]||config.commands[action];if(value)return {argv:argvCheck(value),source:path}}
 const pkg=await jsonFile(repo,'package.json').catch(e=>{if(e.code==='ENOENT')return null;throw e})
 const scripts=pkg?.scripts&&typeof pkg.scripts==='object'?pkg.scripts:null
 const scriptKeys=stage==='test'?['test']:stage==='implement'?['build']:stage==='release'?['package','pack','prepare','build']:[]
 const script=scriptKeys.find(key=>typeof scripts?.[key]==='string'&&scripts[key].trim())
 if(script) {
  let manager='npm'
  for(const [lock,tool] of [['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn']])if(await lstat(join(repo,lock)).catch(()=>null))manager=tool
  return {argv:[manager,'run',script],source:'package.json'}
 }
 const discovered=await makeFileCommand(repo,stage)
 if(discovered)return {argv:argvCheck(discovered),source:'project-files'}
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
