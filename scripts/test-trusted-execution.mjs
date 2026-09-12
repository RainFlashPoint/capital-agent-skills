import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnvelope, executeEnvelope } from '../runtime/execution/executor.mjs'
import { evaluateGate } from '../runtime/execution/gate.mjs'

const secret = 'local-test-secret-which-is-long-enough'
const now = new Date(); const issuedAt = new Date(now.getTime() - 60000).toISOString(); const expiresAt = new Date(now.getTime() + 600000).toISOString()
const base = { task:'task-1', repo:'repo-1', branch:'codex/test', commit:'a'.repeat(40), tenant:'tenant-a', project:'project-a', agent:'agent-a', runner:'runner-test', action:'test', command:['node','-e','process.stdout.write("ok")'], allowedEnv:[], constraints:['same-commit'] , issuedAt, expiresAt }

test('executor produces a bound receipt and gate passes', async () => {
  const envelope = createEnvelope(base, secret)
  const result = await executeEnvelope(envelope, { secret, now:now.toISOString() })
  const gate = evaluateGate(envelope, result.receipt, { envelopeSecret:secret, receiptSecret:secret, now:new Date().toISOString() })
  assert.equal(result.stdout, 'ok'); assert.equal(gate.gate, 'PASS')
})

test('tampering commit or evidence blocks the gate', async () => {
  const envelope = createEnvelope(base, secret)
  const result = await executeEnvelope(envelope, { secret, now:now.toISOString() })
  const tampered = { ...envelope, commit:'b'.repeat(40) }
  const gate = evaluateGate(tampered, result.receipt, { envelopeSecret:secret, receiptSecret:secret, now:new Date().toISOString() })
  assert.equal(gate.gate, 'BLOCKED'); assert.ok(gate.blockers.includes('execution_evidence_identity'))
})

test('authorization key substitution and workspace escape are rejected', async () => {
  const envelope = createEnvelope(base, secret)
  const changedKey = { ...envelope, authorization: { ...envelope.authorization, keyId:'other-key' } }
  await assert.rejects(() => executeEnvelope(changedKey, { secret, now:now.toISOString() }), /execution_signature/)
  await assert.rejects(() => executeEnvelope(envelope, { secret, cwd:'/', workspaceRoot:process.cwd(), now:now.toISOString() }), /execution_workspace_escape/)
})

test('shell syntax and non-allowlisted commands are rejected', async () => {
  assert.throws(() => createEnvelope({ ...base, command:['node','-e','x; rm -rf /'] }, secret), /execution_shell_syntax/)
  const envelope = createEnvelope({ ...base, command:['curl','https://example.invalid'] }, secret)
  await assert.rejects(() => executeEnvelope(envelope, { secret, now:now.toISOString() }), /execution_command_not_allowlisted/)
  const interpreter = createEnvelope({ ...base, command:['bash','-c','printf injected'] }, secret)
  await assert.rejects(() => executeEnvelope(interpreter, { secret, now:now.toISOString() }), /execution_command_not_allowlisted/)
})

test('invalid timestamps fail closed', async () => {
  assert.throws(() => createEnvelope({ ...base, issuedAt:'bad' }, secret), /execution_invalid_issuedAt/)
  const envelope = createEnvelope(base, secret)
  await assert.rejects(() => executeEnvelope(envelope, { secret, now:'bad' }), /execution_invalid_now/)
})

test('expired envelopes and failed commands cannot pass', async () => {
  const envelope = createEnvelope({ ...base, command:['node','-e','process.exit(2)'], expiresAt:new Date(now.getTime()+1000).toISOString() }, secret)
  const result = await executeEnvelope(envelope, { secret, now:now.toISOString() })
  const gate = evaluateGate(envelope, result.receipt, { envelopeSecret:secret, receiptSecret:secret, now:new Date(now.getTime()+120000).toISOString() })
  assert.equal(gate.gate, 'BLOCKED'); assert.ok(gate.blockers.includes('execution_expired')); assert.ok(gate.blockers.includes('execution_failed'))
})
