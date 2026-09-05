#!/usr/bin/env node
import { buildCommitDelivery, queueCommitDelivery, readClientConfig, sendCommitDelivery } from './client-delivery.mjs'
import { execFileSync } from 'node:child_process'
import { isLocalFallbackActive } from './local-fallback.mjs'

let repoRoot = ''
try { repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() } catch { process.exit(0) }
const config = await readClientConfig()
const effectiveMode = String(process.env.CAPITAL_AGENT_MODE || config.CAPITAL_AGENT_MODE || '').trim().toLowerCase()
if (effectiveMode === 'local') process.exit(0)
const item = await buildCommitDelivery(repoRoot)
if (!item) process.exit(0)
if (await isLocalFallbackActive(repoRoot, { branch: item.payload?.branch, taskId: item.taskId })) process.exit(0)
const ok = await sendCommitDelivery({ serverUrl: config.CAPITAL_AGENT_SERVER_URL, userKey: config.CAPITAL_AGENT_USER_KEY, ...item })
if (!ok) {
  try {
    await queueCommitDelivery(repoRoot, item)
  } catch (error) {
    // post-commit must never turn a successful Git commit into a failed hook.
    // The next cap-status run will surface the reconciliation gap from HEAD.
    process.stderr.write(`cap: Delivery Outbox 写入失败，保留 Git 提交并等待下次对账（${error?.code || error?.message || 'unknown_error'}）\n`)
  }
}
process.exit(0)
