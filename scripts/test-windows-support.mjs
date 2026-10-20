import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectContextFingerprint } from './cap-context-fingerprint.mjs'
import { inspectSessionRoot } from './cap-session-root.mjs'
import { captureTaskBaseline } from './cap-worktree-baseline.mjs'
import { localTestProviderLaunchPolicy, localTestProviderPolicy, localTestProviderSandboxCapability } from './setup-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'scripts', 'cap-runtime.mjs')

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'cap-windows-runtime-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'fixture@example.test'])
  git(repo, ['config', 'user.name', 'Fixture'])
  await writeFile(join(repo, 'app.txt'), 'ok\n')
  git(repo, ['add', 'app.txt'])
  git(repo, ['commit', '-qm', 'fixture'])
  await mkdir(join(repo, '.cap'), { recursive: true })
  return repo
}

function runtimeEnvironment(target) {
  const canonical = resolve(target)
  return {
    ...process.env,
    CAPITAL_AGENT_RUNTIME_SESSION_ID: `windows-support-${canonical.replace(/[^a-zA-Z0-9]/g, '-')}`,
    CAPITAL_AGENT_SESSION_LOCK_DIR: join(canonical, '.cap', 'runtime-session-locks'),
  }
}

async function captureRuntimeRoot(target) {
  await inspectSessionRoot({ repoRoot: target, environment: runtimeEnvironment(target), capture: true })
}

function runRuntime(args, options = {}) {
  const target = resolve(args[1] || root)
  return spawnSync(process.execPath, [runtime, ...args], {
    encoding: 'utf8',
    env: runtimeEnvironment(target),
    ...options,
  })
}

test('local Provider is optional and only enabled when a supported sandbox exists', () => {
  assert.deepEqual(localTestProviderPolicy('win32'), {
    supported: false,
    required: false,
    mode: 'remote-only',
    detail: 'Windows 原生不启用本机 Test Provider；独立验证由 Server/Linux Runner 执行',
  })
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(localTestProviderPolicy(platform, { capability: { available: true } }), {
      supported: true,
      required: false,
      mode: 'local-provider',
      detail: '检测到受支持的 OS 沙箱；本机 Test Provider 可作为可选的 test-only Runner',
    })
    const remote = localTestProviderPolicy(platform, { capability: { available: false } })
    assert.equal(remote.supported, false)
    assert.equal(remote.required, false)
    assert.equal(remote.mode, 'remote-only')
    assert.match(remote.detail, /普通本地开发不受影响/)
    assert.deepEqual(localTestProviderLaunchPolicy(platform, { capability: { available: false } }), {
      allowed: false,
      code: 'sandbox_remote_only',
      detail: remote.detail,
    })
  }
  assert.throws(() => localTestProviderPolicy('freebsd'), /不支持的平台/)
  assert.deepEqual(localTestProviderSandboxCapability('darwin', value => value === '/usr/bin/sandbox-exec'), { available: true, code: '', executable: '/usr/bin/sandbox-exec' })
  assert.deepEqual(localTestProviderSandboxCapability('linux', () => false), { available: false, code: 'sandbox_unavailable', executable: '/usr/bin/bwrap' })
  assert.deepEqual(localTestProviderLaunchPolicy('win32'), {
    allowed: false,
    code: 'windows_remote_only',
    detail: 'Windows 原生不启用本机 Test Provider；独立验证由 Server/Linux Runner 执行',
  })
})

test('remote-only hosts wait for a remote Runner without weakening Provider fail-closed behavior', async () => {
  const cap = await readFile(join(root, 'skills', 'cap', 'SKILL.md'), 'utf8')
  const protocol = await readFile(join(root, 'skills', 'cap-flow', 'references', 'harness-action-protocol.md'), 'utf8')
  const launcher = await readFile(join(root, 'scripts', 'cap-local-test-provider.mjs'), 'utf8')
  for (const document of [cap, protocol]) {
    assert.match(document, /原生 Windows[\s\S]{0,300}(?:Server\/Linux Runner|Server canonical)/)
    assert.match(document, /macOS\/Linux[\s\S]{0,700}(?:受支持的 OS 沙箱|remote-only)/)
  }
  assert.match(launcher, /localTestProviderLaunchPolicy\(process\.platform\)/)
  assert.match(launcher, /launchPolicy\.code/)
  assert.match(launcher, /skipped: true, mode: 'remote-only'/)
  assert.ok(launcher.indexOf('if (!launchPolicy.allowed)') < launcher.indexOf("existsSync(resolve(repo, '.git'))"))
})

