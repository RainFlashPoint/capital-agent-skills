#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { parseJson } from '../runtime/ontology/json.mjs'
import {
  createTestImpact,
  freezeTestCandidate,
  inspectTestState,
} from '../runtime/execution/test-state.mjs'

export function parseArguments(argv) {
  const out = { operation: 'status', repo: '.', targetedCommands: [] }
  let index = 0
  if (argv[0] && !argv[0].startsWith('-')) out.operation = argv[index++]
  if (!['impact', 'freeze', 'status'].includes(out.operation)) throw new Error('test_state_cli_operation')
  for (; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--help' || key === '-h') { out.help = true; continue }
    const value = argv[++index]
    if (value === undefined) throw new Error('test_state_cli_missing_value')
    if (key === '--repo') out.repo = value
    else if (key === '--plan-mode') out.planMode = value
    else if (key === '--audit-scope') out.auditScope = value
    else if (key === '--changed-files') out.changedFiles = parseJson(value)
    else if (key === '--active-checks') out.activeChecks = parseJson(value)
    else if (key === '--targeted-command') out.targetedCommands.push(parseJson(value))
    else if (key === '--full-command') out.fullCommand = parseJson(value)
    else throw new Error('test_state_cli_unknown_option')
  }
  return out
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv)
    if (options.help) {
      process.stdout.write('cap-test state machine\nUsage:\n  node scripts/cap-test-state.mjs impact --repo <repository> [--plan-mode change|baseline-audit] [--audit-scope full-chain] --changed-files <json-array> --active-checks <json-array> --targeted-command <json-argv> [--targeted-command <json-argv> ...] --full-command <json-argv>\n  node scripts/cap-test-state.mjs freeze --repo <repository>\n  node scripts/cap-test-state.mjs status --repo <repository>\n')
      return 0
    }
    let result
    if (options.operation === 'impact') result = await createTestImpact(options.repo, options)
    else if (options.operation === 'freeze') result = await freezeTestCandidate(options.repo)
    else result = await inspectTestState(options.repo)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = /^(?:test_|execution_|json_)[A-Za-z0-9_]+/.exec(String(error.message))?.[0] || 'test_state_failed'
    process.stderr.write(`cap-test-state: ${JSON.stringify({ code })}\n`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main()
