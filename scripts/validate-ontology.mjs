#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { digest, assertSchemaSupported } from '../runtime/ontology/schema.mjs'
import { parseJson } from '../runtime/ontology/json.mjs'
import * as engine from '../runtime/ontology/engine.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
async function source(path) {
  if(isAbsolute(path)||path.includes('\\')||path.split('/').includes('..'))throw new Error('source_path_escape')
  const full=join(root,path),info=await lstat(full),actual=relative(root,await realpath(full))
  if(info.isSymbolicLink()||actual.startsWith('..')||info.size>1024*1024)throw new Error('source_invalid')
  return readFile(full,'utf8')
}
const load=async name=>parseJson(await source(`ontology/${name}.json`))
function unique(items,label){if(!items.length||new Set(items).size!==items.length)throw new Error(`dictionary_duplicate_or_empty:${label}`)}
try {
  const [entities,relations,model,mapping,policies]=await Promise.all(['entities','relations','states','mappings','policies'].map(load))
  for(const d of [entities,relations,model,mapping,policies])if(d.schemaVersion!==1)throw new Error('definition_version_unsupported')
  const ids=entities.entities.map(e=>e.id);unique(ids,'entities');unique(relations.relations.map(r=>r.id),'relations')
  for(const r of relations.relations)if(!ids.includes(r.from)||!ids.includes(r.to))throw new Error('relation_unknown_entity')
  unique(model.stages,'stages');unique(model.checks,'checks')
  const canonicalStages=['understand','define','plan','implement','test','review','release','done']
  if(JSON.stringify(model.stages)!==JSON.stringify(canonicalStages))throw new Error('stage_contract_drift')
  const knownEvidence=['context','spec','plan','commit','verification','review','environment','delivery','experience']
  for(const stage of model.stages) {
    if(!model.stageSkills[stage]||!model.requires[stage]?.length)throw new Error('stage_mapping_missing')
    const text=await source(model.stageSkills[stage]);if(!/^name: cap-/m.test(text))throw new Error('skill_frontmatter_invalid')
    unique(model.requires[stage],`requires:${stage}`)
    if(model.requires[stage].some(e=>!knownEvidence.includes(e)))throw new Error('unknown_evidence_kind')
  }
  for(const route of Object.values(model.routes)) {unique(route,'route');if(route.at(-1)!=='done'||route.some(s=>!model.stages.includes(s)))throw new Error('route_invalid')}
  if(JSON.stringify(Object.keys(model.routes).sort())!==JSON.stringify(['L1','L2','L3','L4']))throw new Error('route_missing')
  for(const check of model.checks)await source(`skills/cap-test/checks/${check}.md`)
  for(const name of mapping.runtimeSchemas)assertSchemaSupported(await load(`schemas/${name}`))
  unique(policies.policies.map(p=>p.id),'policies')
  for(const p of policies.policies)if(typeof engine[p.enforcedBy]!=='function'||!/^O\d\d$/.test(p.acceptance))throw new Error('policy_without_enforcer')
  unique(mapping.sourceFiles,'source_files')
  const files=[]
  for(const path of mapping.sourceFiles)files.push({path,hash:digest(await source(path))})
  if(process.argv.includes('--refresh-source-lock')) {
    // Explicit maintenance operation: only use after reviewing source changes and semantic tests.
    await writeFile(resolve(root,'ontology/source-lock.json'),`${JSON.stringify({schemaVersion:1,files},null,2)}\n`)
    console.log('Updated reviewed source lock; rerun validation and semantic tests.')
  } else {
    const lock=await load('source-lock')
    if(lock.schemaVersion!==1||JSON.stringify(lock.files)!==JSON.stringify(files))throw new Error('source_drift: review Skills changes and semantics before refreshing lock')
    console.log(`PASS ontology: ${ids.length} entities; ${relations.relations.length} relations; ${model.stages.length} stages; ${policies.policies.length} executable policies`)
  }
}catch(e){console.error(`FAIL ontology: ${e.message}`);process.exitCode=1}
