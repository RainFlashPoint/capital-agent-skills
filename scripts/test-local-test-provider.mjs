import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'http'
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'
import { sandboxInvocation, isEnvironmentFailure } from '../runtime/local-test-provider.mjs'

const runtime = resolve('runtime/local-test-provider.mjs')
const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

const macSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

async function sandboxFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cap-provider-sandbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'repo'); const home = join(root, 'home')
  await mkdir(cwd); await mkdir(home)
  return { root, cwd, home, run: async command => {
    const invocation = await sandboxInvocation(command, cwd, home)
    return spawnSync(invocation.command, invocation.args, {
      cwd, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
    })
  } }
}

test('macOS sandbox permits child termination but denies host signals and file access', { skip: !macSandbox }, async t => {
  const fixture = await sandboxFixture(t)
  const secret = join(fixture.root, 'host-secret')
  await writeFile(secret, 'host-only')
  const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => host.kill('SIGKILL'))
  const script = `
    const assert = require('node:assert/strict');
    assert.throws(() => require('node:fs').readFileSync(${JSON.stringify(secret)}), e => ['EACCES','EPERM'].includes(e.code));
    assert.throws(() => process.kill(${host.pid}, 'SIGCONT'), e => e.code === 'EPERM');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {stdio:'ignore'});
    child.on('error', error => { throw error });
    child.on('close', (code, signal) => assert.equal(signal, 'SIGTERM'));
    child.on('spawn', () => { child.kill('SIGTERM') });
  `
  const result = await fixture.run(`${shellQuote(process.execPath)} -e ${shellQuote(script)}`)
  assert.equal(result.status, 0, result.stderr || String(result.error))
  assert.equal(result.stderr, '')
})

test('macOS sandbox resolves Homebrew PostgreSQL symlinks while retaining shared-memory isolation', { skip: !macSandbox || !existsSync('/opt/homebrew/bin/initdb') || !existsSync('/opt/homebrew/share/postgresql/postgres.bki') }, async t => {
  const fixture = await sandboxFixture(t)
  const command = `/opt/homebrew/bin/initdb --no-locale -A trust -L /opt/homebrew/share/postgresql -D ${shellQuote(join(fixture.cwd, 'pgdata'))}`
  const shown = await fixture.run(`${command} --show`)
  assert.equal(shown.status, 0, shown.stderr || String(shown.error))
  assert.doesNotMatch(shown.stderr, /could not resolve path|Operation not permitted|Permission denied/i)
  const initialized = await fixture.run(command)
  assert.doesNotMatch(initialized.stderr, /could not resolve path/i)
  // SysV IPC has no per-clone namespace on macOS. Do not grant global IPC
  // merely to make this check green; report the actual environment blocker.
  assert.notEqual(initialized.status, 0)
  assert.match(initialized.stderr, /could not create shared memory segment: Operation not permitted/i)
  assert.equal(isEnvironmentFailure(initialized.stderr), true)
})

test('shared-memory permission denial is an environment blocker, not a business-code failure', () => {
  assert.equal(isEnvironmentFailure('FATAL: could not create shared memory segment: Operation not permitted'), true)
  assert.equal(isEnvironmentFailure('DETAIL: Failed system call was shmget(key=123, size=56): Permission denied'), true)
  assert.equal(isEnvironmentFailure('AssertionError: incorrect account status'), false)
})

