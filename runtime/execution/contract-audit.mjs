#!/usr/bin/env node
// Local heuristic audit, not a proof of runtime validation or Server authority.
// Diff mode only enrolls added/renamed and untracked files; full is inventory.
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const contractFile=path=>/(?:^|\/)docs\/contracts\/.*\.json$|\.schema\.json$/i.test(path)
const sourceFile=path=>/\.(?:mjs|cjs|js|ts|tsx|py)$/.test(path)
const testFile=path=>/(^|\/)(?:tests?|__tests__|fixtures?)\//.test(path)||/(^|\/)(?:test[-_]|.*[._]test[._]|.*[._]spec[._])/.test(path)
const production=path=>/^(?:src|lib|app|runtime|scripts)\//.test(path)&&sourceFile(path)&&!testFile(path)
const safety=/gate|preflight|authori[sz]|enforce|deny|permission|capabilit/i
const optIn=/\b(?:enforce|require|must|should)[A-Z_$][\w$]*\s*===\s*true\b|\b(?:input|options|request|params)\.(?:enforce|legacy|skip)[\w$]*\s*===?\s*(?:true|false)\b/
const nul=value=>value.split('\0').filter(Boolean)

export function auditContracts(repoPath='.',{mode='diff'}={}) {
 if(!['diff','full'].includes(mode))throw new Error('contract_audit_mode_invalid')
 const repo=resolve(repoPath)
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024})
 git('rev-parse','--verify','HEAD')
 const inventory=[...new Set(nul(git('ls-files','-z','--cached','--others','--exclude-standard')))].filter(path=>{
  try{lstatSync(join(repo,path));return true}catch(error){if(error.code==='ENOENT')return false;throw error}
 })
 const files=new Set()
 const sourceChanges=new Set()
 if(mode==='full')for(const path of inventory)files.add(path)
 else {
  const changes=nul(git('diff','--name-status','-z','--find-renames','--diff-filter=AR','HEAD','--'))
  for(let i=0;i<changes.length;) {
   const status=changes[i++];if(status[0]==='R'){i++;files.add(changes[i++])}else files.add(changes[i++])
  }
  for(const path of nul(git('ls-files','-z','--others','--exclude-standard')))files.add(path)
  const changed=nul(git('diff','--name-status','-z','--find-renames','--diff-filter=AMR','HEAD','--'))
  for(let i=0;i<changed.length;) {
   const status=changed[i++]
   if(status[0]==='R'){i++;sourceChanges.add(changed[i++])}else sourceChanges.add(changed[i++])
  }
  for(const path of nul(git('ls-files','-z','--others','--exclude-standard')))sourceChanges.add(path)
 }
 const read=path=>{
  const target=join(repo,path)
  // Refuse redirected content rather than inspecting outside the target repo.
  let current=repo
  for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('contract_audit_symlink')}
  if(!lstatSync(target).isFile())throw new Error('contract_audit_file_invalid')
  return readFileSync(target,'utf8')
 }
 const sources=inventory.filter(production).map(path=>({path,text:read(path)}))
 const failures=[]
 for(const path of [...files].filter(contractFile)) {
  read(path)
  const base=path.split('/').at(-1)
  // A version tag such as schema: 'harness-preflight/v1' is not a file consumer.
  const needles=[base]
  // Match quoted names in executable files, not plain prose/comments or tests.
  const wired=sources.some(source=>source.text.split('\n').some(line=>{
   if(/^\s*(?:\/\/|\*|#)/.test(line))return false
   return needles.some(needle=>{
    const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    return new RegExp('[\'"`]'+ '(?:[^\'"`]*[/])?'+escaped+'[\'"`]').test(line)
   })
  }))
  if(!wired)failures.push({code:'contract_not_wired',file:path,detail:'Contract has no production reference; test/document references do not wire it.',remediation:'Wire runtime consumption or record a reasoned PROFILE contract-guard exemption.'})
 }
 for(const path of [...(mode==='full'?files:sourceChanges)].filter(path=>sourceFile(path)&&!testFile(path))) {
  let lines=read(path).split(/\r?\n/)
  if(mode==='diff'&&nul(git('ls-files','-z','--',path)).length) {
   lines=git('diff','--unified=0','HEAD','--',path).split(/\r?\n/).filter(line=>line.startsWith('+')&&!line.startsWith('+++')).map(line=>line.slice(1))
  }
  for(const line of lines)if(!/^\s*(?:\/\/|\*|#)/.test(line)&&/\b(?:if|return|const|let)\b|=>|\?/.test(line)&&optIn.test(line)&&(safety.test(path)||safety.test(line))) {
   failures.push({code:'safety_opt_in',file:path,detail:'Safety enforcement depends on a caller opt-in.',remediation:'Run safety checks by default; use an auditable server policy for any migration exception.'})
  }
 }
 return {ok:failures.length===0,mode,checked:[...files].filter(contractFile).length,scannedFiles:files.size,failures}
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
 try {
  const args=process.argv.slice(2),allowed=new Set(['--repo','--mode'])
  for(let i=0;i<args.length;i+=2)if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('contract_audit_arguments_invalid')
  const arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]}
  const result=auditContracts(arg('--repo','.'),{mode:arg('--mode','diff')})
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
 }catch{console.log(JSON.stringify({ok:false,failures:[{code:'contract_audit_error',detail:'Audit could not complete; no PASS evidence was produced.'}]}));process.exitCode=1}
}
