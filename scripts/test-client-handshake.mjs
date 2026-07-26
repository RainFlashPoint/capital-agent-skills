import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPlatformHandshake } from './setup-lib.mjs'

test('client handshake sends machine and repository capabilities without putting user key in response data', async () => {
  let request
  const result = await checkPlatformHandshake('https://example.test', 'secret-user-key', async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, json: async () => ({ data: { protocolVersion: 2, client: { registered: true }, capabilities: { taskWrite: true, commitReconcile: true } } }) }
  }, { clientId: 'client_1', repoUrl: 'team/app', branch: 'feature/x', mcpReachable: true })
  assert.equal(result.ok, true)
  assert.equal(request.url, 'https://example.test/api/auth/handshake')
  assert.equal(request.options.headers['x-user-key'], 'secret-user-key')
  assert.deepEqual(JSON.parse(request.options.body), { clientId: 'client_1', repoUrl: 'team/app', branch: 'feature/x', mcpReachable: true })
  assert.equal(JSON.stringify(result).includes('secret-user-key'), false)
})