async function identityFixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cap-provider-identity-'))
  const repo = join(home, 'repo'); await mkdir(repo)
  assert.equal(git(repo, ['init']).status, 0)
  assert.equal(git(repo, ['remote', 'add', 'origin', options.origin || 'https://example.test/org/repo.git']).status, 0)
  const source = { repositoryId: 'repo_fixture', repoUrl: 'https://example.test/org/repo.git', branch: 'main', commitSha: 'a'.repeat(40) }
  const action = { id: 'action_fixture', status: 'ready', actionType: 'test', sourceCommit: source.commitSha, contractSnapshot: { source, requiredChecks: [] } }
  if (options.changeAction) options.changeAction(action)
  const received = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    received.push({ url: req.url, method: req.method, headers: req.headers, body })
    res.setHeader('Content-Type', 'application/json')
    if ((options.lookupRedirect && req.url === '/api/harness/actions/action_fixture') || req.url === options.runnerRedirect) {
      res.statusCode = 302
      res.setHeader('Location', `${serverUrl}/redirect-target`)
      return res.end()
    }
    if (req.url === '/api/harness/actions/action_fixture') {
      if (options.lookupStatus) res.statusCode = options.lookupStatus
      return res.end(options.lookupBody ?? JSON.stringify({ code: options.lookupStatus || 0, data: action }))
    }
    assert.equal(req.headers['x-user-key'], undefined, 'platform credential must not reach runner routes')
    if (req.url.endsWith('/claim')) {
      const claimed = structuredClone(action)
      if (options.changeClaim) options.changeClaim(claimed)
      if (options.claimStatus) res.statusCode = options.claimStatus
      return res.end(JSON.stringify({ code: options.claimStatus || 0, data: options.nullClaim ? null : { action: claimed, lease: { leaseId: 'lease_fixture' } } }))
    }
    res.end(JSON.stringify({ code: 0, data: { ok: true } }))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => server.close())
  const serverUrl = `http://127.0.0.1:${server.address().port}`
  const runnerDir = join(home, '.capital-agent', 'runner'); await mkdir(runnerDir, { recursive: true })
  await writeFile(join(runnerDir, 'config.json'), JSON.stringify({ serverUrl: options.configServer || (options.trailingSlash ? `${serverUrl}/` : serverUrl), runnerId: 'runner_fixture', runnerCredential: 'fixture-runner-credential', capabilities: ['test'] }))
  const clientDir = join(home, '.config', 'capital-agent'); await mkdir(clientDir, { recursive: true })
  await writeFile(join(clientDir, 'env'), `CAPITAL_AGENT_SERVER_URL=${options.clientServer || serverUrl}\n${options.noClientIdentity ? '' : 'CAPITAL_AGENT_USER_KEY=fixture-client-identity\n'}`)
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runtime, repo, 'action_fixture'], { env: { ...process.env, HOME: home, CAPITAL_AGENT_MODE: 'server' } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject); child.on('close', status => resolvePromise({ status, stdout, stderr }))
  })
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-client-identity|fixture-runner-credential/)
  return { received, result }
}

test('explicit local mode refuses to claim a provider action', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cap-local-provider-disabled-')); const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true }); assert.equal(git(repo, ['init']).status, 0)
  const configDir = join(home, '.capital-agent', 'runner'); await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9', runnerId: 'runner_fixture', runnerCredential: 'credential' }))
  const result = spawnSync(process.execPath, [runtime, repo, 'action_fixture'], { env: { ...process.env, HOME: home, CAPITAL_AGENT_MODE: 'local' }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /显式本地模式禁止连接平台/)
})

