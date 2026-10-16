#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function problem(code, detail, expected = '', actual = '') {
  return { code, detail, ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) }
}

export function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(changelog).match(new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))
  return match?.[1]?.trim() || ''
}

export async function readReleaseContract(repoRoot = root) {
  const [pluginText, marketplaceText, readme, changelog] = await Promise.all([
    readFile(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8'),
    readFile(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
    readFile(join(repoRoot, 'README.md'), 'utf8'),
    readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8'),
  ])
  const plugin = JSON.parse(pluginText)
  const marketplace = JSON.parse(marketplaceText)
  const version = String(plugin.version || '').trim()
  return {
    repoRoot,
    version,
    tag: version ? `v${version}` : '',
    plugin,
    marketplace,
    readme,
    changelog,
    releaseNotes: extractReleaseNotes(changelog, version),
  }
}

export function validateReleaseContract(contract, options = {}) {
  const phase = options.phase || 'worktree'
  const errors = []
  const version = contract.version
  const semanticVersion = SEMVER.exec(version)
  if (!semanticVersion) errors.push(problem('version_invalid', 'plugin.json must contain a valid semantic version', 'x.y.z', version))
  else if (semanticVersion[4]) errors.push(problem('version_prerelease_unsupported', 'The public release workflow only publishes stable semantic versions', 'x.y.z', version))
  else if (semanticVersion[5]) errors.push(problem('version_build_metadata_unsupported', 'The public release workflow only publishes plain stable semantic versions', 'x.y.z', version))
  const copies = [
    ['marketplace.metadata.version', contract.marketplace?.metadata?.version],
    ['marketplace.plugins[0].version', contract.marketplace?.plugins?.[0]?.version],
  ]
  for (const [name, value] of copies) if (String(value || '') !== version) errors.push(problem('version_copy_mismatch', `${name} must match plugin.json`, version, String(value || '')))
  const marker = `<!-- release-version: ${version} -->`
  if (!contract.readme.includes(marker)) errors.push(problem('readme_version_missing', 'README must expose the machine-checkable current release marker', marker))
  if (!contract.releaseNotes) errors.push(problem('changelog_release_missing', 'CHANGELOG must contain a non-empty section for the current version', `## ${version}`))
  if (phase === 'tag' || phase === 'release') {
    if (options.tagName !== contract.tag) errors.push(problem('tag_version_mismatch', 'Git tag must match the manifest version', contract.tag, options.tagName || ''))
    if (!options.headCommit) errors.push(problem('checked_commit_missing', 'The checked Commit must resolve before validating a tag'))
    if (!options.tagCommit) errors.push(problem('tag_commit_missing', 'Git tag must exist and resolve to a Commit', contract.tag))
    else if (options.headCommit !== options.tagCommit) errors.push(problem('tag_commit_mismatch', 'Git tag must resolve to the checked commit', options.headCommit, options.tagCommit))
  }
  if (phase === 'release') {
    if (options.release?.status !== 'available') errors.push(problem('release_unobserved', 'GitHub Release must be observed through the public API before validation', contract.tag, options.release?.status || 'missing'))
    else {
      if (options.release.tagName !== contract.tag) errors.push(problem('release_tag_mismatch', 'GitHub Release tag must match the manifest version', contract.tag, options.release.tagName || ''))
      if (options.release.draft === true) errors.push(problem('release_is_draft', 'GitHub Release must not be a draft'))
      if (!semanticVersion?.[4] && options.release.prerelease === true) errors.push(problem('release_is_prerelease', 'A stable manifest version must not be published as a prerelease'))
      if (options.release.latestTagName !== contract.tag) errors.push(problem('release_not_latest', 'GitHub latest public Release must match the manifest version', contract.tag, options.release.latestTagName || ''))
    }
  }
  return { valid: errors.length === 0, phase, version, tag: contract.tag, errors }
}

export async function inspectGitHubRelease(repository, tagName, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Number(options.timeoutMs || 2500)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  try {
    const [tagResponse, latestResponse] = await Promise.all([
      fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`, { headers, signal: controller.signal }),
      fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: controller.signal }),
    ])
    if (tagResponse.status === 404) return { status: 'not_found', tagName: '', latestTagName: '', draft: false, prerelease: false }
    if (!tagResponse.ok || !latestResponse.ok) return { status: 'unavailable', error: `github_api_${tagResponse.status}_${latestResponse.status}`, tagName: '', latestTagName: '', draft: false, prerelease: false }
    const [release, latest] = await Promise.all([tagResponse.json(), latestResponse.json()])
    return { status: 'available', tagName: String(release.tag_name || ''), latestTagName: String(latest.tag_name || ''), draft: release.draft === true, prerelease: release.prerelease === true }
  } catch (error) {
    return { status: 'unavailable', error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error), tagName: '', latestTagName: '', draft: false, prerelease: false }
  } finally {
    clearTimeout(timer)
  }
}

export async function inspectPublishedVersions(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Number(options.timeoutMs || 2500)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  try {
    const [tagsResponse, releaseResponse] = await Promise.all([
      fetchImpl(`https://api.github.com/repos/${repository}/tags?per_page=100`, { headers, signal: controller.signal }),
      fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: controller.signal }),
    ])
    if (!tagsResponse.ok || !releaseResponse.ok) throw new Error(`github_api_${tagsResponse.status}_${releaseResponse.status}`)
    const tags = await tagsResponse.json()
    const release = await releaseResponse.json()
    const versions = tags.map(item => String(item.name || '')).filter(name => /^v\d+\.\d+\.\d+/.test(name)).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).reverse()
    return { status: 'available', latestTag: versions[0] || '', latestRelease: String(release.tag_name || ''), checkedAt: new Date(options.now || Date.now()).toISOString() }
  } catch (error) {
    return { status: 'offline_unknown', latestTag: '', latestRelease: '', error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error), checkedAt: new Date(options.now || Date.now()).toISOString() }
  } finally {
    clearTimeout(timer)
  }
}

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function parseArgs(argv) {
  const [command = 'check', ...rest] = argv
  const value = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] || '' : '' }
  return { command, phase: value('--phase') || 'worktree', repo: value('--repo') || root, tagName: value('--tag') || process.env.GITHUB_REF_NAME || '', repository: value('--repository') || process.env.GITHUB_REPOSITORY || 'RainFlashPoint/capital-agent-skills' }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const contract = await readReleaseContract(resolve(args.repo))
  if (args.command === 'notes') return { valid: Boolean(contract.releaseNotes), version: contract.version, notes: contract.releaseNotes }
  if (args.command === 'published') return { valid: true, version: contract.version, ...(await inspectPublishedVersions(args.repository)) }
  let headCommit = ''
  let tagCommit = ''
  if (args.phase === 'tag' || args.phase === 'release') {
    try { headCommit = git(['rev-parse', 'HEAD^{commit}'], contract.repoRoot) } catch {}
    try { tagCommit = args.tagName ? git(['rev-parse', `${args.tagName}^{commit}`], contract.repoRoot) : '' } catch {}
  }
  const release = args.phase === 'release'
    ? await inspectGitHubRelease(args.repository, args.tagName, { token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '' })
    : null
  return validateReleaseContract(contract, { phase: args.phase, tagName: args.tagName, headCommit, tagCommit, release })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => {
    if (result.notes) process.stdout.write(`${result.notes}\n`)
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
  }).catch(error => {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [problem('release_contract_unreadable', String(error?.message || error))] }, null, 2)}\n`)
    process.exitCode = 1
  })
}
