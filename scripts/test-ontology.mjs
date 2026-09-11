import test from 'node:test'
import assert from 'node:assert/strict'
import { validate, digest } from '../runtime/ontology/schema.mjs'
import { resolveKnowledge, evaluateTask } from '../runtime/ontology/engine.mjs'

export const query = () => ({ schemaVersion: 1, tenant: 'alpha', project: 'pay', provider: 'bank-a', product: 'repay', contractVersion: '1', environment: 'test', task: 't1', repo: 'repo-a', branch: 'feature-a', commit: 'a'.repeat(40), agent: 'dev-1', now: '2026-09-12T00:00:00.000Z', mode: 'local', complexity: 'L3' })
export const authority = (records=[record()]) => ({ schemaVersion: 1, tenant: 'alpha', admissions: records.map(r=>({id:r.id,hash:digest(r)})), publications: [], overrides: [], grants: [], receipts: [] })
export const record = (id = 'r1', value = 'reject') => ({ schemaVersion: 1, id: `tenant:alpha/${id}`, namespace: 'tenant:alpha', kind: 'claim', key: 'payment.missing_config', value, scope: { tenant: 'alpha', project: 'pay', provider: 'bank-a', product: 'repay', contractVersion: '1', environment: null }, revision: 1, state: 'validated', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, source: { path: '.cap/experience.md', hash: 'a'.repeat(64), task: 'source-task', commit: 'b'.repeat(40) }, conditions: { commit: null }, supersedes: [] })
export const instance = () => ({ schemaVersion: 1, scope: {tenant: 'alpha', project: 'pay', provider: 'bank-a', product: 'repay', contractVersion: '1', environment: 'test'}, task: 't1', repo: 'repo-a', branch: 'feature-a', commit: 'a'.repeat(40), stage: 'test', status: 'in-progress', artifacts: [], claims: [], unknowns: [], blockers: [], origin: 'cap-import' })

test('O01: reject future schemas and unknown fields', () => {
  assert.throws(() => validate('record', {...record(),schemaVersion:2}), /schema/)
  assert.throws(() => validate('record', {...record(),priority:999}), /schema/)
})
test('O02: tenant and provider filtering precede conflict diagnostics', () => {
  const other=record('secret','secret-beta'); other.scope.tenant='beta';other.namespace='tenant:beta';other.id='tenant:beta/secret'
  const result=resolveKnowledge([record(),other],query(),authority())
  assert.equal(result.facts.length,1);assert.ok(!JSON.stringify(result).includes('secret-beta'))
})
test('O04: contradictory claims block rather than pick latest or more specific', () => {
  const a=record(),b=record('r2','fallback');b.revision=2
  const first=resolveKnowledge([a,b],query(),authority([a,b]))
  assert.equal(first.conflicts.length,1); assert.equal(first.facts.length,0)
  assert.deepEqual(first,resolveKnowledge([b,a],query(),authority([a,b])))
})
test('O05: stale knowledge not injected', () => {
  const r=record();r.validUntil='2026-09-01T00:00:00.000Z'
  assert.equal(resolveKnowledge([r],query(),authority()).facts.length,0)
})
test('O07: a claimed PASS is not independent evidence', () => {
  const i=instance();i.claims=[{kind:'verification',status:'PASS',source:'.cap/verify/a.md',hash:'a'.repeat(64)}]
  const result=evaluateTask(i,query(),authority())
  assert.equal(result.canAdvance,false);assert.ok(result.missingEvidence.includes('verification'))
})