test('identity failures stop before heartbeat, claim or execution', async t => {
  const cases = [
    { name: 'missing existing client identity', noClientIdentity: true, requests: 0 },
    { name: 'client bound to another Server', clientServer: 'https://other.example.test', requests: 0 },
    { name: 'client address with credentials rejected', clientServer: 'https://user:password@example.test', requests: 0 },
    { name: 'client non-loopback HTTP rejected', clientServer: 'http://example.test', requests: 0 },
    { name: 'installed provider address with credentials rejected', configServer: 'https://user:password@example.test', requests: 0 },
    { name: 'installed provider non-loopback HTTP rejected', configServer: 'http://example.test', requests: 0 },
    { name: 'installed provider query rejected', configServer: 'https://example.test?token=secret', requests: 0 },
    { name: 'installed provider fragment rejected', configServer: 'https://example.test#fragment', requests: 0 },
    { name: 'SCP origin query rejected before any request', origin: 'git@example.test:org/repo.git?alias=other', requests: 0 },
    { name: 'SCP origin fragment rejected before any request', origin: 'git@example.test:org/repo.git#other', requests: 0 },
    { name: 'lookup authentication denied', lookupStatus: 401 },
    { name: 'lookup returns non JSON', lookupBody: '<html>invalid</html>' },
    { name: 'lookup data missing', lookupBody: '{"code":0}' },
    { name: 'Action not ready', changeAction: a => { a.status = 'running' } },
    { name: 'wrong Action ID', changeAction: a => { a.id = 'action_other' } },
    { name: 'review Action not executable', changeAction: a => { a.actionType = 'review' } },
    { name: 'repository ID missing', changeAction: a => { delete a.contractSnapshot.source.repositoryId } },
    { name: 'repository ID invalid', changeAction: a => { a.contractSnapshot.source.repositoryId = 'repo_fixture\nother' } },
    { name: 'repository ID not a string', changeAction: a => { a.contractSnapshot.source.repositoryId = 123 } },
    { name: 'wrong origin', changeAction: a => { a.contractSnapshot.source.repoUrl = 'https://example.test/org/other.git' } },
    { name: 'same path on different host', changeAction: a => { a.contractSnapshot.source.repoUrl = 'https://other.test/org/repo.git' } },
    { name: 'host port preserved in identity', changeAction: a => { a.contractSnapshot.source.repoUrl = 'https://example.test:8443/org/repo.git' } },
    { name: 'repository path case differs', origin: 'https://example.test/Org/Repo.git' },
    { name: 'non Git URL', origin: 'file:///tmp/org/repo.git', changeAction: a => { a.contractSnapshot.source.repoUrl = 'file:///tmp/org/repo.git' } },
    { name: 'commit not exact', changeAction: a => { a.contractSnapshot.source.commitSha = 'main' } },
    { name: 'source Commit fields disagree', changeAction: a => { a.sourceCommit = 'b'.repeat(40) } },
  ]
  for (const item of cases) await t.test(item.name, async childTest => {
    const { received, result } = await identityFixture(childTest, item)
    assert.equal(result.status, 1, result.stdout)
    assert.equal(received.length, item.requests ?? 1, result.stderr)
    assert.ok(received.every(req => req.method === 'GET'))
  })
})

test('changed or denied claim cannot start a test', async t => {
  const cases = [
    { name: 'Action ID', changeClaim: a => { a.id = 'action_other' } },
    { name: 'Action type', changeClaim: a => { a.actionType = 'patch' } },
    { name: 'repository ID', changeClaim: a => { a.contractSnapshot.source.repositoryId = 'repo_other' } },
    { name: 'repository URL', changeClaim: a => { a.contractSnapshot.source.repoUrl = 'https://example.test/org/other.git' } },
    { name: 'commit', changeClaim: a => { a.sourceCommit = a.contractSnapshot.source.commitSha = 'b'.repeat(40) } },
    { name: 'branch', changeClaim: a => { a.contractSnapshot.source.branch = 'other' } },
    { name: 'null claim', nullClaim: true },
    { name: 'claim rejected', claimStatus: 409 },
  ]
  for (const item of cases) await t.test(item.name, async childTest => {
    const { received, result } = await identityFixture(childTest, item)
    assert.equal(result.status, 1, result.stdout)
    assert.deepEqual(received.map(req => req.url), ['/api/harness/actions/action_fixture', '/api/execution/runner/heartbeat', '/api/execution/runner/harness/actions/claim'])
    const capabilities = received[1].body.capabilities
    assert.deepEqual(capabilities.repositoryIds, ['repo_fixture'])
    assert.equal(capabilities.globalRepositoryAccess, undefined)
    assert.equal(capabilities.patch, false)
    assert.equal(capabilities.maxConcurrency, 1)
  })
})

