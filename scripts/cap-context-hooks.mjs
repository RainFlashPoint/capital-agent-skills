#!/usr/bin/env node
// Retired global adapter. Keep this inert entry point so already-open hosts
// caching the old command cannot deny tools or recreate lifecycle records.
import { pathToFileURL } from 'node:url'

export async function handleContextHook() { return { continue: true } }
export function codexHooksConfig() {
  return { supported: false, reason: 'Capital Agent global context hooks have been removed. Remove existing registrations from the host configuration.', toml: '' }
}
export async function recoverContextHook() {
  return { valid: false, code: 'native_hooks_removed', nextAction: 'Use the explicit cap checkpoint preparation workflow when needed. No global tool hook is installed.' }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'config') process.stdout.write(`${JSON.stringify(codexHooksConfig())}\n`)
  else if (process.argv[2] === 'recover') process.stdout.write(`${JSON.stringify(await recoverContextHook())}\n`)
  else {
    // Drain even malformed legacy input; no callback may block an ordinary chat.
    try { for await (const chunk of process.stdin) { /* discard */ } } catch {}
    process.stdout.write(`${JSON.stringify(await handleContextHook())}\n`)
  }
}
