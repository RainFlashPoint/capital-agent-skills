import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { activationRuleBlock, activationRuleTargets, bootstrapLocalTestProvider, checkLocalTestProvider, checkPlatformConnection, checkPlatformHandshake, hasActivationRule, inspectLocalTestProvider, installActivationRule, installLocalTestProvider, installSkillLinks, legacySkillNames, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization, publicSkillNames, skillTargets } from './setup-lib.mjs'

test('parses setup modes and validates server URL', () => {
  assert.deepEqual(parseSetupArgs(['--server','https://example.test/','--doctor']).doctor, true)
  assert.equal(normalizeServerUrl('https://example.test/'), 'https://example.test')
  assert.throws(() => normalizeServerUrl('file:///tmp/a'))
})
test('uses the current Codex user skill discovery directory', () => {
  assert.equal(skillTargets('/home/dev').codex, '/home/dev/.agents/skills')
  assert.equal(activationRuleTargets('/home/dev').codex, '/home/dev/.codex/AGENTS.md')
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
})
test('installs only the cap public entry without replacing an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cap-setup-')); const source = join(root,'source'); const target = join(root,'target')
  for (const name of ['cap','harvest-experience','cap-flow','cap-define']) await mkdir(join(source,name), { recursive: true })
  await mkdir(join(target,'harvest-experience'), { recursive: true })
  assert.deepEqual(publicSkillNames, ['cap'])
  assert.deepEqual(await installSkillLinks(source,target), ['cap'])
  assert.equal(await readlink(join(target,'cap')), join(source,'cap'))
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