test('PowerShell entry is a thin argument-preserving wrapper around setup.mjs', async () => {
  const script = await readFile(join(root, 'scripts', 'setup.ps1'), 'utf8')
  assert.match(script, /\$PSScriptRoot/)
  assert.match(script, /setup\.mjs/)
  assert.match(script, /@args/i)
  assert.match(script, /Get-Command\s+node/)
  assert.match(script, /Get-Command\s+git/)
  assert.doesNotMatch(script, /Set-ExecutionPolicy|Invoke-Expression|iex\b/i)
})

test('setup keeps optional Provider readiness out of the overall installation gate', async () => {
  const setup = await readFile(join(root, 'scripts', 'setup.mjs'), 'utf8')
  assert.match(setup, /providerPolicy\.supported\s*\?\s*await inspectLocalTestProvider/)
  assert.match(setup, /!providerPolicy\.required\s*\|\|/)
  assert.match(setup, /SKIP（\$\{providerPolicy\.detail\}）/)
  assert.match(setup, /WARN（本机 Provider 未就绪；不阻断安装/)
  assert.match(setup, /providerAvailable \? 'test-only' : 'remote-only'/)
  assert.match(setup, /if \(providerPolicy\.supported\) \{[\s\S]*try \{[\s\S]*bootstrapLocalTestProvider/)
  assert.match(setup, /catch \{[\s\S]*核心安装继续，正式 Test Action 将等待远端 Runner/)
  assert.match(setup, /!health\.ok[\s\S]*!mcpTools[\s\S]*!mcpRegistered[\s\S]*!providerReady/)
  assert.match(setup, /Codex Skill:[\s\S]*Claude Skill:[\s\S]*Cursor Skill:/)
  assert.match(setup, /!codexSkill && !claudeSkill && !cursorSkill/)
  assert.match(setup, /rundll32\.exe[\s\S]*url\.dll,FileProtocolHandler/)
  assert.doesNotMatch(setup, /process\.platform === 'win32' \? 'cmd'/)
})

test('Git for Windows post-checkout hook accepts the Python launcher without changing POSIX preference', async () => {
  const hook = await readFile(join(root, 'skills', 'cap-flow', 'references', 'templates', 'hooks', 'post-checkout'), 'utf8')
  assert.match(hook, /command -v python3[\s\S]*python3 "\$ik"/)
  assert.match(hook, /elif command -v py[\s\S]*py -3 "\$ik"/)
})

test('Node runtime enforces branch/worktree boundaries without Bash', async () => {
  const repo = await fixture()
  await captureRuntimeRoot(repo)
  const branch = git(repo, ['branch', '--show-current'])
  await writeFile(join(repo, '.cap', 'STATE.md'), `# Cap State: fixture\n\nstage: implement\nstatus: in-progress\nbranch: ${branch}\nworktree: ${repo}\n`)
  let result = runRuntime(['guard', repo])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /cap-guard: PASS/)
  await writeFile(join(repo, '.cap', 'STATE.md'), `# Cap State: fixture\n\nstage: implement\nstatus: in-progress\nbranch: another-branch\nworktree: ${repo}\n`)
  result = runRuntime(['guard', repo])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /branch_mismatch/)
})

test('Node runtime requires cap-status to establish a stable session root', async () => {
  const repo = await fixture()
  const result = runRuntime(['guard', repo])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /session_root_uninitialized/)
})

