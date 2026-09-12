#!/usr/bin/env node
import { runLocalAction } from '../runtime/execution/local-flow.mjs'

function args(argv) {
  const out = { command: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--command') out.command = JSON.parse(argv[++i])
    else if (key === '--constraints') out.constraints = JSON.parse(argv[++i])
    else if (key === '--action') out.action = argv[++i]
    else if (key === '--stage') out.stage = argv[++i]
    else if (key === '--repo') out.repo = argv[++i]
  }
  return out
}

const options = args(process.argv.slice(2))
const secret = process.env.CAP_LOCAL_EXECUTION_SECRET
if (!secret) { process.stderr.write('cap-execute: BLOCKED — CAP_LOCAL_EXECUTION_SECRET is required\n'); process.exit(2) }
if (!Array.isArray(options.command) || !options.command.length) { process.stderr.write('cap-execute: BLOCKED — --command must be a JSON argv array\n'); process.exit(2) }
try {
  const result = await runLocalAction(options.repo || '.', { ...options, secret })
  process.stdout.write(`${JSON.stringify({ gate: result.gate, artifactDir: result.artifactDir }, null, 2)}\n`)
  process.exitCode = result.gate.passed ? 0 : 1
} catch (error) {
  process.stderr.write(`cap-execute: BLOCKED — ${error.message}\n`)
  process.exitCode = 1
}