test('configured Server trailing slash does not change runner routes', async t => {
  const { received, result } = await identityFixture(t, { trailingSlash: true, claimStatus: 409 })
  assert.equal(result.status, 1)
  assert.deepEqual(received.map(req => req.url), ['/api/harness/actions/action_fixture', '/api/execution/runner/heartbeat', '/api/execution/runner/harness/actions/claim'])
})

test('redirects never forward platform or runner credentials', async t => {
  for (const options of [{ lookupRedirect: true }, { runnerRedirect: '/api/execution/runner/heartbeat' }, { runnerRedirect: '/api/execution/runner/harness/actions/claim' }]) {
    await t.test(options.runnerRedirect || 'canonical lookup', async childTest => {
      const { received, result } = await identityFixture(childTest, options)
      assert.equal(result.status, 1)
      assert.ok(received.every(req => req.url !== '/redirect-target'))
      assert.equal(received.at(-1).url, options.runnerRedirect || '/api/harness/actions/action_fixture')
    })
  }
})

test('HTTPS, SSH and sanitized origins map to the same exact repository', async t => {
  for (const origin of ['git@example.test:org/repo.git', 'example.test:org/repo.git', 'oauth_secret@example.test:org/repo.git', 'ssh://git@example.test/org/repo.git', 'https://example.test/org/repo.git/', 'https://user:fixture-url-secret@example.test/org/repo.git?token=fixture-query-secret#fixture-fragment-secret']) {
    await t.test(origin.split(':')[0], async childTest => {
      const { received, result } = await identityFixture(childTest, { origin, claimStatus: 409 })
      assert.equal(result.status, 1)
      assert.equal(received.at(-1).url, '/api/execution/runner/harness/actions/claim', result.stderr)
      assert.doesNotMatch(JSON.stringify(received) + result.stdout + result.stderr, /oauth_secret|fixture-url-secret|fixture-query-secret|fixture-fragment-secret/)
    })
  }
})

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
  const hostSecret = join(home, 'host-secret.txt')
  await writeFile(hostSecret, 'must remain unreadable\n')
  const received = []
  const action = { id: 'action_fixture', actionType: 'test', status: 'ready', sourceCommit: commit, contractSnapshot: { source: { repositoryId: 'repo_fixture', repoUrl: 'https://example.test/org/repo.git', branch: 'main', commitSha: commit }, requiredChecks: [
    {id:'check_1',command:'sleep 0.15 && test "$(cat value.txt)" = ok',timeoutSeconds:10},
    {id:'check_2',command:'test -z "$AUDIT_HOST_SECRET" && test -z "$CAPITAL_AGENT_USER_KEY" && test -z "$CAPITAL_AGENT_LOCAL_PROVIDER_CONFIG"',timeoutSeconds:10},
    {id:'check_3',command:`! cat ${JSON.stringify(hostSecret)} >/dev/null 2>&1`,timeoutSeconds:10},
    {id:'check_4',command:'node -e "process.exit(process.versions.node ? 0 : 1)"',timeoutSeconds:10},
    {id:'check_5',command:'/bin/sh -c "test -f value.txt"',timeoutSeconds:10},
    {id:'check_6',command:'git diff --check',timeoutSeconds:10},
    {id:'check_7',command:'test -d .git && ! test -f .git',timeoutSeconds:10},
  ] } }
  const server = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk
    received.push({url:req.url,headers:req.headers,body:body?JSON.parse(body):{}})
    res.setHeader('Content-Type','application/json')
    if (req.url === '/api/harness/actions/action_fixture' && req.method === 'GET') {
      assert.equal(req.headers['x-user-key'], 'fixture-client-identity')
      assert.equal(req.headers['x-runner-token'], undefined)
      return res.end(JSON.stringify({code:0,data:action}))
    }
    if (req.url === '/api/execution/runner/heartbeat' && req.headers['x-runner-token'] === 'credential') {
      // Regression: production provider matching rejects URL-only capabilities.
      if (JSON.stringify(received.at(-1).body.capabilities.repositoryIds) !== '["repo_fixture"]') {
        res.statusCode = 409
        return res.end(JSON.stringify({code:409,msg:'repository_identity_capability_missing'}))
      }
    }
    if (req.url.endsWith('/claim')) return res.end(JSON.stringify({code:0,data:{action,lease:{leaseId:'lease_1'}}}))
    if (req.url.endsWith('/heartbeat')) return res.end(JSON.stringify({code:0,data:{status:'running',leaseExpiresAt:new Date(Date.now()+300000).toISOString()}}))
    if (req.url.endsWith('/evidence')) return res.end(JSON.stringify({code:0,data:{status:'succeeded'}}))
    res.end(JSON.stringify({code:0,data:{ok:true}}))
  })
  await new Promise(resolvePromise=>server.listen(0,'127.0.0.1',resolvePromise)); t.after(()=>server.close())
  const configDir=join(home,'.capital-agent','runner'); await mkdir(configDir,{recursive:true})
  const serverUrl = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(configDir,'config.json'),JSON.stringify({serverUrl,runnerId:'runner_fixture',runnerCredential:'credential',capabilities:['test']}))
  const clientDir = join(home, '.config', 'capital-agent'); await mkdir(clientDir, { recursive: true })
  await writeFile(join(clientDir, 'env'), `CAPITAL_AGENT_SERVER_URL=${serverUrl}\nCAPITAL_AGENT_USER_KEY=fixture-client-identity\n`)
  const result=await new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,[runtime,repo,'action_fixture'],{env:{...process.env,HOME:home,CAPITAL_AGENT_MODE:'server',AUDIT_HOST_SECRET:'must-not-leak',CAPITAL_AGENT_LOCAL_PROVIDER_HEARTBEAT_MS:'50'}})
    let stdout=''; let stderr=''
    child.stdout.on('data',chunk=>{stdout+=chunk})
    child.stderr.on('data',chunk=>{stderr+=chunk})
    child.on('error',reject)
    child.on('close',status=>resolvePromise({status,stdout,stderr}))
  })
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/"outcome": "PASS"/)
  const registrationHeartbeat=received.find(item=>item.url==='/api/execution/runner/heartbeat')
  assert.equal(received[0].url, '/api/harness/actions/action_fixture')
  assert.deepEqual(registrationHeartbeat.body.capabilities.repositoryIds, ['repo_fixture'])
  assert.deepEqual(registrationHeartbeat.body.capabilities.repositories, ['https://example.test/org/repo.git'])
  assert.equal(registrationHeartbeat.headers['x-user-key'], undefined)
  assert.deepEqual(registrationHeartbeat.body.capabilities.networkZones,['local','public','enterprise'])
  const evidence=received.find(item=>item.url.endsWith('/evidence'))
  assert.equal(evidence.body.evidence.testedHead,commit)
  assert.deepEqual(evidence.body.evidence.summary,{total:7,passed:7,failed:0,skipped:0})
  assert.match(evidence.body.evidence.receipts[0].environmentFingerprint, /sandbox=/)
  assert.equal(evidence.headers['x-runner-id'],'runner_fixture')
  assert.ok(received.some(item=>item.url.endsWith('/heartbeat')))
  assert.equal((await readFile(join(repo,'value.txt'),'utf8')).trim(),'ok')
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-client-identity|credential/)
})

