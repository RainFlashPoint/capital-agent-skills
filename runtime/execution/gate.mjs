import { verifyEnvelope, verifyReceipt } from './protocol.mjs'

export function evaluateGate(envelope, receipt, { envelopeSecret, receiptSecret, action = envelope.action, now = new Date().toISOString() } = {}) {
  const blockers = []
  try { verifyEnvelope(envelope, envelopeSecret, now) } catch (error) { blockers.push(error.message) }
  try { verifyReceipt(receipt, envelope, receiptSecret, now) } catch (error) { blockers.push(error.message) }
  if (receipt?.status !== 'passed' || receipt?.exitCode !== 0) blockers.push('execution_failed')
  if (!['build','test','scan','package','deploy'].includes(action)) blockers.push('execution_action_invalid')
  const passed = blockers.length === 0
  return { schemaVersion: 1, gate: passed ? 'PASS' : 'BLOCKED', action, passed, blockers: [...new Set(blockers)].sort(), envelopeId: envelope?.id || null, evidenceHash: receipt?.evidenceHash || null }
}
