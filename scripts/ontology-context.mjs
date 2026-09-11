#!/usr/bin/env node
import { readJson } from '../runtime/ontology/json.mjs'
import { validate } from '../runtime/ontology/schema.mjs'
import { importCap, migrateLegacy } from '../runtime/ontology/import.mjs'
import { bindDrafts } from '../runtime/ontology/knowledge.mjs'
import { projectContext } from '../runtime/ontology/engine.mjs'

try {
  const [command,...args]=process.argv.slice(2)
  let result
  if(command==='import'&&args.length===2) result=await importCap(args[0],await readJson(args[1]))
  else if(command==='bind-drafts'&&args.length===2) result=bindDrafts(await readJson(args[1]),await readJson(args[0]))
  else if(command==='migrate'&&args.length===2) result=migrateLegacy(await readJson(args[0]),await readJson(args[1]))
  else if(command==='context'&&(args.length===3||args.length===4)) {
    const task=await readJson(args[0]),query=await readJson(args[1]),records=await readJson(args[2])
    validate('query',query)
    const authority=args[3]?await readJson(args[3]):{schemaVersion:1,tenant:query.tenant,admissions:[],publications:[],overrides:[],grants:[],receipts:[]}
    result=projectContext(task,records,query,authority)
  } else throw new Error('usage: ontology-context.mjs import <repo> <binding.json> | context <instance.json> <query.json> <catalog.json> [authority.json] | migrate <legacy.json> <binding.json> | bind-drafts <instance.json> <drafts.json>')
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`)
}catch(error){console.error(`ontology_error: ${error.code??error.message}`);process.exitCode=1}
