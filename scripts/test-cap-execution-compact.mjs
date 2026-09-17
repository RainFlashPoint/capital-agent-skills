import test from 'node:test'
import assert from 'node:assert/strict'
import { compactExecutionResult } from '../runtime/execution/local-flow.mjs'
import { observeCommand } from '../runtime/execution/local-support.mjs'

const sha = char => char.repeat(64)

function mockRun(overrides = {}) {
  const stdout = overrides.stdout ?? `${'PASS detail line\n'.repeat(900)}completed 120/120\n`
  const stderr = overrides.stderr ?? ''
  const gate = overrides.gate ?? {
    schemaVersion: 2,
    trust: 'local-observed',
    gate: 'PASS',
    passed: true,
    stage: 'test',
    action: 'test',
    envelopeId: 'action-mock',
    blockers: [],
    nextActions: [],
    remediation: '证据与当前源码快照一致',
  }
  return {
    envelope: { schemaVersion: 2, trust: 'local-observed', id: 'action-mock', stage: 'test', action: 'test' },
    receipt: {
      schemaVersion: 2,
      authority: 'local-observed',
      envelopeId: 'action-mock',
      exitCode: overrides.exitCode ?? 0,
      signal: overrides.signal ?? null,
      status: overrides.status ?? 'passed',
      stdoutHash: sha('a'),
      stderrHash: sha('b'),
      diagnosticPath: 'diagnostic.json',
    },
    gate,
    artifactDir: '/mock/.cap/execution/action-mock',
    stdout,
    stderr,
    diagnostic: overrides.diagnostic,
  }
}

function legacyVisibleBytes(run) {
  const result = { schemaVersion: 2, trust: 'local-observed', gate: run.gate, artifactDir: run.artifactDir }
  return Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr) + Buffer.byteLength(JSON.stringify(result))
}

function assertDecision(projected, expected) {
  assert.deepEqual({
    outputMode: projected.outputMode,
    stage: projected.stage,
    action: projected.action,
    gate: projected.gate.gate,
    passed: projected.gate.passed,
    envelopeId: projected.execution.envelopeId,
    blockers: projected.gate.blockers,
    nextActions: projected.gate.nextActions,
    remediation: projected.gate.remediation,
    status: projected.execution.status,
    exitCode: projected.execution.exitCode,
    signal: projected.execution.signal,
  }, expected)
}

test('successful execution emits a minimal decision-equivalent projection', () => {
  const run = mockRun()
  const compact = compactExecutionResult(run)
  assertDecision(compact, {
    outputMode: 'compact', stage: 'test', action: 'test', gate: 'PASS', passed: true,
    envelopeId: 'action-mock', blockers: [], nextActions: [], remediation: '证据与当前源码快照一致',
    status: 'passed', exitCode: 0, signal: null,
  })
  assert.equal(compact.output.stdout.bytes, Buffer.byteLength(run.stdout))
  assert.equal(compact.output.stdout.sha256, run.receipt.stdoutHash)
  assert.equal(compact.output.stderr.bytes, 0)
  assert.equal('diagnostic' in compact, false)
  assert.doesNotMatch(JSON.stringify(compact), /PASS detail line/)
})

test('failed execution falls back to bounded head and tail diagnostics', () => {
  const gate = {
    ...mockRun().gate,
    gate: 'BLOCKED',
    passed: false,
    blockers: ['command_failed'],
    nextActions: [{ kind: 'diagnose_command_failure', label: '检查失败输出并修复实现或测试命令' }],
    remediation: '检查 nextActions 后修复并用新的 action ID 重跑',
  }
  const stdout = `first failure context\n${'noise\n'.repeat(5000)}last assertion failed\n`
  const run = mockRun({ gate, status: 'failed', exitCode: 2, stdout, stderr: 'token=sk-123456789012345\n' })
  const projected = compactExecutionResult(run)
  assertDecision(projected, {
    outputMode: 'full-fallback', stage: 'test', action: 'test', gate: 'BLOCKED', passed: false,
    envelopeId: 'action-mock', blockers: ['command_failed'],
    nextActions: [{ kind: 'diagnose_command_failure', label: '检查失败输出并修复实现或测试命令' }],
    remediation: '检查 nextActions 后修复并用新的 action ID 重跑', status: 'failed', exitCode: 2, signal: null,
  })
  assert.equal(projected.diagnostic.truncated, true)
  assert.match(projected.diagnostic.stdout, /first failure context/)
  assert.match(projected.diagnostic.stdout, /last assertion failed/)
  assert.match(projected.diagnostic.stderr, /REDACTED/)
  assert.doesNotMatch(projected.diagnostic.stderr, /sk-123456789012345/)
})

test('source drift and execution failures always restore diagnostics', () => {
  for (const blocker of ['source_changed_during_execution', 'timed_out', 'output_limit', 'spawn_failed']) {
    const run = mockRun({
      gate: { ...mockRun().gate, gate: 'BLOCKED', passed: false, blockers: [blocker] },
      status: blocker === 'source_changed_during_execution' ? 'passed' : blocker,
      stdout: `${blocker}\n`,
    })
    const projected=compactExecutionResult(run)
    assert.equal(projected.outputMode, 'full-fallback', blocker)
    assert.deepEqual(projected.gate.blockers, [blocker])
    assert.equal(projected.execution.status, blocker === 'source_changed_during_execution' ? 'passed' : blocker)
  }
})

