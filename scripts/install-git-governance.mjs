#!/usr/bin/env node
import { copyFile, mkdir, chmod, access } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const resolvedGitDir = resolve(repoRoot, gitDir)
await mkdir(join(resolvedGitDir, 'hooks'), { recursive: true })
await copyFile(join(packageRoot, 'templates/git-hooks/commit-msg'), join(resolvedGitDir, 'hooks/commit-msg'))
await chmod(join(resolvedGitDir, 'hooks/commit-msg'), 0o755)
await mkdir(join(repoRoot, '.cap'), { recursive: true })
try { await access(join(repoRoot, '.cap/.gitignore')) } catch { await copyFile(join(packageRoot, 'templates/cap-gitignore'), join(repoRoot, '.cap/.gitignore')) }
await mkdir(join(repoRoot, '.gitlab/ci'), { recursive: true })
try { await access(join(repoRoot, '.gitlab/ci/capital-agent-quality.yml')) } catch { await copyFile(join(packageRoot, 'templates/gitlab/capital-agent-quality.yml'), join(repoRoot, '.gitlab/ci/capital-agent-quality.yml')) }
process.stdout.write('Capital Agent Git 治理已安装。请在 .gitlab-ci.yml include .gitlab/ci/capital-agent-quality.yml。\n')
