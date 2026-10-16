#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function safePath(repoRoot, candidate) {
  const path = resolve(repoRoot, candidate)
  if (path !== repoRoot && !path.startsWith(`${repoRoot}/`) && !path.startsWith(`${repoRoot}\\`)) throw new Error('scenario_path_escape')
  return path
}

export async function loadScenarios(repoRoot = root) {
  const directory = join(repoRoot, 'evals', 'scenarios')
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  return Promise.all(files.map(async name => ({ file: `evals/scenarios/${name}`, ...JSON.parse(await readFile(join(directory, name), 'utf8')) })))
}

export async function runScenario(repoRoot, scenario) {
  const started = Date.now()
  let passed = false
  let evidence = {}
  if (scenario.runner === 'node_test') {
    const testFile = safePath(repoRoot, scenario.testFile)
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', scenario.testNamePattern, testFile], { cwd: repoRoot, encoding: 'utf8', timeout: Number(scenario.timeoutMs || 30_000), env: childEnv })
    const output = `${result.stdout || ''}${result.stderr || ''}`
    const requested = new RegExp(scenario.testNamePattern)
    const matchedTests = [...output.matchAll(/^# Subtest: (.+)$/gm)].map(match => match[1]).filter(name => requested.test(name)).length
    const matchingOutcomes = [...output.matchAll(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+)$/gm)].map(match => {
      const directive = match[2].match(/\s+#\s+(SKIP|TODO)\b/i)
      const name = directive ? match[2].slice(0, directive.index).trim() : match[2].trim()
      return { result: match[1], name, directive: directive?.[1]?.toUpperCase() || '' }
    }).filter(item => requested.test(item.name))
    const executedTests = matchingOutcomes.filter(item => !item.directive).length
    const skippedTests = matchingOutcomes.filter(item => item.directive === 'SKIP').length
    const todoTests = matchingOutcomes.filter(item => item.directive === 'TODO').length
    const failedTests = Number(output.match(/^# fail (\d+)\s*$/m)?.[1] || 0)
    passed = result.status === 0 && matchedTests > 0 && executedTests === matchedTests && skippedTests === 0 && todoTests === 0 && failedTests === 0
    evidence = { command: `node --test --test-reporter=tap --test-name-pattern ${JSON.stringify(scenario.testNamePattern)} ${scenario.testFile}`, exitCode: result.status, matchedTests, executedTests, skippedTests, todoTests, failedTests, outputTail: output.trim().split(/\r?\n/).slice(-12) }
  } else if (scenario.runner === 'file_contains') {
    const content = await readFile(safePath(repoRoot, scenario.path), 'utf8')
    const missing = (scenario.patterns || []).filter(pattern => !content.includes(pattern))
    passed = missing.length === 0
    evidence = { path: scenario.path, checkedPatterns: scenario.patterns || [], missing }
  } else throw new Error(`unknown_scenario_runner:${scenario.runner}`)
  return { id: scenario.id, title: scenario.title, category: scenario.category, status: passed ? 'PASS' : 'FAIL', deterministic: true, liveModel: { status: 'not-run', reason: 'No live model or private Server result is fabricated by the deterministic suite.' }, durationMs: Date.now() - started, evidence }
}

export async function runEvalSuite(repoRoot = root, options = {}) {
  const available = await loadScenarios(repoRoot)
  const requested = [...new Set(options.ids || [])]
  const knownIds = new Set(available.map(item => item.id))
  const unknown = requested.filter(id => !knownIds.has(id))
  if (unknown.length) throw new Error(`unknown_eval_scenario_ids:${unknown.join(',')}`)
  const scenarios = available.filter(item => !requested.length || requested.includes(item.id))
  if (!scenarios.length) throw new Error('eval_suite_empty')
  const results = []
  for (const scenario of scenarios) results.push(await runScenario(repoRoot, scenario))
  const passed = results.filter(item => item.status === 'PASS').length
  return { schemaVersion: 1, suite: 'capital-agent-deterministic-core', generatedAt: new Date(options.now || Date.now()).toISOString(), summary: { total: results.length, passed, failed: results.length - passed, liveModelRuns: 0 }, results }
}

function markdown(report) {
  const lines = ['# Capital Agent deterministic eval', '', `Result: ${report.summary.passed}/${report.summary.total} PASS`, '', '| Scenario | Category | Result | Live model |', '|---|---|---:|---|']
  for (const item of report.results) lines.push(`| ${item.title} | ${item.category} | ${item.status} | ${item.liveModel.status} |`)
  lines.push('', '> Live model / private Server runs are intentionally not included in this deterministic local report.')
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)) {
  const format = argv.includes('--markdown') ? 'markdown' : 'json'
  const ids = argv.filter(value => value.startsWith('--id=')).map(value => value.slice(5))
  const report = await runEvalSuite(root, { ids })
  return { report, output: format === 'markdown' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`, valid: report.summary.total > 0 && report.summary.failed === 0 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ output, valid }) => { process.stdout.write(output); if (!valid) process.exitCode = 1 }).catch(error => { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1 })
}
