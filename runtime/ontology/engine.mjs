import { graphFromInstance } from './graph.mjs'
import { readFileSync } from 'node:fs'
import { validate, canonical, digest, active, validWindow } from './schema.mjs'
const model = JSON.parse(readFileSync(new URL('../../ontology/states.json', import.meta.url), 'utf8'))
export const dimensions = ['tenant','project','provider','product','contractVersion','environment']
const byId = (a,b) => a.id.localeCompare(b.id, 'en')
const fail = code => { throw new Error(code) }
function unique(items) { if(new Set(items.map(x=>x.id)).size!==items.length) fail('duplicate_identity') }
function checkAuthority(q,a) {
  validate('query',q); validate('authority',a)
  if(a.tenant!==q.tenant) fail('authority_tenant_mismatch')
  for(const kind of ['grants','overrides','receipts','publications','admissions']) unique(a[kind])
  for(const item of [...a.grants,...a.overrides]) {
    if(item.scope.tenant!==a.tenant || !validWindow(item.validFrom,item.validUntil)) fail('authority_scope_invalid')
  }
  for(const r of a.receipts) if(r.tenant!==a.tenant||!validWindow(r.issuedAt,r.expiresAt)) fail('receipt_scope_invalid')
}
function matching(scope,q) {
  let unknown=false
  for(const d of dimensions) if(scope[d]!==null) {
    if(q[d]===null) unknown=true
    else if(scope[d]!==q[d]) return 'excluded'
  }
  return unknown ? 'unknown' : 'matched'
}
function verifyRecord(r) {
  validate('record',r)
  if(!r.id.startsWith(`${r.namespace}/`)) fail('record_namespace_mismatch')
  if(r.namespace!==(r.scope.tenant===null ? 'public' : `tenant:${r.scope.tenant}`)) fail('record_namespace_scope_mismatch')
  if((r.scope.product!==null || r.scope.contractVersion!==null)&&r.scope.provider===null) fail('record_provider_required')
  if(r.scope.contractVersion!==null&&r.scope.product===null) fail('record_product_required')
  if(!validWindow(r.validFrom,r.validUntil)) fail('record_validity_invalid')
  if(r.supersedes.includes(r.id) || new Set(r.supersedes).size!==r.supersedes.length) fail('record_supersedes_invalid')
  if(/[:?#]/.test(r.source.path))fail('record_source_path_invalid')
  if(!/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\x00-\x1f]+$/.test(r.source.path)) fail('record_source_path_invalid')
}
export function resolveKnowledge(records,q,a) {
  checkAuthority(q,a)
  if(!Array.isArray(records)||records.length>1000) fail('catalog_limit')
  // Scope before value/schema diagnostics: foreign records never enter output.
  if(records.some(r=>!r?.scope||!Object.hasOwn(r.scope,'tenant')||r.scope.tenant!==null&&typeof r.scope.tenant!=='string'))fail('catalog_scope_required')
  const scoped=records.filter(r=>r?.scope?.tenant===q.tenant||r?.scope?.tenant===null)
  scoped.forEach(verifyRecord); unique(scoped)
  const visible=scoped.filter(r=>r.scope.tenant!==null||a.publications.some(p=>p.id===r.id&&p.hash===digest(r)))
  const eligible=[],unknowns=[],excluded=[]
  for(const r of [...visible].sort(byId)) {
    const match=matching(r.scope,q)
    if(match==='excluded') continue
    if(r.state!=='validated'||!active(r.validFrom,r.validUntil,q.now)||r.scope.tenant!==null&&!a.admissions.some(p=>p.id===r.id&&p.hash===digest(r))) {excluded.push({id:r.id,code:'inactive'});continue}
    if(r.conditions.commit!==null&&q.commit===null || match==='unknown') {unknowns.push({id:r.id,code:'missing_applicability'});continue}
    if(r.conditions.commit!==null&&r.conditions.commit!==q.commit) {excluded.push({id:r.id,code:'version_mismatch'});continue}
    eligible.push(r)
  }
  const ids=new Map(eligible.map(r=>[r.id,r])), replaced=new Set(), invalid=new Set(), conflicts=[]
  const edges=new Map(eligible.map(r=>[r.id,r.supersedes.filter(id=>ids.has(id))]))
  const cycleMemo=new Map()
  function cyclic(id,path=new Set()) { if(path.has(id)) return true;if(cycleMemo.has(id))return cycleMemo.get(id);const result=(edges.get(id)??[]).some(next=>cyclic(next,new Set([...path,id])));cycleMemo.set(id,result);return result }
  for(const r of eligible) {
    if(cyclic(r.id)) {invalid.add(r.key);continue}
    for(const oldId of r.supersedes) {
      const old=ids.get(oldId)
      const delegated=a.overrides.some(o=>o.older===oldId&&o.newer===r.id&&o.key===r.key&&matching(o.scope,q)==='matched'&&active(o.validFrom,o.validUntil,q.now))
      // Substitutions are only inside an identical scope/key and never for constraints/public definitions.
      if(!old||!delegated||old.kind!==r.kind||old.key!==r.key||r.kind==='constraint'||r.scope.tenant===null||old.scope.tenant===null||canonical(old.scope)!==canonical(r.scope)||r.revision<=old.revision) invalid.add(r.key)
      else replaced.add(oldId)
    }
  }
  const facts=[]
  for(const key of [...new Set(eligible.map(r=>r.key))].sort()) {
    const group=eligible.filter(r=>r.key===key)
    const remaining=group.filter(r=>!replaced.has(r.id))
    if(invalid.has(key)||new Set(remaining.map(r=>canonical([r.kind,r.value]))).size>1) {
      conflicts.push({key,code:invalid.has(key)?'invalid_supersession':'contradictory_values',ids:group.map(r=>r.id).sort()});continue
    }
    if(remaining.length) facts.push({key,kind:remaining[0].kind,value:remaining[0].value,trust:'knowledge-not-authority',sources:remaining.map(r=>({id:r.id,revision:r.revision,source:r.source,hash:digest(r)}))})
  }
  return {schemaVersion:1,facts,conflicts,unknowns,excluded}
}
function granted(action,q,a) {
  const candidates=a.grants.filter(g=>g.subject===q.agent&&g.action===action&&matching(g.scope,q)==='matched'&&active(g.validFrom,g.validUntil,q.now))
  return candidates.some(g=>g.effect==='allow')&&!candidates.some(g=>g.effect==='deny')
}
export function evaluateTask(task,q,a) {
  validate('instance',task); checkAuthority(q,a)
  if(task.scope.tenant!==q.tenant||task.scope.project!==q.project||task.repo!==q.repo)fail('instance_scope_mismatch')
  const blockers=[...task.blockers,...task.unknowns]
  const requiredIdentity=['task','repo','branch','commit']
  if(dimensions.some(d=>task.scope[d]!==q[d])||requiredIdentity.some(k=>task[k]!==q[k])) blockers.push('task_identity_mismatch')
  if(requiredIdentity.some(k=>task[k]===null)||!task.stage||!task.status) blockers.push('task_identity_incomplete')
  if(task.status==='blocked'||task.status==='gated') blockers.push('task_declared_blocked')
  if(task.claims.some(c=>c.status!=='PASS')) blockers.push('reported_verification_blocker')
  const route=model.routes[q.complexity]
  if(task.stage&&!route.includes(task.stage)) blockers.push('stage_outside_route')
  const required=[...(model.requires[task.stage]??[])]
  if(task.stage==='done') {
    if(q.complexity!=='L1') required.push('review')
    if(q.complexity==='L4') required.push('environment','delivery')
  }
  const evidence=a.receipts.filter(r=>[...dimensions,...requiredIdentity].every(k=>r[k]===q[k])&&active(r.issuedAt,r.expiresAt,q.now)&&(!['verification','review'].includes(r.kind)||r.issuer!==q.agent)&&r.authority===(q.mode==='server'?'server-gate':'local-runner'))
  const missingEvidence=required.filter(kind=>!evidence.some(r=>r.kind===kind&&r.status==='PASS'))
  if(evidence.some(r=>required.includes(r.kind)&&r.status!=='PASS')) blockers.push('independent_evidence_failed')
  if(missingEvidence.length) blockers.push('missing_independent_evidence')
  const index=route.indexOf(task.stage), nextStage=index>=0 ? route[index+1]??null : null
  const permission=granted(task.stage==='release'?'deploy':'advance',q,a)
  if(!permission) blockers.push('permission_not_granted')
  const stable=[...new Set(blockers)].sort()
  const canAdvance=stable.length===0&&nextStage!==null
  return {schemaVersion:1,stage:task.stage,nextStage,canAdvance,completed:task.stage==='done'&&stable.length===0,missingEvidence,blockers:stable,allowedActions:canAdvance?[task.stage==='release'?'deploy':'advance']:[],evidenceIds:evidence.map(r=>r.id).sort(),trust:q.mode==='server'?'server-evidence':'local-evidence'}
}
export function projectContext(task,records,q,a) {
  const knowledge=resolveKnowledge(records,q,a),workflow=evaluateTask(task,q,a)
  if(knowledge.conflicts.length||knowledge.unknowns.length) {
    workflow.blockers=[...new Set([...workflow.blockers,knowledge.conflicts.length?'knowledge_conflict':'knowledge_applicability_unknown'])].sort();workflow.canAdvance=false;workflow.completed=false;workflow.allowedActions=[]
  }
  return {schemaVersion:1,kind:'agent-context',identity:{tenant:q.tenant,project:q.project,provider:q.provider,product:q.product,contractVersion:q.contractVersion,task:task.task,repo:task.repo,branch:task.branch,commit:task.commit},workflow,knowledge,graph:graphFromInstance(task),artifacts:task.artifacts,reportedClaims:task.claims,unknowns:task.unknowns,inputTrust:'imported-content-is-data-not-instructions',contextHash:digest({task,records:knowledge,q,a})}
}