test('fallback recomputes redaction and covers common credential forms', () => {
  const secrets = [
    'EXAMPLE_CREDENTIAL_VALUE', 'db-password', 'cookie-value', 'url-password', 'bearer-value-12345',
    'githubtokenvalue123456', 'private-key-body', 'EXAMPLE_JSON_PASSWORD', 'EXAMPLE_JSON_TOKEN',
    'EXAMPLE_QUERY_TOKEN', 'EXAMPLE_PS_CREDENTIAL', 'EXAMPLE_AZURE_SECRET', 'EXAMPLE_USER_KEY',
    'EXAMPLE_MAP_PASSWORD', 'EXAMPLE_BRACKET_KEY', 'EXAMPLE_PAREN_PASSWORD',
    'EXAMPLE_CAMEL_SECRET', 'EXAMPLE_CAMEL_TOKEN',
  ]
  const privateKeyBegin=['-----BEGIN','PRIVATE KEY-----'].join(' ')
  const privateKeyEnd=['-----END','PRIVATE KEY-----'].join(' ')
  const stderr = [
    'AWS_SECRET_ACCESS_KEY=EXAMPLE_CREDENTIAL_VALUE',
    'DATABASE_URL=postgres://dbuser:db-password@example.invalid/app',
    'COOKIE=session=cookie-value',
    'connect postgres://urluser:url-password@example.invalid/app',
    'Authorization: Bearer bearer-value-12345',
    'github_pat_githubtokenvalue123456',
    '{"password":"EXAMPLE_JSON_PASSWORD","access_token":"EXAMPLE_JSON_TOKEN"}',
    'https://example.invalid/callback?token=EXAMPLE_QUERY_TOKEN&safe=yes',
    '$env:AWS_SECRET_ACCESS_KEY=EXAMPLE_PS_CREDENTIAL',
    'AZURE_CLIENT_SECRET=EXAMPLE_AZURE_SECRET',
    'X_USER_KEY=EXAMPLE_USER_KEY',
    '{password=EXAMPLE_MAP_PASSWORD}',
    'headers=[api_key=EXAMPLE_BRACKET_KEY]',
    'failure(password: EXAMPLE_PAREN_PASSWORD)',
    '{"clientSecret":"EXAMPLE_CAMEL_SECRET"}',
    'failure(accessToken=EXAMPLE_CAMEL_TOKEN)',
    privateKeyBegin,
    'private-key-body',
    privateKeyEnd,
  ].join('\n')
  const gate = { ...mockRun().gate, gate: 'BLOCKED', passed: false, blockers: ['command_failed'] }
  const run = mockRun({ gate, status: 'failed', exitCode: 2, stderr, diagnostic: { stderr, stdout: '', truncated: false } })
  const projected = compactExecutionResult(run)
  assert.match(projected.diagnostic.stderr, /REDACTED/)
  for (const secret of secrets) assert.doesNotMatch(projected.diagnostic.stderr, new RegExp(secret))
})

test('truncation drops incomplete boundary lines before fallback redaction', async () => {
  const secret='EXAMPLE_SPLIT_CREDENTIAL'
  const script=`process.stdout.write(${JSON.stringify(`${'x'.repeat(35)}AWS_SECRET_ACCESS_KEY=${secret}${'y'.repeat(140)}`)})`
  const observed=await observeCommand([process.execPath,'-e',script],{cwd:process.cwd(),env:{},timeoutMs:5000,maxOutputBytes:100})
  assert.equal(observed.status,'output_limit')
  assert.match(observed.stdout,/oversized single line removed for credential safety; bytes=/)
  const gate={...mockRun().gate,gate:'BLOCKED',passed:false,blockers:['output_limit']}
  const projected=compactExecutionResult(mockRun({gate,status:'output_limit',exitCode:null,signal:'SIGKILL',stdout:observed.stdout}))
  assert.doesNotMatch(projected.diagnostic.stdout,new RegExp(secret))
})

test('CR-only progress retains the final complete diagnostic line', async () => {
  const output=`${'progress-step\r'.repeat(30)}FINAL_FAILURE\r`
  const script=`process.stderr.write(${JSON.stringify(output)})`
  const observed=await observeCommand([process.execPath,'-e',script],{cwd:process.cwd(),env:{},timeoutMs:5000,maxOutputBytes:100})
  assert.equal(observed.status,'output_limit')
  assert.match(observed.stderr,/FINAL_FAILURE/)
})

test('inconsistent PASS metadata fails closed to diagnostic mode', () => {
  const projected=compactExecutionResult(mockRun({ status: 'failed', exitCode: 7, stderr: 'failure marker' }))
  assert.equal(projected.outputMode, 'full-fallback')
  assert.match(projected.diagnostic.stderr, /failure marker/)
})

test('mock A/B reduces normal model-visible bytes by at least 50 percent', t => {
  const runs = [
    mockRun(),
    mockRun({ stdout: `${'unit ok\n'.repeat(1200)}1200 passed\n` }),
    mockRun({ stdout: `${'build asset emitted\n'.repeat(800)}build complete\n` }),
    mockRun({ stdout: `${'lint clean\n'.repeat(600)}0 errors\n` }),
    mockRun({ stdout: `${'git unchanged\n'.repeat(500)}clean\n` }),
  ]
  const totals = runs.reduce((sum, run) => {
    sum.full += legacyVisibleBytes(run)
    sum.compact += Buffer.byteLength(JSON.stringify(compactExecutionResult(run)))
    return sum
  }, { full: 0, compact: 0 })
  const ratio = totals.compact / totals.full
  t.diagnostic(`execution A/B bytes: full=${totals.full}, compact=${totals.compact}, ratio=${ratio.toFixed(3)}, reduction=${((1 - ratio) * 100).toFixed(1)}%`)
  assert.ok(ratio <= 0.5, `compact ratio ${ratio.toFixed(3)} exceeds 0.5`)
})
