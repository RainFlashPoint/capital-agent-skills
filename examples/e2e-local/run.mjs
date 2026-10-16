#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectInstallationState, writeInstallManifest } from '../../scripts/setup-lib.mjs'

const home = await mkdtemp(join(tmpdir(), 'capital-agent-e2e-home-'))
const source = join(home, 'capital-agent-skills')
await mkdir(join(source, 'skills', 'cap'), { recursive: true })
await mkdir(join(source, '.claude-plugin'), { recursive: true })
await writeFile(join(source, 'skills', 'cap', 'SKILL.md'), '---\nname: cap\n---\n# fixture\n')
await writeFile(join(source, '.claude-plugin', 'plugin.json'), '{"name":"fixture","version":"1.0.0"}\n')
execFileSync('git', ['init', '-q'], { cwd: source })
execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source })
execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: source })
execFileSync('git', ['add', '.'], { cwd: source })
execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: source })
execFileSync('git', ['branch', '-M', 'main'], { cwd: source })
execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/public/fixture.git'], { cwd: source })
await writeInstallManifest(home, source)

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
const current = await inspectInstallationState(home, source, { remoteResolver: async () => ({ remoteRef: 'refs/heads/main', remoteHead: head }), now: 1000 })
assert.equal(current.status, 'current')

await writeFile(join(source, 'remote-change.txt'), 'remote\n')
execFileSync('git', ['add', '.'], { cwd: source })
execFileSync('git', ['commit', '-qm', 'remote change'], { cwd: source })
const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
execFileSync('git', ['reset', '--hard', '-q', head], { cwd: source })
const update = await inspectInstallationState(home, source, { remoteResolver: async () => ({ remoteRef: 'refs/heads/main', remoteHead }), now: 1000 + 7 * 60 * 60 * 1000 })
assert.equal(update.status, 'remote_update_available')
assert.equal(update.safeToUpgrade, true)

await writeFile(join(source, 'skills', 'cap', 'SKILL.md'), '# local change\n')
const dirty = await inspectInstallationState(home, source, { remoteResolver: async () => ({ remoteRef: 'refs/heads/main', remoteHead }), now: 1000 + 14 * 60 * 60 * 1000 })
assert.equal(dirty.status, 'working_tree_modified')
assert.equal(dirty.safeToUpgrade, false)

process.stdout.write(`${JSON.stringify({ valid: true, fixture: 'local-install-update-safety', states: [current.status, update.status, dirty.status] }, null, 2)}\n`)