test('Node runtime verifies task context fingerprints and detects drift', async () => {
  const repo = await fixture()
  await captureRuntimeRoot(repo)
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const fingerprints = await inspectContextFingerprint(repo)
  const intent = 'windows context fixture'
  const context = `# Task Context

- intent: ${intent}
- branch: ${branch}
- head: ${head}
- index-fingerprint: ${fingerprints.index}
- worktree-fingerprint: ${fingerprints.worktree}
- untracked-fingerprint: ${fingerprints.untracked}
- inspected-at: 2026-08-25T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`app.txt\` — entry
## Call chain and data flow
- \`app.txt\` → \`app.txt\` — flow
## Similar implementations
- \`app.txt\` — similar
## History usage
- candidates: none
- outcome: not_used
- reason: no matching historical candidate
- plan-impact: none
- verification-impact: none
## Tests and environment
- \`app.txt\` — test
## Evidence sources
- \`app.txt\` — evidence
## External operation boundary
- environment: local
- authorization: not-needed
- minimum-impact: fixture
- recovery: discard fixture
- invalidates-on: scope change
## Impact surface
- modify: \`app.txt\` — fixture
## Profile drift
- none
`
  await writeFile(join(repo, '.cap', 'task-context.md'), context.replace(/\n/g, '\r\n'))
  let result = runRuntime(['context', repo, '--stage', 'implement', '--intent', intent])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /cap-context: PASS/)
  await writeFile(join(repo, 'app.txt'), 'changed\n')
  result = runRuntime(['context', repo, '--stage', 'implement', '--intent', intent])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /worktree_fingerprint_changed/)
})

test('Node runtime and POSIX guard share trimmed History usage semantics', async () => {
  const repo = await fixture()
  await captureRuntimeRoot(repo)
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const fingerprints = await inspectContextFingerprint(repo)
  const intent = 'history whitespace fixture'
  await writeFile(join(repo, '.cap', 'task-context.md'), `# Task Context

- intent: ${intent}
- branch: ${branch}
- head: ${head}
- index-fingerprint: ${fingerprints.index}
- worktree-fingerprint: ${fingerprints.worktree}
- untracked-fingerprint: ${fingerprints.untracked}
- inspected-at: 2026-09-19T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`app.txt\` — entry
## Call chain and data flow
- \`app.txt\` → \`app.txt\` — flow
## Similar implementations
- \`app.txt\` — similar
## History usage
- candidates: none${'   '}
- outcome: direct_adopted
- reason: reason
- plan-impact: none
- verification-impact: none
## Tests and environment
- \`app.txt\` — test
## Evidence sources
- \`app.txt\` — evidence
## External operation boundary
- environment: local
- authorization: not-needed
- minimum-impact: fixture
- recovery: discard fixture
- invalidates-on: scope change
## Impact surface
- modify: \`app.txt\` — fixture
## Profile drift
- none
`)
  const result = runRuntime(['context', repo, '--stage', 'plan', '--intent', intent])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /history_usage_without_candidate/)
})

test('Node runtime and POSIX guard both reject prefixed History usage headings', async () => {
  const repo = await fixture()
  await captureRuntimeRoot(repo)
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const fingerprints = await inspectContextFingerprint(repo)
  const intent = 'history heading parity fixture'
  await writeFile(join(repo, '.cap', 'task-context.md'), `# Task Context

- intent: ${intent}
- branch: ${branch}
- head: ${head}
- index-fingerprint: ${fingerprints.index}
- worktree-fingerprint: ${fingerprints.worktree}
- untracked-fingerprint: ${fingerprints.untracked}
- inspected-at: 2026-09-19T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`app.txt\` — entry
## Call chain and data flow
- \`app.txt\` → \`app.txt\` — flow
## Similar implementations
- \`app.txt\` — similar
prefix ## History usage
- candidates: none
- outcome: not_used
- reason: no candidate
- plan-impact: none
- verification-impact: none
## Tests and environment
- \`app.txt\` — test
## Evidence sources
- \`app.txt\` — evidence
## External operation boundary
- environment: local
- authorization: not-needed
- minimum-impact: fixture
- recovery: discard fixture
- invalidates-on: scope change
## Impact surface
- modify: \`app.txt\` — fixture
## Profile drift
- none
`)

  const nodeResult = runRuntime(['context', repo, '--stage', 'plan', '--intent', intent])
  assert.equal(nodeResult.status, 1)
  assert.match(nodeResult.stderr, /required_section_missing/)

  const posixEnvironment = runtimeEnvironment(repo)
  const posixResult = spawnSync('bash', [
    join(root, 'skills', 'cap-flow', 'scripts', 'cap-context-guard'),
    '--stage', 'plan', '--intent', intent, repo,
  ], { encoding: 'utf8', env: posixEnvironment })
  assert.equal(posixResult.status, 1)
  assert.match(posixResult.stderr, /History usage/)
})

