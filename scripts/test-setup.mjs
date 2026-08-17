import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { activationRuleBlock, activationRuleTargets, bootstrapLocalTestProvider, checkLocalTestProvider, checkPlatformConnection, checkPlatformHandshake, clientRestartNotice, codexConfigPath, cursorMcpConfigPath, hasActivationRule, hasCodexMcpConfig, hasCursorMcpConfig, hasSkillLink, inspectClaudeMcpConfig, inspectCodexMcpConfig, inspectCursorMcpConfig, inspectLocalTestProvider, installActivationRule, installCodexMcpConfig, installCursorActivationRule, installCursorMcpConfig, installLocalTestProvider, installSkillLinks, isCompatibleLocalNode, isCompatibleMcpNode, legacySkillNames, minimumLocalNodeVersion, minimumMcpNodeVersion, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization, publicSkillNames, resolveSystemAddresses, skillTargets, systemCurlJson } from './setup-lib.mjs'

test('parses setup modes and validates server URL', () => {
  assert.deepEqual(parseSetupArgs(['--server','https://example.test/','--doctor']).doctor, true)
  assert.equal(parseSetupArgs(['--local','--upgrade']).local, true)
  assert.equal(normalizeServerUrl('https://example.test/'), 'https://example.test')
  assert.throws(() => normalizeServerUrl('file:///tmp/a'))
})
test('local mode supports Node 18 without relaxing the MCP runtime', () => {
  assert.equal(minimumLocalNodeVersion, '18.0.0')
  assert.equal(isCompatibleLocalNode('18.0.0'), true)
  assert.equal(isCompatibleLocalNode('16.20.2'), false)
  assert.equal(isCompatibleMcpNode('18.20.8'), false)
})
test('requires the Node version needed by the fixed MCP runtime', () => {
  assert.equal(minimumMcpNodeVersion,'20.18.1')
  assert.equal(isCompatibleMcpNode('18.20.8'),false)
  assert.equal(isCompatibleMcpNode('20.18.0'),false)
  assert.equal(isCompatibleMcpNode('20.18.1'),true)
  assert.equal(isCompatibleMcpNode('22.22.2'),true)
  assert.equal(isCompatibleMcpNode('v24.14.0'),true)
})
test('uses the current Codex user skill discovery directory', () => {
  assert.equal(skillTargets('/home/dev').codex, '/home/dev/.agents/skills')
  assert.equal(activationRuleTargets('/home/dev').codex, '/home/dev/.codex/AGENTS.md')
  assert.equal(codexConfigPath('/home/dev'), '/home/dev/.codex/config.toml')
  assert.equal(skillTargets('/home/dev').cursor, '/home/dev/.cursor/skills')
  assert.equal(activationRuleTargets('/home/dev').cursor, '/home/dev/.cursor/rules/capital-agent.mdc')
  assert.equal(cursorMcpConfigPath('/home/dev'), '/home/dev/.cursor/mcp.json')
})
test('installs Codex MCP config without requiring the codex CLI or replacing other config', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-codex-config-'))
  const wrapper = join(home,'repo','mcp-remote.mjs'); await mkdir(join(home,'repo'),{recursive:true}); await writeFile(wrapper,'// fixture\n')
  const target = codexConfigPath(home); await mkdir(join(home,'.codex'),{recursive:true})
  await writeFile(target,'model = "example"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.capital-agent]\ncommand = "old"\nargs = ["old"]\n')
  await installCodexMcpConfig(target,'/opt/node',wrapper)
  await installCodexMcpConfig(target,'/opt/node',wrapper)
  const content=await readFile(target,'utf8')
  assert.match(content,/model = "example"/)
  assert.match(content,/\[mcp_servers\.other\]/)
  assert.equal(content.split('[mcp_servers.capital-agent]').length-1,1)
  assert.equal(content.split('capital-agent:mcp:start').length-1,1)
  assert.doesNotMatch(content,/command = "old"|args = \["old"\]/)
  assert.equal(content.split(`args = [${JSON.stringify(wrapper)}]`).length-1,1)
  assert.equal(await hasCodexMcpConfig(target,wrapper),true)
})
test('doctor accepts an existing Codex MCP wrapper installed from another checkout', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-codex-doctor-'))
  const target = codexConfigPath(home)
  const installedWrapper = join(home,'main-checkout','scripts','mcp-remote.mjs')
  const worktreeWrapper = join(home,'feature-worktree','scripts','mcp-remote.mjs')
  await mkdir(join(home,'.codex'),{recursive:true})
  await mkdir(join(home,'main-checkout','scripts'),{recursive:true})
  await writeFile(installedWrapper,'// fixture\n')
  await writeFile(target,`[mcp_servers.capital-agent]\ncommand = "/opt/node"\nargs = [${JSON.stringify(installedWrapper)}]\n`)
  assert.equal(await hasCodexMcpConfig(target,worktreeWrapper),true)
  assert.deepEqual(await inspectCodexMcpConfig(target,worktreeWrapper),{registered:true,command:'/opt/node',args:[installedWrapper],wrapperPath:installedWrapper,current:false,valid:true})
  await writeFile(target,`[mcp_servers.capital-agent]\ncommand = "/opt/node"\nargs = [${JSON.stringify(join(home,'missing','mcp-remote.mjs'))}]\n`)
  assert.equal(await hasCodexMcpConfig(target,worktreeWrapper),false)
})
test('doctor reads the actual Cursor and Claude MCP commands instead of probing the current checkout', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-installed-clients-')); const wrapper = join(home,'installed','mcp-remote.mjs')
  await mkdir(join(home,'installed'),{recursive:true}); await writeFile(wrapper,'// fixture\n')
  const cursor = join(home,'.cursor','mcp.json'); await mkdir(join(home,'.cursor'),{recursive:true})
  await writeFile(cursor,JSON.stringify({mcpServers:{'capital-agent':{command:'/opt/node',args:[wrapper]}}}))
  const claude = join(home,'.claude.json'); await writeFile(claude,JSON.stringify({mcpServers:{'capital-agent':{type:'stdio',command:'/opt/node',args:[wrapper],env:{}}}}))
  assert.deepEqual(await inspectCursorMcpConfig(cursor),{registered:true,command:'/opt/node',args:[wrapper],wrapperPath:wrapper,valid:true})
  assert.deepEqual(await inspectClaudeMcpConfig(claude),{registered:true,command:'/opt/node',args:[wrapper],wrapperPath:wrapper,valid:true})
})
test('system DNS fallback parses platform resolvers and gives curl the resolved address without changing TLS hostname', () => {
  const calls=[]
  const execFileSyncImpl=(command,args,options)=>{
    calls.push({command,args,options})
    if (command === '/usr/bin/dscacheutil') return 'name: capital-agent.example\nip_address: 100.12.0.1\n'
    return '{"data":{"capabilities":{"taskWrite":true,"commitReconcile":true}}}\n200'
  }
  assert.deepEqual(resolveSystemAddresses('capital-agent.example',{platform:'darwin',execFileSyncImpl}),['100.12.0.1'])
  const result=systemCurlJson('https://capital-agent.example/api/auth/handshake',{method:'PUT',headers:{'x-user-key':'key'},body:'{}'},{platform:'darwin',execFileSyncImpl})
  assert.equal(result.status,200)
  assert.match(calls.at(-1).options.input,/resolve = "capital-agent\.example:443:100\.12\.0\.1"/)
})
test('installs Cursor MCP config idempotently without replacing other servers or fields', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-cursor-config-'))
  const wrapper = join(home,'repo','mcp-remote.mjs'); await mkdir(join(home,'repo'),{recursive:true}); await writeFile(wrapper,'// fixture\n')
  const target = cursorMcpConfigPath(home); await mkdir(join(home,'.cursor'),{recursive:true})
  await writeFile(target,JSON.stringify({version:1,mcpServers:{other:{command:'other'},'capital-agent':{command:'old',args:['old']}}},null,2))
  await installCursorMcpConfig(target,'/opt/node',wrapper)
  await installCursorMcpConfig(target,'/opt/node',wrapper)
  const config=JSON.parse(await readFile(target,'utf8'))
  assert.equal(config.version,1)
  assert.equal(config.mcpServers.other.command,'other')
  assert.deepEqual(config.mcpServers['capital-agent'],{command:'/opt/node',args:[wrapper]})
  assert.equal(await hasCursorMcpConfig(target,wrapper),true)
})
test('refuses to overwrite invalid Cursor MCP JSON', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-cursor-invalid-'))
  const target = cursorMcpConfigPath(home); await mkdir(join(home,'.cursor'),{recursive:true}); await writeFile(target,'{ invalid')
  await assert.rejects(installCursorMcpConfig(target,'/opt/node','/repo/mcp-remote.mjs'),/不是有效 JSON/)
  assert.equal(await readFile(target,'utf8'),'{ invalid')
})
test('installs one managed activation block without overwriting user instructions', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-activation-'))
  const target = join(home,'.codex','AGENTS.md')
  await mkdir(join(home,'.codex'),{recursive:true})
  await writeFile(target,'# My rules\n\nKeep this.\n')
  await installActivationRule(target)
  await installActivationRule(target)
  const content = await readFile(target,'utf8')
  assert.match(content,/# My rules/)
  assert.match(content,/Keep this\./)
  assert.equal(content.split('capital-agent:auto-activation:start').length - 1,1)
  assert.equal(await hasActivationRule(target),true)
  assert.match(activationRuleBlock,/纯问答.*不创建平台 Task/)
  assert.match(activationRuleBlock,/restart_required/)
  assert.match(activationRuleBlock,/本次明确改用本地模式继续/)
  assert.match(activationRuleBlock,/--allow-local-once/)
})

