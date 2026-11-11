#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { handoffRepositoryIdentity } from './cap-history-recon.mjs'

const NON_TRANSFERABLE = 'Task / Session / authorization / Gate / Delivery / Outbox / PASS'
const FIELDS = ['schema', 'repository', 'branch', 'baseCommit', 'sourceCommit', 'sourceTree', 'changedFiles', 'intent', 'decisions', 'nextActions', 'verification', 'invalidatesOn', 'verificationStatus', 'nonTransferable']
const DRAFT_FIELDS = ['intent', 'decisions', 'nextActions', 'verification', 'invalidatesOn']
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const SENSITIVE = [/(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{12,}/i, /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
const fail = reason => { throw new Error(reason) }
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex')
const exactKeys = (data, keys) => data && typeof data === 'object' && !Array.isArray(data)
  && Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key))
const plain = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 2000
  && !/[\r\n\0]/.test(value) && !SENSITIVE.some(pattern => pattern.test(value))
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 2000
  && !/[\r\n\0\\]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
const readJson = text => { try { return JSON.parse(text) } catch { fail('invalid_json') } }
const codePaths = (repo, base, source) => execFileSync('git', ['-C', repo, 'diff', '--name-only', '-z', '--no-renames', base, source, '--', '.', ':(exclude).cap'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean).sort()
const refCommit = (repo, ref) => git(repo, 'rev-parse', '--verify', `${ref}^{commit}`)
const ignored = (repo, path) => { try { git(repo, 'check-ignore', '-q', '--', path); return true } catch { return false } }
const changedCodeAfter = (repo, source, ref) => git(repo, 'rev-list', `${source}..${ref}`).split('\n').filter(Boolean).some(commit =>
  git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-m', commit, '--', '.', ':(exclude).cap').length > 0)

function validate(repo, data, ref, branch) {
  if (!exactKeys(data, [...FIELDS, 'summarySha256']) || data.schema !== 'cap-team-handoff/v1') fail('invalid_schema')
  const body = Object.fromEntries(FIELDS.map(key => [key, data[key]]))
  if (!/^[0-9a-f]{64}$/.test(data.summarySha256)) fail('invalid_summary_hash')
  if (digest(body) !== data.summarySha256) fail('summary_hash_mismatch')
  if (data.repository !== handoffRepositoryIdentity(repo)) fail('repository_mismatch')
  if (data.verificationStatus !== 'pending-verification') fail('verification_status_mismatch')
  if (data.nonTransferable !== NON_TRANSFERABLE) fail('non_transferable_contract_missing')
  if (!plain(data.branch) || data.branch !== branch) fail('branch_mismatch')
  for (const field of ['baseCommit', 'sourceCommit', 'sourceTree']) if (!SHA.test(data[field])) fail(`invalid_${field}`)
  if (data.sourceCommit !== refCommit(repo, data.sourceCommit) || data.baseCommit !== refCommit(repo, data.baseCommit)) fail('commit_missing')
  if (git(repo, 'rev-parse', `${data.sourceCommit}^{tree}`) !== data.sourceTree) fail('source_tree_mismatch')
  if (git(repo, 'merge-base', data.baseCommit, data.sourceCommit) !== data.baseCommit) fail('base_not_ancestor')
  let sourceParent = ''
  try { sourceParent = git(repo, 'rev-parse', `${data.sourceCommit}^`) } catch { fail('source_commit_has_no_parent') }
  if (!codePaths(repo, sourceParent, data.sourceCommit).length) fail('source_commit_has_no_code_changes')
  if (git(repo, 'merge-base', data.sourceCommit, ref) !== data.sourceCommit) fail('source_not_ancestor')
  if (!Array.isArray(data.changedFiles) || !data.changedFiles.length || data.changedFiles.some(path => !safePath(path) || path.startsWith('.cap/'))
      || JSON.stringify(data.changedFiles) !== JSON.stringify(codePaths(repo, data.baseCommit, data.sourceCommit))) fail('changed_files_mismatch')
  for (const field of DRAFT_FIELDS) if (!plain(data[field])) fail(`invalid_${field}`)
  if (changedCodeAfter(repo, data.sourceCommit, ref)) fail('code_changed_after_handoff')
  return { valid: true, sourceCommit: data.sourceCommit, sourceTree: data.sourceTree, changedFiles: data.changedFiles.length, verification: 'pending' }
}

async function main(args) {
  const [action, rawRepo, ...rest] = args
  if (!['create', 'verify'].includes(action) || !rawRepo) fail('usage: create <repo> --base <commit> --input <draft.json> | verify <repo> --ref <commit> --branch <name>')
  const repo = resolve(rawRepo)
  const option = name => { const index = rest.indexOf(name); return index < 0 ? '' : rest[index + 1] || '' }
  if (action === 'create') {
    const base = option('--base'), input = option('--input')
    if (!base || !input) fail('missing_base_or_input')
    const draftPath = resolve(repo, input)
    const relativeDraft = relative(repo, draftPath)
    if (!relativeDraft || relativeDraft === '..' || relativeDraft.startsWith(`..${sep}`)) fail('draft_outside_repo')
    if (!(await lstat(draftPath)).isFile()) fail('draft_not_regular_file')
    const actualDraft = relative(await realpath(repo), await realpath(draftPath))
    if (!actualDraft || actualDraft === '..' || actualDraft.startsWith(`..${sep}`)) fail('draft_outside_repo')
    const draft = readJson(await readFile(draftPath, 'utf8'))
    if (!exactKeys(draft, DRAFT_FIELDS) || DRAFT_FIELDS.some(field => !plain(draft[field]))) fail('invalid_draft_or_sensitive_content')
    if (ignored(repo, '.cap/HANDOFF.md')) fail('handoff_ignored_adjust_root_gitignore')
    const sourceCommit = git(repo, 'rev-parse', 'HEAD')
    if (git(repo, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).cap')) fail('uncommitted_code_changes')
    const body = { schema: 'cap-team-handoff/v1', repository: handoffRepositoryIdentity(repo), branch: git(repo, 'branch', '--show-current'),
      baseCommit: refCommit(repo, base), sourceCommit, sourceTree: git(repo, 'rev-parse', 'HEAD^{tree}'),
      changedFiles: codePaths(repo, refCommit(repo, base), sourceCommit), ...draft,
      verificationStatus: 'pending-verification', nonTransferable: NON_TRANSFERABLE }
    if (!body.changedFiles.length) fail('no_code_changes')
    const data = { ...body, summarySha256: digest(body) }
    validate(repo, data, sourceCommit, body.branch)
    await writeFile(resolve(repo, '.cap/HANDOFF.md'), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' })
    return { created: '.cap/HANDOFF.md', ...validate(repo, data, sourceCommit, body.branch) }
  }
  const ref = refCommit(repo, option('--ref')), branch = option('--branch')
  if (!branch) fail('missing_branch')
  let committed
  try { committed = git(repo, 'show', `${ref}:.cap/HANDOFF.md`) } catch { fail('handoff_missing_from_commit') }
  return validate(repo, readJson(committed), ref, branch)
}

main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`cap-team-handoff: ${error?.message || error}\n`)
  process.exitCode = 1
})
