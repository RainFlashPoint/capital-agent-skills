import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { installSkillLinks, normalizeServerUrl, parseSetupArgs, pollDeviceAuthorization } from './setup-lib.mjs'

test('parses setup modes and validates server URL', () => {
  assert.deepEqual(parseSetupArgs(['--server','https://example.test/','--doctor']).doctor, true)
  assert.equal(normalizeServerUrl('https://example.test/'), 'https://example.test')
  assert.throws(() => normalizeServerUrl('file:///tmp/a'))
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
