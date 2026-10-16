#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const anchor = await realpath(fileURLToPath(import.meta.url))
const packageRoot = resolve(dirname(anchor), '../../..')

// Resolve only against the actual loaded entrypoint, never cwd, install siblings,
// cached worktrees, environment overrides, or a search for another package.
export async function resolvePackageResource(resource) {
  if (typeof resource !== 'string' || !resource || isAbsolute(resource) || /[\\\0]/.test(resource) || resource.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('cap_resource_path_invalid')
  if (!['skills', 'scripts', 'runtime'].includes(resource.split('/')[0])) throw new Error('cap_resource_path_invalid')
  const contained = async path => {
    const target = await realpath(resolve(packageRoot, path))
    const rel = relative(packageRoot, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cap_resource_source_mismatch')
    if (!(await stat(target)).isFile()) throw new Error('cap_resource_not_file')
    return target
  }
  const pluginPath = await contained('.claude-plugin/plugin.json')
  const plugin = JSON.parse(await readFile(pluginPath, 'utf8'))
  if (plugin.name !== 'capital-agent-skills' || typeof plugin.version !== 'string') throw new Error('cap_package_invalid')
  const skillPath = await contained('skills/cap/SKILL.md')
  const resourcePath = await contained(resource)
  return {
    schemaVersion: 1,
    packageRoot,
    packageVersion: plugin.version,
    skillPath,
    skillDigest: digest(await readFile(skillPath)),
    resource,
    resourcePath,
    resourceDigest: digest(await readFile(resourcePath)),
  }
}

export async function runPackageScript(resource, args = process.argv.slice(2)) {
  if (!/^scripts\/[^/]+\.mjs$/.test(resource)) throw new Error('cap_script_path_invalid')
  const resolved = await resolvePackageResource(resource)
  process.argv = [process.execPath, resolved.resourcePath, ...args]
  await import(pathToFileURL(resolved.resourcePath).href)
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === anchor) {
  try {
    const [command, resource, ...args] = process.argv.slice(2)
    if (command === 'resolve' && args.length === 0) console.log(JSON.stringify(await resolvePackageResource(resource)))
    else if (command === 'run') await runPackageScript(resource, args)
    else throw new Error('usage: cap-package.mjs resolve <package-relative-file> | run scripts/<name>.mjs [args...]')
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: error.code === 'ENOENT' ? 'cap_package_resource_missing' : error.message }))
    process.exitCode = 1
  }
}
