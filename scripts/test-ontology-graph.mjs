import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {graphFromInstance,validateGraph} from '../runtime/ontology/graph.mjs'
const fixture=()=>{const i=JSON.parse(readFileSync(new URL('../examples/ontology/instance.json',import.meta.url),'utf8'));i.artifacts.push({kind:'state',path:'.cap/STATE.md',hash:'c'.repeat(64)});return i}
test('O01/O03: graph materializes typed task/artifact/commit relationships with provenance',()=>{
 const graph=graphFromInstance(fixture());assert.equal(graph.nodes.length,4);assert.equal(graph.edges.length,3);assert.ok(graph.edges.some(e=>e.relation==='task_produces_commit'));assert.deepEqual(validateGraph(graph),graph)
})
test('O02/O03: no cross-scope, dangling, duplicate or wrongly typed edges',()=>{
 for(const mutate of [g=>g.nodes.push(g.nodes[0]),g=>g.edges[0].toId='missing',g=>g.nodes[1].scope={...g.nodes[1].scope,tenant:'other'},g=>g.edges[0].relation='commit_verified_by']){
 const graph=structuredClone(graphFromInstance(fixture()));mutate(graph);assert.throws(()=>validateGraph(graph),/graph_/)}
})
test('O06: new source content changes provenance and new commit changes graph identity',()=>{
 const a=fixture(),b=fixture();b.commit='b'.repeat(40)
 const ga=graphFromInstance(a),gb=graphFromInstance(b);assert.notEqual(ga.nodes[0].id,gb.nodes[0].id)
 b.commit=a.commit;b.artifacts[0].hash='f'.repeat(64);assert.notDeepEqual(graphFromInstance(a),graphFromInstance(b))
})