test('Node runtime blocks a planned file that was already dirty before the Task', async () => {
  const repo = await fixture()
  await captureRuntimeRoot(repo)
  await writeFile(join(repo, 'app.txt'), 'previous task change\n')
  await captureTaskBaseline(repo, 'task_dirty_overlap')
  const branch = git(repo, ['branch', '--show-current'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const fingerprints = await inspectContextFingerprint(repo)
  await writeFile(join(repo, '.cap', 'STATE.md'), `task-id: task_dirty_overlap\nbranch: ${branch}\nworktree: ${repo}\n`)
  await writeFile(join(repo, '.cap', 'task-context.md'), `# Task Context

- intent: dirty overlap fixture
- branch: ${branch}
- head: ${head}
- index-fingerprint: ${fingerprints.index}
- worktree-fingerprint: ${fingerprints.worktree}
- untracked-fingerprint: ${fingerprints.untracked}
- inspected-at: 2026-09-02T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`app.txt\` — entry
## Call chain and data flow
- \`app.txt\` → \`app.txt\` — flow
## Similar implementations
- \`app.txt\` — similar
## History usage
- candidates: none
- outcome: not_used
- reason: no matching historical candidate
- plan-impact: none
- verification-impact: none
## Tests and environment
- \`app.txt\` — test
## Evidence sources
- \`app.txt\` — evidence
## External operation boundary
- environment: local
- authorization: not-needed
- minimum-impact: fixture
- recovery: discard fixture
- invalidates-on: scope change
## Impact surface
- modify: \`app.txt\` — fixture
## Profile drift
- none
`)

  const result = runRuntime(['context', repo, '--stage', 'implement', '--intent', 'dirty overlap fixture'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /preexisting_dirty_overlap/)
})

test('Node prepare-next covers the normal new-task guard without Python', async () => {
  const repo = await fixture()
  let result = runRuntime(['prepare-next', join(repo, '.cap')])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).reason, 'no_active_task')
  await writeFile(join(repo, '.cap', 'STATE.md'), '# Cap State: done\n\nstage: done\ntask-id: task_fixture\n')
  result = runRuntime(['prepare-next', join(repo, '.cap')])
  assert.equal(result.status, 3)
  assert.equal(JSON.parse(result.stdout).reason, 'retirement_required')
})

test('Node prepare-next blocks an incomplete Retire transaction', async () => {
  const repo = await fixture()
  await mkdir(join(repo, '.cap', 'history', 'task_pending'), { recursive: true })
  await writeFile(join(repo, '.cap', 'history', 'task_pending', 'retirement.json'), JSON.stringify({ phase: 'cleanup' }))
  const result = runRuntime(['prepare-next', join(repo, '.cap')])
  assert.equal(result.status, 3)
  assert.equal(JSON.parse(result.stdout).reason, 'retirement_recovery_required')
})

test('Node prepare-next fails closed on a symlinked retirement root', async () => {
  const repo = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'cap-runtime-outside-'))
  await symlink(outside, join(repo, '.cap', 'history'))
  const result = runRuntime(['prepare-next', join(repo, '.cap')])
  assert.equal(result.status, 3)
  assert.equal(JSON.parse(result.stdout).reason, 'retirement_recovery_required')
})

test('Node prepare-next fails closed on a symlinked retirement child', async () => {
  const repo = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'cap-runtime-child-outside-'))
  await symlink(outside, join(repo, '.cap', 'history'))
  await mkdir(join(repo, '.cap', 'archive'), { recursive: true })
  await symlink(outside, join(repo, '.cap', 'archive', 'task_external'))
  const result = runRuntime(['prepare-next', join(repo, '.cap')])
  assert.equal(result.status, 3)
  assert.equal(JSON.parse(result.stdout).reason, 'retirement_recovery_required')
})