async function leaseLossFixture(t, { descendant = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cap-provider-lease-loss-'))
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  assert.equal(git(repo, ['init']).status, 0)
  assert.equal(git(repo, ['config', 'user.name', 'Fixture']).status, 0)
  assert.equal(git(repo, ['config', 'user.email', 'fixture@example.test']).status, 0)
  await writeFile(join(repo, 'value.txt'), 'ok\n')
  assert.equal(git(repo, ['add', 'value.txt']).status, 0)
  assert.equal(git(repo, ['commit', '-m', 'fixture']).status, 0)
  assert.equal(git(repo, ['remote', 'add', 'origin', 'https://example.test/org/repo.git']).status, 0)
  const commit = String(git(repo, ['rev-parse', 'HEAD']).stdout).trim()
  const received = []
  let serverUrl = ''
  const action = { id: 'action_fixture', actionType: 'test', status: 'ready', sourceCommit: commit, contractSnapshot: { source: { repositoryId: 'repo_fixture', repoUrl: 'https://example.test/org/repo.git', branch: 'main', commitSha: commit }, requiredChecks: [] } }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    received.push({ url: req.url, body: raw ? JSON.parse(raw) : {} })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/harness/actions/action_fixture') return res.end(JSON.stringify({ code: 0, data: action }))
    if (req.url === '/api/execution/runner/harness/actions/claim') return res.end(JSON.stringify({ code: 0, data: { action, lease: { leaseId: 'lease_1' } } }))
    if (req.url === '/api/execution/runner/harness/actions/action_fixture/heartbeat') {
      res.statusCode = 503
      return res.end(JSON.stringify({ code: 503, msg: 'lease unavailable' }))
    }
    res.end(JSON.stringify({ code: 0, data: { ok: true } }))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => server.close())
  serverUrl = `http://127.0.0.1:${server.address().port}`
  action.contractSnapshot.requiredChecks = [
    { id: 'check_term_ignoring', command: descendant
      ? `trap 'exit 0' TERM; (trap '' TERM; sleep 1; curl --max-time 2 -fsS -X POST ${serverUrl}/orphan-check) </dev/null >/dev/null 2>&1 & wait`
      : "trap '' TERM; sleep 30", timeoutSeconds: 40 },
    { id: 'check_must_skip', command: `curl -fsS -X POST ${serverUrl}/second-check`, timeoutSeconds: 10 },
  ]
  const configDir = join(home, '.capital-agent', 'runner'); await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ serverUrl, runnerId: 'runner_fixture', runnerCredential: 'credential', capabilities: ['test'] }))
  const clientDir = join(home, '.config', 'capital-agent'); await mkdir(clientDir, { recursive: true })
  await writeFile(join(clientDir, 'env'), `CAPITAL_AGENT_SERVER_URL=${serverUrl}\nCAPITAL_AGENT_USER_KEY=fixture-client-identity\n`)
  const started = Date.now()
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runtime, repo, 'action_fixture'], { env: { ...process.env, HOME: home, CAPITAL_AGENT_MODE: 'server', CAPITAL_AGENT_LOCAL_PROVIDER_HEARTBEAT_MS: '50' } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject); child.on('close', status => resolvePromise({ status, stdout, stderr }))
  })
  const elapsed = Date.now() - started
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /续租失败，已停止执行/)
  if (descendant) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
    assert.equal(received.some(item => item.url === '/orphan-check'), false, 'same-group descendant must not continue after the command leader exits')
  } else assert.ok(elapsed >= 1800 && elapsed < 8000, `expected TERM→KILL in about 2 seconds, got ${elapsed}ms`)
  assert.equal(received.filter(item => item.url === '/api/execution/runner/harness/actions/action_fixture/heartbeat').length, 3)
  assert.equal(received.some(item => item.url === '/second-check'), false)
  assert.equal(received.some(item => item.url.endsWith('/evidence')), false)
  await assert.rejects(stat(join(home, '.capital-agent', 'runner', 'worktrees', 'action_fixture')), error => error.code === 'ENOENT')
}

test('lease loss kills a TERM-ignoring check, skips later checks and uploads no evidence', async t => {
  await leaseLossFixture(t)
})

test('lease loss kills redirected descendants when their command leader exits on TERM', async t => {
  await leaseLossFixture(t, { descendant: true })
})
