import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkPlatformConnection, installSkillLinks, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization, skillTargets } from './setup-lib.mjs'

test('parses setup modes and validates server URL', () => {
  assert.deepEqual(parseSetupArgs(['--server','https://example.test/','--doctor']).doctor, true)
  assert.equal(normalizeServerUrl('https://example.test/'), 'https://example.test')
  assert.throws(() => normalizeServerUrl('file:///tmp/a'))
})
test('uses the current Codex user skill discovery directory', () => {
  assert.equal(skillTargets('/home/dev').codex, '/home/dev/.agents/skills')
})
test('installs links without replacing an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cap-setup-')); const source = join(root,'source'); const target = join(root,'target')
  await mkdir(join(source,'cap-flow'), { recursive: true }); await mkdir(join(source,'custom'), { recursive: true }); await mkdir(join(target,'custom'), { recursive: true })
  assert.deepEqual(await installSkillLinks(source,target), ['cap-flow'])
  assert.equal(await readlink(join(target,'cap-flow')), join(source,'cap-flow'))
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