const admitted=(...records)=>authority(records)
const grant=(action='advance',effect='allow')=>({id:`g-${effect}`,subject:'dev-1',action,scope:{...record().scope,environment:'test'},effect,validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z'})
const receipt=(kind='verification')=>({id:`e-${kind}`,issuer:'independent-runner',tenant:'alpha',project:'pay',provider:'bank-a',product:'repay',contractVersion:'1',environment:'test',task:'t1',repo:'repo-a',branch:'feature-a',commit:'a'.repeat(40),kind,status:'PASS',authority:'local-runner',issuedAt:'2026-09-11T00:00:00.000Z',expiresAt:'2026-09-13T00:00:00.000Z',sourceHash:'a'.repeat(64)})
const evidenceAuthority=(...kinds)=>{const a=authority();a.receipts=kinds.map(receipt);a.grants=[grant()];return a}

test('O01: duplicate IDs rejected even when identical',()=>assert.throws(()=>resolveKnowledge([record(),record()],query(),authority()),/duplicate/))
test('O01: reject malformed namespace and invalid provenance path',()=>{
 for(const mutate of [r=>r.namespace='tenant:beta',r=>r.source.path='../outside',r=>r.source.path='C:\\secret']){const r=record();mutate(r);assert.throws(()=>resolveKnowledge([r],query(),admitted(r)),/record_/)}
})
test('O02/O03: provider, product and contract are independent applicability dimensions',()=>{
 for(const field of ['provider','product','contractVersion','project','environment']){const q=query();q[field]='other';const r=record();r.scope.environment='test';assert.equal(resolveKnowledge([r],q,admitted(r)).facts.length,0)}
})
test('O02: missing provider cannot act as wildcard',()=>{
 const q=query();q.provider=null;const result=resolveKnowledge([record()],q,authority());assert.equal(result.facts.length,0);assert.equal(result.unknowns.length,1)
})
test('O03: self-declared public or validated is not admission',()=>{
 const r=record();const a=authority();a.admissions=[];assert.equal(resolveKnowledge([r],query(),a).facts.length,0)
 r.scope.tenant=null;r.namespace='public';r.id='public/example'
 assert.equal(resolveKnowledge([r],query(),a).facts.length,0)
 a.publications=[{id:r.id,hash:digest(r)}];assert.equal(resolveKnowledge([r],query(),a).facts.length,1)
 r.value='changed-after-approval';assert.equal(resolveKnowledge([r],query(),a).facts.length,0)
})
test('O04: agreeing claims merge sources, not identities',()=>{
 const a=record(),b=record('r2');const result=resolveKnowledge([a,b],query(),admitted(a,b));assert.equal(result.facts.length,1);assert.equal(result.facts[0].sources.length,2)
})
test('O04: explicit delegated replacement only within identical scope',()=>{
 const a=record(),b=record('r2','fallback');b.revision=2;b.supersedes=[a.id];const auth=admitted(a,b)
 assert.equal(resolveKnowledge([a,b],query(),auth).conflicts[0].code,'invalid_supersession')
 auth.overrides=[{id:'o1',older:a.id,newer:b.id,key:b.key,scope:b.scope,validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z'}]
 assert.equal(resolveKnowledge([a,b],query(),auth).facts[0].value,'fallback')
 b.scope.environment='test';auth.admissions[1].hash=digest(b)
 assert.equal(resolveKnowledge([a,b],query(),auth).conflicts.length,1)
})
test('O04: constraints cannot be superseded even by delegation',()=>{
 const a=record(),b=record('r2','fallback');a.kind=b.kind='constraint';b.revision=2;b.supersedes=[a.id];const auth=admitted(a,b)
 auth.overrides=[{id:'o1',older:a.id,newer:b.id,key:b.key,scope:b.scope,validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z'}]
 assert.equal(resolveKnowledge([a,b],query(),auth).conflicts.length,1)
})
test('O04: cyclic replacements fail deterministically',()=>{
 const a=record(),b=record('r2');a.supersedes=[b.id];b.supersedes=[a.id]
 assert.equal(resolveKnowledge([a,b],query(),admitted(a,b)).conflicts.length,1)
})
test('O05: future, expired, revoked, draft and code mismatch records excluded',()=>{
 for(const mutate of [r=>r.validFrom='2027-01-01T00:00:00.000Z',r=>r.validUntil='2026-02-01T00:00:00.000Z',r=>r.state='revoked',r=>r.state='draft',r=>r.conditions.commit='c'.repeat(40)]){
 const r=record();mutate(r);assert.equal(resolveKnowledge([r],query(),admitted(r)).facts.length,0)}
})
test('O05: invalid calendar date and inverted validity fail closed',()=>{
 for(const mutate of [r=>r.validFrom='2026-02-30T00:00:00.000Z',r=>r.validUntil='2025-02-01T00:00:00.000Z']){const r=record();mutate(r);assert.throws(()=>resolveKnowledge([r],query(),admitted(r)))}
})
test('O07: exact evidence + permission permits transition',()=>{
 const result=evaluateTask(instance(),query(),evidenceAuthority('commit','verification'))
 assert.equal(result.canAdvance,true);assert.equal(result.nextStage,'review');assert.deepEqual(result.allowedActions,['advance'])
})
test('O07: each evidence identity component is mandatory',()=>{
 for(const field of ['tenant','project','provider','product','contractVersion','task','repo','branch','commit','environment']){
 const auth=evidenceAuthority('commit','verification');auth.receipts[1][field]=field==='commit'?'c'.repeat(40):'other'
 if(field==='tenant')assert.throws(()=>evaluateTask(instance(),query(),auth),/tenant|scope/)
 else assert.equal(evaluateTask(instance(),query(),auth).canAdvance,false,field)
 }
})
test('O07: old, future and local evidence cannot pass server gate',()=>{
 for(const mutate of [r=>r.expiresAt='2026-09-11T01:00:00.000Z',r=>r.issuedAt='2026-09-12T01:00:00.000Z',r=>r.status='ENV_BLOCKED']){
 const a=evidenceAuthority('commit','verification');mutate(a.receipts[1]);assert.equal(evaluateTask(instance(),query(),a).canAdvance,false)}
 const q=query();q.mode='server';assert.equal(evaluateTask(instance(),q,evidenceAuthority('commit','verification')).canAdvance,false)
})
test('O08: deny overrides allow, mismatched agent/expiry cannot grant',()=>{
 const a=evidenceAuthority('commit','verification');a.grants.push(grant('advance','deny'));assert.equal(evaluateTask(instance(),query(),a).canAdvance,false)
 for(const mutate of [g=>g.subject='another-agent',g=>g.validUntil='2026-09-01T00:00:00.000Z',g=>g.scope.environment='production']){
 const b=evidenceAuthority('commit','verification');mutate(b.grants[0]);assert.equal(evaluateTask(instance(),query(),b).canAdvance,false)}
})
test('O09: all complexity routes have meaningful transition gates',()=>{
 const routes={L1:['implement','test','done'],L2:['define','implement','test','review','done'],L3:['understand','define','plan','implement','test','review','done'],L4:['understand','define','plan','implement','test','review','release','done']}
 for(const [complexity,route] of Object.entries(routes))for(let n=0;n<route.length;n++){
 const i=instance();i.stage=route[n];const q=query();q.complexity=complexity
 const a=evidenceAuthority('context','spec','plan','commit','verification','review','environment','delivery');a.grants.push({...grant('deploy'),id:'g-deploy'})
 const r=evaluateTask(i,q,a);assert.equal(r.nextStage,route[n+1]??null);assert.equal(r.canAdvance,n<route.length-1);assert.equal(r.completed,n===route.length-1)
 }
})
test('O09: local done never implies completion without receipts',()=>{
 const i=instance();i.stage='done';i.status='done';assert.equal(evaluateTask(i,query(),authority()).completed,false)
})
test('O09: production deploy needs its own scoped grant and environment evidence',()=>{
 const i=instance();i.stage='release';const q=query();q.complexity='L4';const a=evidenceAuthority('commit','verification','review','environment','delivery')
 assert.equal(evaluateTask(i,q,a).canAdvance,false)
 a.grants=[grant('deploy')];assert.equal(evaluateTask(i,q,a).canAdvance,true)
 a.receipts=a.receipts.filter(r=>r.kind!=='environment');assert.equal(evaluateTask(i,q,a).canAdvance,false)
})

test('O07: author cannot issue their own verification or review receipt',()=>{
 const a=evidenceAuthority('commit','verification');a.receipts[1].issuer=query().agent;assert.equal(evaluateTask(instance(),query(),a).canAdvance,false)
})
