import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractReleaseNotes, inspectGitHubRelease, inspectPublishedVersions, readReleaseContract, validateReleaseContract } from './release-contract.mjs'

async function fixture(version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'cap-release-contract-'))
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version }))
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ metadata: { version }, plugins: [{ version }] }))
  await writeFile(join(root, 'README.md'), `# Fixture\n\n<!-- release-version: ${version} -->\n`)
  await writeFile(join(root, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\n- shipped\n\n## 1.2.2\n\n- old\n`)
  return root
}

test('worktree contract uses plugin.json as the single version source', async () => {
  const root = await fixture()
  const contract = await readReleaseContract(root)
  assert.deepEqual(validateReleaseContract(contract), { valid: true, phase: 'worktree', version: '1.2.3', tag: 'v1.2.3', errors: [] })
  assert.equal(contract.releaseNotes, '- shipped')
})

test('version copies, README marker and CHANGELOG section fail independently', async () => {
  const root = await fixture()
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ metadata: { version: '1.2.2' }, plugins: [{ version: '1.2.1' }] }))
  await writeFile(join(root, 'README.md'), '# Fixture\n')
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n')
  const result = validateReleaseContract(await readReleaseContract(root))
  assert.equal(result.valid, false)
  assert.deepEqual(result.errors.map(item => item.code), ['version_copy_mismatch', 'version_copy_mismatch', 'readme_version_missing', 'changelog_release_missing'])
})

test('tag and release phases bind semantic version, commit and latest stable GitHub Release tag', async () => {
  const contract = await readReleaseContract(await fixture())
  assert.equal(validateReleaseContract(contract, { phase: 'tag', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a' }).valid, true)
  assert.equal(validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a', release: { status: 'available', tagName: 'v1.2.3', latestTagName: 'v1.2.3', draft: false, prerelease: false } }).valid, true)
  const wrongTag = validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.2', headCommit: 'a', tagCommit: 'b', release: { status: 'available', tagName: 'v1.2.1', latestTagName: 'v1.2.3', draft: false, prerelease: false } })
  assert.deepEqual(wrongTag.errors.map(item => item.code), ['tag_version_mismatch', 'tag_commit_mismatch', 'release_tag_mismatch'])
})

test('tag and release phases fail closed when artifacts are missing or unobserved', async () => {
  const contract = await readReleaseContract(await fixture())
  assert.deepEqual(validateReleaseContract(contract, { phase: 'tag', tagName: 'v1.2.3', headCommit: 'a', tagCommit: '' }).errors.map(item => item.code), ['tag_commit_missing'])
  assert.deepEqual(validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a', release: { status: 'not_found' } }).errors.map(item => item.code), ['release_unobserved'])
  assert.deepEqual(validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a', release: { status: 'available', tagName: 'v1.2.3', latestTagName: 'v1.2.3', draft: true, prerelease: false } }).errors.map(item => item.code), ['release_is_draft'])
})

test('stable releases reject prerelease metadata and an older non-latest Release', async () => {
  const contract = await readReleaseContract(await fixture())
  const prerelease = validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a', release: { status: 'available', tagName: 'v1.2.3', latestTagName: 'v1.2.3', draft: false, prerelease: true } })
  assert.deepEqual(prerelease.errors.map(item => item.code), ['release_is_prerelease'])
  const older = validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3', headCommit: 'a', tagCommit: 'a', release: { status: 'available', tagName: 'v1.2.3', latestTagName: 'v1.2.4', draft: false, prerelease: false } })
  assert.deepEqual(older.errors.map(item => item.code), ['release_not_latest'])
})

test('the public release contract rejects prerelease manifest versions', async () => {
  const contract = await readReleaseContract(await fixture('1.2.3-rc.1'))
  const worktree = validateReleaseContract(contract)
  assert.deepEqual(worktree.errors.map(item => item.code), ['version_prerelease_unsupported'])
  const release = validateReleaseContract(contract, { phase: 'release', tagName: 'v1.2.3-rc.1', headCommit: 'a', tagCommit: 'a', release: { status: 'available', tagName: 'v1.2.3-rc.1', latestTagName: 'v1.2.3-rc.1', draft: false, prerelease: false } })
  assert.ok(release.errors.some(item => item.code === 'version_prerelease_unsupported'))
})

test('the stable-only public release contract rejects build metadata and malformed empty identifiers', async () => {
  const build = validateReleaseContract(await readReleaseContract(await fixture('1.2.3+good.meta')))
  assert.deepEqual(build.errors.map(item => item.code), ['version_build_metadata_unsupported'])
  for (const version of ['1.2.3+..', '1.2.3+meta.']) {
    const malformed = validateReleaseContract(await readReleaseContract(await fixture(version)))
    assert.deepEqual(malformed.errors.map(item => item.code), ['version_invalid'], version)
  }
})

test('GitHub Release inspection distinguishes observed, draft, missing and unavailable artifacts', async () => {
  const observed = await inspectGitHubRelease('org/repo', 'v1.2.3', { fetchImpl: async url => ({ ok: true, status: 200, json: async () => ({ tag_name: url.endsWith('/latest') ? 'v1.2.3' : 'v1.2.3', draft: false, prerelease: false }) }) })
  assert.deepEqual(observed, { status: 'available', tagName: 'v1.2.3', latestTagName: 'v1.2.3', draft: false, prerelease: false })
  assert.equal((await inspectGitHubRelease('org/repo', 'v1.2.3', { fetchImpl: async url => url.includes('/tags/') ? ({ ok: false, status: 404 }) : ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.2.2' }) }) })).status, 'not_found')
  assert.equal((await inspectGitHubRelease('org/repo', 'v1.2.3', { fetchImpl: async () => { throw new Error('offline') } })).status, 'unavailable')
})

test('release notes extraction stops at the next version', () => {
  assert.equal(extractReleaseNotes('# C\n\n## 2.0.0\n\nA\n\n## 1.0.0\n\nB\n', '2.0.0'), 'A')
})

test('release notes extraction accepts the final CHANGELOG section', () => {
  assert.equal(extractReleaseNotes('# C\n\n## 1.0.0\n\nFinal release notes\n', '1.0.0'), 'Final release notes')
})

test('published version query distinguishes available data from timeout/offline unknown', async () => {
  const ok = await inspectPublishedVersions('org/repo', { fetchImpl: async url => ({ ok: true, status: 200, json: async () => url.includes('/tags?') ? [{ name: 'v1.2.3' }, { name: 'v1.10.0' }] : { tag_name: 'v1.2.3' } }), now: 0 })
  assert.equal(ok.status, 'available')
  assert.equal(ok.latestTag, 'v1.10.0')
  assert.equal(ok.latestRelease, 'v1.2.3')
  const offline = await inspectPublishedVersions('org/repo', { fetchImpl: async () => { throw new Error('offline') }, now: 0 })
  assert.equal(offline.status, 'offline_unknown')
  assert.match(offline.error, /offline/)
})
