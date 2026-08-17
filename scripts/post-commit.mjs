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
if (!ok) await queueCommitDelivery(repoRoot, item)
process.exit(0)