test('installation and upgrade tell users that an already open client cannot hot-load MCP', () => {
  const notice = clientRestartNotice()
  assert.match(notice,/完全退出并重新打开/)
  assert.match(notice,/新建任务/)
  assert.match(notice,/分支和工作区改动不会丢失/)
})
test('installs an idempotent Cursor always-on rule without replacing other rules', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-cursor-rule-'))
  const target = activationRuleTargets(home).cursor
  await installCursorActivationRule(target)
  await installCursorActivationRule(target)
  const content = await readFile(target,'utf8')
  assert.match(content,/alwaysApply: true/)
  assert.match(content,/当前目录位于 Git 仓库/)
  assert.match(content,/纯问答.*不创建平台 Task/)
  assert.equal(content.split('capital-agent:auto-activation:start').length - 1,1)
  assert.equal(content.split('alwaysApply: true').length - 1,1)
})
test('installs only the cap public entry without replacing an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cap-setup-')); const source = join(root,'source'); const target = join(root,'target')
  for (const name of ['cap','harvest-experience','cap-flow','cap-define']) await mkdir(join(source,name), { recursive: true })
  await mkdir(join(target,'harvest-experience'), { recursive: true })
  assert.deepEqual(publicSkillNames, ['cap'])
  assert.deepEqual(await installSkillLinks(source,target), ['cap'])
  assert.equal(await readlink(join(target,'cap')), join(source,'cap'))
  assert.equal(await hasSkillLink(source,target), true)
  assert.equal((await lstat(join(target,'harvest-experience'))).isDirectory(), true)
  await assert.rejects(readlink(join(target,'cap-flow')))
})
test('upgrade removes only old internal links owned by this skill package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cap-setup-clean-')); const source = join(root,'source'); const target = join(root,'target'); const other = join(root,'other')
  for (const name of ['cap','harvest-experience','cap-flow','cap-define']) await mkdir(join(source,name), { recursive: true })
  await mkdir(other, { recursive: true }); await mkdir(target, { recursive: true })
  await symlink(join(source,'cap-flow'),join(target,'cap-flow'))
  await symlink(join(source,'harvest-experience'),join(target,'harvest-experience'))
  await symlink(join(source,'cap-shape'),join(target,'cap-shape'))
  await symlink(other,join(target,'cap-define'))
  await installSkillLinks(source,target)
  await assert.rejects(lstat(join(target,'cap-flow')))
  await assert.rejects(lstat(join(target,'harvest-experience')))
  await assert.rejects(lstat(join(target,'cap-shape')))
  assert.equal(await readlink(join(target,'cap-define')), other)
  assert.deepEqual(legacySkillNames, ['cap-map','cap-shape','cap-build','cap-verify'])
})
test('polls until browser approval', async () => {
  let calls = 0
  const key = await pollDeviceAuthorization('https://example.test','secret',{ wait: async()=>{}, fetchImpl: async()=>({ ok: ++calls > 1, status: calls > 1 ? 200 : 202, json: async()=>calls > 1 ? {data:{user_key:'u1'}} : {data:{status:'pending'}} }) })
  assert.equal(key,'u1')
})
test('doctor probes an authenticated API route behind the public gateway', async () => {
  let request
  const ok = await checkPlatformConnection('https://example.test','user-key',async (url, options) => { request = { url, options }; return { ok: true } })
  assert.equal(ok,true)
  assert.equal(request.url,'https://example.test/api/auth/heartbeat')
  assert.equal(request.options.method,'PUT')
  assert.equal(request.options.headers['x-user-key'],'user-key')
})
test('doctor handshake verifies write and commit reconcile capabilities', async () => {
  let request
  const result = await checkPlatformHandshake('https://example.test','user-key',async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ data: { protocolVersion: 1, capabilities: { taskWrite: true, commitReconcile: true } } }) } })
  assert.equal(result.ok,true)
  assert.equal(request.url,'https://example.test/api/auth/handshake')
})
test('bootstraps a test-only provider without exposing credentials in arguments', async () => {
  let request
  const result = await bootstrapLocalTestProvider('https://example.test','user-key',{clientId:'client_12345678',clientName:'laptop'},async (url, options) => {
    request = { url, options }
    return { ok: true, status: 201, json: async () => ({ data: { runnerId: 'runner_1', runnerCredential: 'credential', capabilities: ['test'] } }) }
  })
  assert.equal(result.runnerId,'runner_1')
  assert.equal(request.url,'https://example.test/api/auth/local-test-provider/bootstrap')
  assert.equal(request.options.headers['x-user-key'],'user-key')
  assert.deepEqual(JSON.parse(request.options.body),{clientId:'client_12345678',clientName:'laptop'})
})
test('installs local provider runtime and test-only credentials with a valid doctor probe', async () => {
  const home = await mkdtemp(join(tmpdir(),'cap-provider-'))
  const source = join(home,'source.mjs')
  await writeFile(source,'console.log("fixture")\n')
  const installed = await installLocalTestProvider({ home, source, serverUrl:'https://example.test', registration:{runnerId:'runner_1',runnerCredential:'credential'}, clientId:'client_12345678' })
  assert.match(await readFile(installed.runtimePath,'utf8'),/fixture/)
  const state = await inspectLocalTestProvider(home)
  assert.equal(state.ok,true)
  assert.deepEqual(state.config.capabilities,['test'])
  let request
  const probe = await checkLocalTestProvider(state.config,async (url, options) => { request={url,options}; return {ok:true,status:200} })
  assert.equal(probe.ok,true)
  assert.equal(request.options.headers['x-runner-id'],'runner_1')
  assert.equal(JSON.parse(request.options.body).capabilities.patch,false)
})
