import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const root=fileURLToPath(new URL('..',import.meta.url))
const cli=join(root,'scripts/ontology-context.mjs')
test('O14: CLI resolves resources from package root regardless of cwd',()=>{
 const result=JSON.parse(execFileSync(process.execPath,[cli,'context',...['instance','query','catalog'].map(n=>join(root,`examples/ontology/${n}.json`))],{cwd:tmpdir(),encoding:'utf8'}))
 assert.equal(result.kind,'agent-context');assert.equal(result.workflow.stage,'test');assert.equal(result.workflow.canAdvance,false)
})
test('O14: legacy sample lookup removed; missing/extra CLI args fail',()=>{
 for(const args of [['payment-center-5011'],['context'],['import','x','y','extra']])assert.notEqual(spawnSync(process.execPath,[cli,...args]).status,0)
})
test('O12: Skill source drift fails structural verification',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'ontology source '));t.after(()=>rm(temp,{recursive:true,force:true}))
 const mappings=JSON.parse(await readFile(join(root,'ontology/mappings.json'),'utf8'))
 for(const path of ['ontology','runtime/ontology','scripts/validate-ontology.mjs',...mappings.sourceFiles,...['logic','journey','model'].map(c=>`skills/cap-test/checks/${c}.md`)]){
 await mkdir(join(temp,path.substring(0,path.lastIndexOf('/'))),{recursive:true});await cp(join(root,path),join(temp,path),{recursive:true})}
 const validate=()=>spawnSync(process.execPath,[join(temp,'scripts/validate-ontology.mjs')],{encoding:'utf8'})
 assert.equal(validate().status,0)
 const source=join(temp,'skills/cap-test/SKILL.md');await writeFile(source,(await readFile(source,'utf8'))+'\nchanged source rule\n')
 const result=validate();assert.notEqual(result.status,0);assert.match(result.stderr,/source_drift/)
})
