import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'http'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'

const runtime = resolve('runtime/local-test-provider.mjs')
const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

test('installed provider executes one exact test action in an isolated worktree', async t => {
  const home = await mkdtemp(join(tmpdir(),'cap-local-provider-'))
  const repo = join(home,'repo')
  await mkdir(repo,{recursive:true})
  assert.equal(git(repo,['init']).status,0)
  assert.equal(git(repo,['config','user.name','Fixture']).status,0)
  assert.equal(git(repo,['config','user.email','fixture@example.test']).status,0)
  await writeFile(join(repo,'value.txt'),'ok\n')
  assert.equal(git(repo,['add','value.txt']).status,0)
  assert.equal(git(repo,['commit','-m','fixture']).status,0)
  assert.equal(git(repo,['remote','add','origin','https://example.test/org/repo.git']).status,0)
  const commit = String(git(repo,['rev-parse','HEAD']).stdout).trim()
  const received = []
  const server = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk
    received.push({url:req.url,headers:req.headers,body:body?JSON.parse(body):{}})
    res.setHeader('Content-Type','application/json')
    if (req.url.endsWith('/claim')) return res.end(JSON.stringify({code:0,data:{action:{id:'action_fixture',actionType:'test',sourceCommit:commit,contractSnapshot:{source:{repoUrl:'https://example.test/org/repo.git',branch:'main',commitSha:commit},requiredChecks:[{id:'check_1',command:'sleep 0.15 && test "$(cat value.txt)" = ok',timeoutSeconds:10}]}},lease:{leaseId:'lease_1'}}}))
    if (req.url.endsWith('/heartbeat')) return res.end(JSON.stringify({code:0,data:{status:'running',leaseExpiresAt:new Date(Date.now()+300000).toISOString()}}))
    if (req.url.endsWith('/evidence')) return res.end(JSON.stringify({code:0,data:{status:'succeeded'}}))
    res.end(JSON.stringify({code:0,data:{ok:true}}))
  })
  await new Promise(resolvePromise=>server.listen(0,'127.0.0.1',resolvePromise)); t.after(()=>server.close())
  const configDir=join(home,'.capital-agent','runner'); await mkdir(configDir,{recursive:true})
  await writeFile(join(configDir,'config.json'),JSON.stringify({serverUrl:`http://127.0.0.1:${server.address().port}`,runnerId:'runner_fixture',runnerCredential:'credential',capabilities:['test']}))
  const result=await new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,[runtime,repo,'action_fixture'],{env:{...process.env,HOME:home,CAPITAL_AGENT_LOCAL_PROVIDER_HEARTBEAT_MS:'50'}})
    let stdout=''; let stderr=''
    child.stdout.on('data',chunk=>{stdout+=chunk})
    child.stderr.on('data',chunk=>{stderr+=chunk})
    child.on('error',reject)
    child.on('close',status=>resolvePromise({status,stdout,stderr}))
  })
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/"outcome": "PASS"/)
  const evidence=received.find(item=>item.url.endsWith('/evidence'))
  assert.equal(evidence.body.evidence.testedHead,commit)
  assert.deepEqual(evidence.body.evidence.summary,{total:1,passed:1,failed:0,skipped:0})
  assert.equal(evidence.headers['x-runner-id'],'runner_fixture')
  assert.ok(received.some(item=>item.url.endsWith('/heartbeat')))
  assert.equal((await readFile(join(repo,'value.txt'),'utf8')).trim(),'ok')
})
