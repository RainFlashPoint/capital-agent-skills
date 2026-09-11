import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { validate, digest } from './schema.mjs'

const aliases={map:'understand',shape:'define',build:'implement',verify:'test'}
const stages=['understand','define','plan','implement','test','review','release','done']
const statuses=['in-progress','gated','blocked','done']
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const SHA=/^[a-f0-9]{40}$/
const FIELD_NAMES=['task-id','stage','status','branch','source-commit','candidate-commit','delivery-head','head']
export function parseFields(markdown) {
  const values={}
  for(const key of FIELD_NAMES) {
    const rx=new RegExp(`^(?:- )?${key}:\\s*([^\\r\\n]*)$`,'gm')
    const list=[...markdown.matchAll(rx)].map(m=>m[1].trim().replace(/\s+#.*$/,'').replace(/^["']|["']$/g,''))
    values[key]=[...new Set(list)]
  }
  return values
}
function fromFields(fields,binding,origin) {
  const unknowns=[]
  const field=(key,pattern=null)=>{
    const list=fields[key]??[]
    if(list.length!==1){unknowns.push(`${list.length?'ambiguous':'missing'}_${key.replaceAll('-','_')}`);return null}
    if(pattern&&!pattern.test(list[0])){unknowns.push(`invalid_${key.replaceAll('-','_')}`);return null}
    return list[0]
  }
  let stage=field('stage'),status=field('status')
  if(Object.hasOwn(aliases,stage)){stage=aliases[stage];unknowns.push('legacy_stage_alias')}
  if(!stages.includes(stage)){stage=null;unknowns.push('unsupported_stage')}
  if(!statuses.includes(status)){status=null;unknowns.push('unsupported_status')}
  const commits=[...new Set(['source-commit','candidate-commit','delivery-head'].flatMap(k=>fields[k]??[]))]
  let commit=commits.length===1&&SHA.test(commits[0])?commits[0]:null
  if(!commit) unknowns.push(commits.length>1?'ambiguous_commit':'missing_candidate_commit')
  const task={schemaVersion:1,scope:binding.scope,repo:binding.repo,task:field('task-id',ID),branch:field('branch',/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),commit,stage,status,artifacts:[],claims:[],unknowns:[...new Set(unknowns)].sort(),blockers:[],origin}
  validate('instance',task)
  return task
}
export function migrateLegacy(input,binding) {
  validate('binding',binding)
  if(input===null||typeof input!=='object'||Array.isArray(input)) throw new Error('migration_invalid_input')
  if(input.schemaVersion===1) {validate('instance',input);if(input.scope.tenant!==binding.scope.tenant||input.scope.project!==binding.scope.project||input.repo!==binding.repo)throw new Error('migration_scope_mismatch');return structuredClone(input)}
  if(input.schemaVersion!==undefined&&input.schemaVersion!==0) throw new Error('migration_unsupported_version')
  const fields=Object.fromEntries(FIELD_NAMES.map(k=>[k,typeof input[k]==='string'?[input[k]]:[]]))
  const result=fromFields(fields,binding,'legacy-migration')
  if(Object.keys(input).some(k=>k!=='schemaVersion'&&!FIELD_NAMES.includes(k))) result.unknowns.push('legacy_unknown_fields')
  return result
}
async function safeRead(root,path,budget) {
  if(isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>p==='..'||p==='')) throw new Error('input_path_escape')
  const abs=join(root,path)
  let current=root
  for(const segment of path.split('/')) {
    current=join(current,segment)
    const info=await lstat(current)
    if(info.isSymbolicLink()) throw new Error('input_symlink_rejected')
  }
  const rel=relative(root,await realpath(abs))
  if(rel.startsWith('..')||isAbsolute(rel)) throw new Error('input_path_escape')
  const fh=await open(abs,constants.O_RDONLY | (constants.O_NOFOLLOW??0))
  try {
    const info=await fh.stat()
    if(!info.isFile()) throw new Error('input_not_regular_file')
    if(info.size>256*1024||budget.bytes+info.size>4*1024*1024||budget.files>=128) throw new Error('input_size_limit')
    const buffer=Buffer.alloc(256*1024+1)
    let used=0
    while(used<buffer.length){const r=await fh.read(buffer,used,buffer.length-used,null);if(!r.bytesRead)break;used+=r.bytesRead}
    if(used>256*1024)throw new Error('input_size_limit')
    budget.files++;budget.bytes+=used
    if(budget.bytes>4*1024*1024) throw new Error('input_size_limit')
    return buffer.subarray(0,used).toString('utf8')
  } finally {await fh.close()}
}
export async function importCap(repoPath,binding) {
  validate('binding',binding)
  // No shell, Git configuration, scripts, Markdown commands or recursive history traversal.
  const requested=resolve(repoPath),root=await realpath(requested)
  if((await lstat(requested)).isSymbolicLink()) throw new Error('input_symlink_root')
  const cap=join(root,'.cap'), info=await lstat(cap)
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('input_symlink_cap')
  const budget={bytes:0,files:0},stateText=await safeRead(root,'.cap/STATE.md',budget)
  const task=fromFields(parseFields(stateText),binding,'cap-import')
  task.artifacts.push({kind:'state',path:'.cap/STATE.md',hash:digest(stateText)})
  const files=[['PROFILE.md','profile'],['task-context.md','context'],['spec.md','spec'],['plan.md','plan'],['experience.md','experience']]
  for(const [dir,kind] of [['verify','verification'],['review','review'],['release','environment']]) {
    let entries
    try {
      const di=await lstat(join(cap,dir));if(di.isSymbolicLink()||!di.isDirectory()) throw new Error('input_symlink_directory')
      entries=await readdir(join(cap,dir),{withFileTypes:true})
    }catch(e){if(e.code==='ENOENT')continue;throw e}
    if(entries.length>128)throw new Error('input_size_limit')
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if(entry.isSymbolicLink()) throw new Error('input_symlink_rejected')
      if(entry.isFile()&&entry.name.endsWith('.md'))files.push([`${dir}/${entry.name}`,kind])
    }
  }
  for(const [file,kind] of files) {
    let text
    try{text=await safeRead(root,`.cap/${file}`,budget)}catch(e){if(e.code==='ENOENT')continue;throw e}
    const hash=digest(text),path=`.cap/${file}`
    task.artifacts.push({kind,path,hash})
    if(kind==='context'&&binding.expectedCommit) {
      const heads=parseFields(text).head
      if(heads.length!==1||heads[0]!==binding.expectedCommit)task.blockers.push('context_commit_mismatch')
    }
    if(['verification','review','environment'].includes(kind)) {
      // Deliberately conservative: a document may contain several conflicting claims. Never collapse to PASS.
      const matches=[...new Set(text.match(/\b(?:PASS|FAIL|ENV_BLOCKED|INCONCLUSIVE)\b/g)??[])]
      for(const status of matches.sort())task.claims.push({kind,status,source:path,hash})
    }
  }
  if(binding.expectedBranch&&task.branch!==binding.expectedBranch)task.blockers.push('branch_mismatch')
  if(binding.expectedCommit&&task.commit!==binding.expectedCommit)task.blockers.push('candidate_commit_unconfirmed')
  task.artifacts.sort((a,b)=>a.path.localeCompare(b.path,'en'))
  task.blockers=[...new Set(task.blockers)].sort()
  return validate('instance',task)
}
