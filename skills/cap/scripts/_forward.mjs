import { fileURLToPath } from 'node:url'

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
  const target = new URL(`../../../scripts/${scriptName}`, import.meta.url)
  process.argv[1] = fileURLToPath(target)
  await import(target.href)
}
