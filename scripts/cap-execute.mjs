#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { runLocalAction, doctorLocalExecution, inspectLocalExecution, recoverLocalExecution } from '../runtime/execution/local-flow.mjs'
import { parseJson } from '../runtime/ontology/json.mjs'

export function parseArguments(argv) {
 const out={operation:'run',repo:'.'};let i=0
 if(argv[0]&&!argv[0].startsWith('-')) {out.operation=argv[0];i++}
 if(!['run','doctor','status','recover'].includes(out.operation))throw new Error('execution_cli_operation')
 for(;i<argv.length;i++) {
  const key=argv[i]
  if(key==='--help'||key==='-h'){out.help=true;continue}
  if(key==='--json'){out.json=true;continue}
  if(key==='--'){if(out.command)throw new Error('execution_cli_duplicate_command');out.command=argv.slice(i+1);break}
  if(!['--repo','--stage','--action','--id','--timeout-ms','--command','--constraints'].includes(key))throw new Error('execution_cli_unknown_option')
  const value=argv[++i];if(value===undefined)throw new Error('execution_cli_missing_value')
  const name=key==='--timeout-ms'?'timeoutMs':key.slice(2)
  if(Object.hasOwn(out,name)&&name!=='repo')throw new Error('execution_cli_duplicate_option')
  out[name]=['--command','--constraints'].includes(key)?parseJson(value):key==='--timeout-ms'?Number(value):value
 }
 return out
}
export async function main(argv=process.argv.slice(2)) {
 try {
  const options=parseArguments(argv)
  if(options.help){process.stdout.write('Local execution recorder — no account or secret required.\nUsage: node scripts/cap-execute.mjs [run|doctor|status|recover] --repo <repository> [--stage test] [--json] [--timeout-ms 120000] [-- <executable> <arguments...>]\nWithout argv, use .cap/execution-config.json or a declared package.json script. No implicit shell or wildcard expansion.\n');return 0}
  let result
  if(options.operation==='doctor')result=await doctorLocalExecution(options.repo)
  else if(options.operation==='status')result=await inspectLocalExecution(options.repo,options)
  else if(options.operation==='recover')result=await recoverLocalExecution(options.repo)
  else {
   const run=await runLocalAction(options.repo,options)
   if(!options.json){process.stdout.write(run.stdout);process.stderr.write(run.stderr)}
   result={schemaVersion:2,trust:'local-observed',gate:run.gate,artifactDir:run.artifactDir}
  }
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`)
  return options.operation==='run'&&!result.gate.passed?1:0
 }catch(error){
  const code=/^(execution_|json_|session_root_)[A-Za-z0-9_]+/.exec(String(error.message))?.[0]||'execution_failed'
  process.stderr.write(`cap-execute: ${code}\n`);return 1
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)process.exitCode=await main()
