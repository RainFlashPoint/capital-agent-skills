#!/usr/bin/env node
import { buildCommitDelivery, queueCommitDelivery, readClientConfig, sendCommitDelivery } from './client-delivery.mjs'
import { execFileSync } from 'node:child_process'

let repoRoot = ''
try { repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() } catch { process.exit(0) }
const item = await buildCommitDelivery(repoRoot)
if (!item) process.exit(0)
const config = await readClientConfig()
const ok = await sendCommitDelivery({ serverUrl: config.CAPITAL_AGENT_SERVER_URL, userKey: config.CAPITAL_AGENT_USER_KEY, ...item })
if (!ok) await queueCommitDelivery(repoRoot, item)
process.exit(0)
