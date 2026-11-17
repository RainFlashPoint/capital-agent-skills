#!/usr/bin/env node
// Conservative lexical heuristic, not semantic proof or Server authority.
// A quoted filename is ONLY lexical wiring evidence: it does not prove that
// runtime loads/validates the schema or executes the referencing code.
// Diff checks uncommitted additions/renames and added safety condition lines.
// Full is advisory inventory; findings do not fail it, incomplete scans do.
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const excluded=path=>/(^|\/)(?:node_modules|vendor|vendors|third_party|third-party|\.venv|venv|site-packages|\.cap|\.git|dist|build|out|coverage|\.next|\.nuxt|__pycache__)\//i.test(path)
const testFile=path=>/(^|\/)(?:tests?|__tests__|fixtures?|__mocks__)\//i.test(path)||/(^|\/)(?:test[-_]|.*[._]test[._]|.*[._]spec[._])/.test(path)
const sourceFile=path=>/\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx|py)$/.test(path)
const production=path=>sourceFile(path)&&!excluded(path)&&!testFile(path)
const contractFile=path=>!excluded(path)&&!testFile(path)&&/(?:^|\/)docs\/contracts\/.*\.json$|\.schema\.json$/i.test(path)
const safetyWords=/^(?:gates?|preflight|authori[sz](?:ation|e|ed)|enforce|enforcement|deny|permissions?|capabilit(?:y|ies)|security|policy)$/i
const safetyIdentifier=value=>value.replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/[^A-Za-z]+/).some(word=>safetyWords.test(word))
const safetyAction=text=>{const call=text.match(/^(?:(?:return|await|throw|raise)\s+)*(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\(/);return Boolean(call&&safetyIdentifier(call[1]))}
const flag=/^(?:enforce(?:[A-Z_][\w$]*)?|require(?:[A-Z_][\w$]*)?|must[A-Z_][\w$]*|should[A-Z_][\w$]*|skip(?:Gate|Preflight|Safety|Auth[\w$]*|Permission[\w$]*)|legacyQueue)$/
const nul=value=>value.split('\0').filter(Boolean)

// Preserve positions/newlines while masking comments; strings are kept only
// for wiring. This deliberately is not a JS/Python parser (e.g. computed keys,
// aliases, templates/interpolation and indirect control flow may be missed).
function mask(text,python,strings=false) {
 const token=python ? /#[^\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g : /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g
 return text.replace(token,value=>{
  const comment=python?value.startsWith('#'):value.startsWith('//')||value.startsWith('/*')
  return comment||strings?value.replace(/[^\r\n]/g,' '):value
 })
}
function safetyConditions(text,path) {
 const clean=mask(text,path.endsWith('.py'),true),lines=clean.split(/\r?\n/),hits=[]
 // Narrow to if conditions, not assignments or arbitrary configuration reads.
 const condition=path.endsWith('.py')?/^[ \t]*if[ \t]+([^:\r\n]+):([^\r\n]*)/gm:/^[ \t]*(?:else[ \t]+)?if[ \t]*\(([^)\r\n]*)\)([^\r\n]*)/gm
 for(const match of clean.matchAll(condition)) {
  const cond=match[1].trim(),line=clean.slice(0,match.index).split('\n').length
  const member=cond.match(/^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*(?:(===|==|is)\s*(true|True)|(!==|!=|is\s+not)\s*(false|False))?$/)
  if(!member||!flag.test(member[1]))continue
  // Receiver names carry no authority. A safety path or a nearby safety action
  // is required; legacyQueue additionally needs an action to avoid business data.
  // Only the first controlled statement is used as action evidence. Never
  // borrow a following sibling call/declaration as if it were in this if.
  const inline=match[2].trim(),next=lines[line]||''
  const indentation=value=>value.match(/^[ \t]*/)[0].length
  const follows=(inline===''||inline==='{')&&(inline==='{'||indentation(next)>indentation(lines[line-1]))
  const action=(follows?next.trim():inline.replace(/^\{[ \t]*/, '')).split(/[;}]/)[0].trim()
  if(!(safetyIdentifier(path)||safetyAction(action)))continue
  if(member[1]==='legacyQueue'&&!safetyAction(action))continue
  hits.push({start:line,end:line+match[0].split('\n').length-1})
 }
 return hits
}

export function auditContracts(repoPath='.',{mode='diff'}={}) {
 if(!['diff','full'].includes(mode))throw new Error('contract_audit_mode_invalid')
 const repo=resolve(repoPath)
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024})
 git('rev-parse','--verify','HEAD')
 const untracked=nul(git('ls-files','-z','--others','--exclude-standard'))
 const inventory=[...new Set(nul(git('ls-files','-z','--cached','--others','--exclude-standard')))].filter(path=>{
  try{lstatSync(join(repo,path));return true}catch(error){if(error.code==='ENOENT')return false;throw error}
 })
 const files=new Set(mode==='full'?inventory:untracked),sourceChanges=new Set(untracked)
 const changes=(filter,target)=>{
  const values=nul(git('diff','--name-status','-z','--find-renames',`--diff-filter=${filter}`,'HEAD','--'))
  for(let i=0;i<values.length;) {const status=values[i++];if(status[0]==='R')i++;target.add(values[i++])}
 }
 if(mode==='diff'){changes('AR',files);changes('AMR',sourceChanges)}
 const cache=new Map()
 const read=path=>{
  if(cache.has(path))return cache.get(path)
  const target=join(repo,path)
  let current=repo
  for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('contract_audit_symlink')}
  if(!lstatSync(target).isFile())throw new Error('contract_audit_file_invalid')
  const text=readFileSync(target,'utf8');cache.set(path,text);return text
 }
 const productionPaths=inventory.filter(production),contracts=[...files].filter(contractFile),failures=[]
 const sources=contracts.length?productionPaths.map(path=>mask(read(path),path.endsWith('.py'))):[]
 for(const path of contracts) {
  read(path)
  const base=path.split('/').at(-1).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const reference=new RegExp('[\'"`]'+ '(?:[^\'"`\\n]*[/])?'+base+'[\'"`]')
  if(!sources.some(text=>reference.test(text)))failures.push({code:'contract_not_wired',file:path,detail:'No quoted filename reference in production source (lexical evidence only).',remediation:'Wire runtime consumption and verify it independently, or record a reasoned PROFILE exemption.'})
 }
 for(const path of [...(mode==='full'?inventory:sourceChanges)].filter(production)) {
  const text=read(path)
  let added=null
  if(mode==='diff'&&!untracked.includes(path)) {
   added=new Set();let line=0
   for(const row of git('diff','--unified=0','--no-ext-diff','--no-textconv','HEAD','--',path).split('\n')) {
    const hunk=row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if(hunk){line=Number(hunk[1]);continue}
    if(row.startsWith('+++')||row.startsWith('---'))continue
    if(row.startsWith('+'))added.add(line++)
    else if(row.startsWith(' '))line++
   }
  }
  for(const hit of safetyConditions(text,path))if(!added||[...added].some(line=>line>=hit.start&&line<=hit.end))failures.push({code:'safety_opt_in',file:path,line:hit.start,detail:'Possible safety enforcement controlled by an optional boolean condition (heuristic).',remediation:'Check enforcement defaults; use an auditable policy for any exception.'})
 }
 const advisory=mode==='full'
 return {ok:advisory||failures.length===0,mode,advisory,scanComplete:true,gatePassed:advisory?null:failures.length===0,checked:contracts.length,inventoryFiles:inventory.length,productionFiles:productionPaths.length,inspectedFiles:cache.size,failures}
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
 try {
  const args=process.argv.slice(2),allowed=new Set(['--repo','--mode'])
  for(let i=0;i<args.length;i+=2)if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('contract_audit_arguments_invalid')
  const arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]}
  const result=auditContracts(arg('--repo','.'),{mode:arg('--mode','diff')})
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
 }catch{console.log(JSON.stringify({ok:false,scanComplete:false,gatePassed:null,failures:[{code:'contract_audit_error',detail:'Audit could not complete; no gate conclusion was produced.'}]}));process.exitCode=1}
}
