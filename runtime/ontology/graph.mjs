import { readFileSync } from 'node:fs'
import { validate, canonical, digest } from './schema.mjs'
const entities=JSON.parse(readFileSync(new URL('../../ontology/entities.json',import.meta.url),'utf8')).entities
const relations=JSON.parse(readFileSync(new URL('../../ontology/relations.json',import.meta.url),'utf8')).relations
const names=new Set(entities.map(e=>e.id))
export function validateGraph(graph) {
  validate('graph',graph)
  const nodes=new Map(),edges=new Set()
  for(const n of graph.nodes) {
    if(nodes.has(n.id)||!names.has(n.entity))throw new Error('graph_node_identity_invalid')
    if(!n.id.startsWith(`tenant:${n.scope.tenant}/`))throw new Error('graph_namespace_mismatch')
    nodes.set(n.id,n)
  }
  for(const e of graph.edges) {
    const from=nodes.get(e.fromId),to=nodes.get(e.toId),r=relations.find(r=>r.id===e.relation)
    if(edges.has(e.id)||!from||!to||!r)throw new Error('graph_edge_reference_invalid')
    edges.add(e.id)
    if(!e.id.startsWith(`tenant:${e.scope.tenant}/`))throw new Error('graph_namespace_mismatch')
    if(from.entity!==r.from||to.entity!==r.to)throw new Error('graph_relation_type_mismatch')
    if(canonical(e.scope)!==canonical(from.scope)||canonical(e.scope)!==canonical(to.scope))throw new Error('graph_scope_mismatch')
  }
  return graph
}
export function graphFromInstance(instance) {
  validate('instance',instance)
  const graph={schemaVersion:1,nodes:[],edges:[]}
  if(!instance.task||!instance.artifacts.some(a=>a.kind==='state'))return graph
  const scope=instance.scope,state=instance.artifacts.find(a=>a.kind==='state')
  const ns=`tenant:${scope.tenant}/`,identity={scope,task:instance.task,repo:instance.repo,branch:instance.branch,commit:instance.commit}
  const taskId=ns+digest(identity).slice(0,32)
  const provenance=a=>({path:a.path,hash:a.hash,task:instance.task,commit:instance.commit})
  graph.nodes.push({id:taskId,entity:'task',scope,source:provenance(state),ref:instance.task})
  const add=(entity,ref,source,relation)=>{
    const id=ns+digest({identity,entity,ref}).slice(0,32)
    graph.nodes.push({id,entity,scope,source,ref})
    graph.edges.push({id:ns+digest({taskId,id,relation}).slice(0,32),relation,scope,source,fromId:taskId,toId:id})
  }
  for(const artifact of instance.artifacts)add('artifact',artifact.path,provenance(artifact),'task_produces_artifact')
  if(instance.commit)add('commit',instance.commit,provenance(state),'task_produces_commit')
  return validateGraph(graph)
}
