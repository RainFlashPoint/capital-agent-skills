#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const marker = '# capital-agent-managed-prepare-commit-msg'
const postCommitMarker = '# capital-agent-managed-post-commit'
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hookPathRaw = execFileSync('git', ['rev-parse', '--git-path', 'hooks/prepare-commit-msg'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const hookPath = resolve(repoRoot, hookPathRaw)
const originalPath = `${hookPath}.capital-agent-original`
const handlerPath = join(packageRoot, 'scripts/prepare-commit-msg.mjs')
const postCommitHandlerPath = join(packageRoot, 'scripts/post-commit.mjs')
const postCommitPathRaw = execFileSync('git', ['rev-parse', '--git-path', 'hooks/post-commit'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const postCommitPath = resolve(repoRoot, postCommitPathRaw)
const postCommitOriginalPath = `${postCommitPath}.capital-agent-original`
const prePushPathRaw = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const prePushPath = resolve(repoRoot, prePushPathRaw)
const prePushTemplate = join(packageRoot, 'skills/cap-flow/references/templates/hooks/pre-push')

await mkdir(dirname(hookPath), { recursive: true })
const existing = await readFile(hookPath, 'utf8').catch(() => '')
if (existing && !existing.includes(marker)) {
  try { await access(originalPath) } catch { await rename(hookPath, originalPath) }
}
const wrapper = `#!/bin/sh\n${marker}\nset -u\noriginal=${JSON.stringify(originalPath)}\nif [ -x "$original" ]; then "$original" "$@" || exit $?; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(handlerPath)} "$@"\n`
await writeFile(hookPath, wrapper, { mode: 0o755 })
await chmod(hookPath, 0o755)
const existingPostCommit = await readFile(postCommitPath, 'utf8').catch(() => '')
if (existingPostCommit && !existingPostCommit.includes(postCommitMarker)) {
  try { await access(postCommitOriginalPath) } catch { await rename(postCommitPath, postCommitOriginalPath) }
}
const postCommitWrapper = `#!/bin/sh\n${postCommitMarker}\nset -u\noriginal=${JSON.stringify(postCommitOriginalPath)}\nif [ -x "$original" ]; then "$original" "$@" || true; fi\n${JSON.stringify(process.execPath)} ${JSON.stringify(postCommitHandlerPath)} "$@" || true\nexit 0\n`
await writeFile(postCommitPath, postCommitWrapper, { mode: 0o755 })
await chmod(postCommitPath, 0o755)
// pre-push 仍保持 opt-in；但已安装的 Capital Agent 旧模板要随升级自动刷新，避免项目永久停留在旧门禁语义。
const existingPrePush = await readFile(prePushPath, 'utf8').catch(() => '')
if (existingPrePush.includes('# cap-flow pre-push 检查')) {
  await copyFile(prePushTemplate, prePushPath)
  await chmod(prePushPath, 0o755)
}
await mkdir(join(repoRoot, '.cap'), { recursive: true })
try { await access(join(repoRoot, '.cap/.gitignore')) } catch { await copyFile(join(packageRoot, 'templates/cap-gitignore'), join(repoRoot, '.cap/.gitignore')) }
process.stdout.write('Capital Agent 项目关联已就绪。\n')
