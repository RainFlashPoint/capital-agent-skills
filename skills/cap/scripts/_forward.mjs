import { runPackageScript } from './cap-package.mjs'

const ALLOWED_SCRIPTS = new Set([
  'cap-execute.mjs',
  'cap-local-test-provider.mjs',
  'cap-outbox.mjs',
  'cap-push-candidate.mjs',
  'cap-status.mjs',
  'cap-task-request.mjs',
  'cap-task-state-switch.mjs',
])

export async function forwardToPackageScript(scriptName) {
  if (!ALLOWED_SCRIPTS.has(scriptName)) throw new Error(`unsupported_cap_script: ${scriptName}`)
  await runPackageScript(`scripts/${scriptName}`)
}
