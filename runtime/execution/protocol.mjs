import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { canonical, digest } from '../ontology/schema.mjs'

export const ACTIONS = new Set(['build', 'test', 'scan', 'package', 'deploy'])
export const ENVELOPE_VERSION = 1

function fail(code) { throw new Error(`execution_${code}`) }
function required(value, name) { if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail(`invalid_${name}`) }
function timestamp(value, name) {
  required(value, name)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`invalid_${name}`)
}

export function unsignedEnvelope(envelope) {
  const { authorization, ...unsigned } = envelope
  return { ...unsigned, authorization: { keyId: authorization?.keyId } }
}

export function validateEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== ENVELOPE_VERSION) fail('envelope_version')
  for (const key of ['id','task','repo','branch','commit','tenant','project','agent','runner']) required(envelope[key], key)
  timestamp(envelope.issuedAt, 'issuedAt'); timestamp(envelope.expiresAt, 'expiresAt')
  if (!ACTIONS.has(envelope.action)) fail('action')
  if (!Array.isArray(envelope.command) || envelope.command.length < 1 || envelope.command.length > 32 || envelope.command.some(x => typeof x !== 'string' || x.length > 400)) fail('command')
  if (envelope.command.some(x => /[;&|`$<>\n\r]/.test(x))) fail('shell_syntax')
  if (!Array.isArray(envelope.allowedEnv) || envelope.allowedEnv.some(x => typeof x !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(x))) fail('env_allowlist')
  if (!Array.isArray(envelope.constraints) || envelope.constraints.some(x => typeof x !== 'string' || x.length > 200)) fail('constraints')
  if (Date.parse(envelope.expiresAt) <= Date.parse(envelope.issuedAt)) fail('window')
  if (Date.parse(envelope.expiresAt) - Date.parse(envelope.issuedAt) > 3600000) fail('window_too_long')
  if (!envelope.authorization || typeof envelope.authorization.keyId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(envelope.authorization.keyId) || typeof envelope.authorization.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.authorization.signature)) fail('authorization')
  return envelope
}

export function signEnvelope(envelope, secret) {
  if (typeof secret !== 'string' || secret.length < 16) fail('signing_secret')
  const unsigned = unsignedEnvelope(envelope)
  return createHmac('sha256', secret).update(canonical(unsigned)).digest('hex')
}

export function verifyEnvelope(envelope, secret, now = new Date().toISOString()) {
  validateEnvelope(envelope)
  timestamp(now, 'now')
  if (Date.parse(now) < Date.parse(envelope.issuedAt) || Date.parse(now) >= Date.parse(envelope.expiresAt)) fail('expired')
  const expected = Buffer.from(signEnvelope(envelope, secret), 'hex')
  const actual = Buffer.from(envelope.authorization.signature, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('signature')
  return true
}

export function evidenceDigest(evidence) { return digest(evidence) }

export function verifyEvidenceBinding(envelope, evidence) {
  if (!evidence || evidence.schemaVersion !== 1) fail('evidence_version')
  for (const key of ['envelopeId','task','repo','branch','commit','runner','status','stdoutHash','stderrHash']) required(evidence[key], key)
  timestamp(evidence.startedAt, 'startedAt'); timestamp(evidence.finishedAt, 'finishedAt')
  if (!Number.isInteger(evidence.exitCode)) fail('invalid_exitCode')
  if (evidence.envelopeId !== envelope.id || evidence.task !== envelope.task || evidence.repo !== envelope.repo || evidence.branch !== envelope.branch || evidence.commit !== envelope.commit || evidence.runner !== envelope.runner) fail('evidence_identity')
  const expectedCommandHash = createHash('sha256').update(JSON.stringify(envelope.command)).digest('hex')
  if (evidence.commandHash !== expectedCommandHash || canonical(evidence.constraints) !== canonical(envelope.constraints)) fail('evidence_execution_binding')
  if (!['passed','failed','timed_out','rejected'].includes(evidence.status) || !Number.isInteger(evidence.exitCode)) fail('evidence_result')
  return true
}

export function receiptSignature(receipt, secret) {
  if (typeof secret !== 'string' || secret.length < 16) fail('receipt_secret')
  const { signature, ...unsigned } = receipt
  return createHmac('sha256', secret).update(canonical(unsigned)).digest('hex')
}

export function verifyReceipt(receipt, envelope, secret, now = new Date().toISOString()) {
  verifyEvidenceBinding(envelope, receipt)
  if (receipt.authority !== 'trusted-executor' || receipt.evidenceHash !== evidenceDigest(receipt.evidence)) fail('receipt_provenance')
  timestamp(now, 'now')
  if (Date.parse(now) < Date.parse(receipt.finishedAt)) fail('receipt_future')
  const expected = receiptSignature(receipt, secret)
  if (expected !== receipt.signature) fail('receipt_signature')
  return true
}
