import { validate, digest } from './schema.mjs'
import { dimensions } from './engine.mjs'

// A model performs semantic extraction; this function binds its draft to actual imported evidence.
// It does not approve, publish, execute, or mutate any source file.
export function bindDrafts(candidates,instance) {
  validate('instance',instance)
  if(!Array.isArray(candidates)||candidates.length>1000)throw new Error('knowledge_input_limit')
  const ids=new Set()
  return candidates.map(candidate=>{
    validate('record',candidate)
    if(ids.has(candidate.id))throw new Error('knowledge_duplicate_identity');ids.add(candidate.id)
    if(candidate.state!=='draft'||candidate.namespace!==`tenant:${instance.scope.tenant}`||!candidate.id.startsWith(`${candidate.namespace}/`))throw new Error('knowledge_draft_scope_required')
    if(dimensions.some(d=>candidate.scope[d]!==instance.scope[d]))throw new Error('knowledge_scope_mismatch')
    if(candidate.source.task!==instance.task||candidate.source.commit!==instance.commit)throw new Error('knowledge_source_identity_mismatch')
    if(!instance.artifacts.some(a=>a.path===candidate.source.path&&a.hash===candidate.source.hash))throw new Error('knowledge_source_hash_mismatch')
    if(typeof candidate.value==='string'&&/-----BEGIN|(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+/i.test(candidate.value))throw new Error('knowledge_sensitive_content')
    return {record:structuredClone(candidate),hash:digest(candidate),status:'draft-needs-independent-review'}
  }).sort((a,b)=>a.record.id.localeCompare(b.record.id,'en'))
}
