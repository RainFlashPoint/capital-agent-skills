import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScenarios, runEvalSuite, runScenario } from './eval-cap.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('eval scenarios are uniquely identified and cover the seven public trust risks', async () => {
  const scenarios = await loadScenarios()
  assert.equal(new Set(scenarios.map(item => item.id)).size, scenarios.length)
  assert.deepEqual(new Set(scenarios.map(item => item.category)), new Set(['stale_commit', 'repository_boundary', 'regression_coverage', 'independent_review', 'authorization_recovery', 'history_reuse', 'solution_necessity']))
})

test('deterministic eval suite passes without inventing live model results', async () => {
  const report = await runEvalSuite()
  assert.equal(report.summary.total, 7)
  assert.equal(report.summary.failed, 0)
  assert.equal(report.summary.liveModelRuns, 0)
  assert.ok(report.results.every(item => item.deterministic && item.liveModel.status === 'not-run'))
})

test('node-test scenarios fail when the requested test name matches nothing', async () => {
  const result = await runScenario(root, {
    id: 'missing-test', title: 'missing test', category: 'regression_coverage', runner: 'node_test',
    testFile: 'scripts/test-release-contract.mjs', testNamePattern: 'definitely-no-such-test-name-012345',
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.evidence.exitCode, 0)
  assert.equal(result.evidence.matchedTests, 0)
})

test('node-test scenarios fail when the requested test is skipped', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'cap-eval-skipped-'))
  try {
    await writeFile(join(fixture, 'skipped.mjs'), "import test from 'node:test'\ntest('selected skipped evidence', { skip: true }, () => {})\n")
    const result = await runScenario(fixture, {
      id: 'skipped-test', title: 'skipped test', category: 'regression_coverage', runner: 'node_test',
      testFile: 'skipped.mjs', testNamePattern: 'selected skipped evidence',
    })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.evidence.matchedTests, 1)
    assert.equal(result.evidence.executedTests, 0)
    assert.equal(result.evidence.skippedTests, 1)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('eval selection rejects an unknown scenario id instead of reporting 0/0 PASS', async () => {
  await assert.rejects(runEvalSuite(root, { ids: ['definitely-unknown'] }), /unknown_eval_scenario_ids:definitely-unknown/)
})

test('eval selection rejects mixed known and unknown scenario ids', async () => {
  const [known] = await loadScenarios(root)
  await assert.rejects(runEvalSuite(root, { ids: [known.id, 'definitely-unknown'] }), /unknown_eval_scenario_ids:definitely-unknown/)
})
