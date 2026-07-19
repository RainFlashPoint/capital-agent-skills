#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const marker = '# capital-agent-managed-prepare-commit-msg'
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hookPathRaw = execFileSync('git', ['rev-parse', '--git-path', 'hooks/prepare-commit-msg'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const hookPath = resolve(repoRoot, hookPathRaw)
const originalPath = `${hookPath}.capital-agent-original`
const handlerPath = join(packageRoot, 'scripts/prepare-commit-msg.mjs')

await mkdir(dirname(hookPath), { recursive: true })
const existing = await readFile(hookPath, 'utf8').catch(() => '')
if (existing && !existing.includes(marker)) {
  try { await access(originalPath) } catch { await rename(hookPath, originalPath) }
}
const wrapper = `#!/bin/sh\n${marker}\nset -u\noriginal=${JSON.stringify(originalPath)}\nif [ -x "$original" ]; then "$original" "$@" || exit $?; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(handlerPath)} "$@"\n`
await writeFile(hookPath, wrapper, { mode: 0o755 })
await chmod(hookPath, 0o755)
await mkdir(join(repoRoot, '.cap'), { recursive: true })
try { await access(join(repoRoot, '.cap/.gitignore')) } catch { await copyFile(join(packageRoot, 'templates/cap-gitignore'), join(repoRoot, '.cap/.gitignore')) }
process.stdout.write('Capital Agent 项目关联已就绪。\n')
