import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { baselineDigest } from './cap-worktree-baseline.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = join(root, 'skills/cap-flow/scripts/cap-context-guard')
const boundaryGuard = join(root, 'skills/cap-flow/scripts/cap-guard')
const fingerprintScript = join(root, 'scripts/cap-context-fingerprint.mjs')
const sessionRootScript = join(root, 'scripts/cap-session-root.mjs')
const baselineScript = join(root, 'scripts/cap-worktree-baseline.mjs')
const portableEnv = () => {
  const env = { ...process.env }
  for (const key of ['CAPITAL_AGENT_RUNTIME_SESSION_ID', 'CAPITAL_AGENT_SESSION_LOCK_DIR', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[key]
  return env
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'cap-context-fixture-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo })
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(join(repo, '.cap'), { recursive: true })
  writeFileSync(join(repo, 'src/payment-controller.js'), 'export const pay = service => service.pay()\n')
  writeFileSync(join(repo, 'src/payment-service.js'), 'export const paymentService = { pay: () => "ok" }\n')
  writeFileSync(join(repo, 'test/payment.test.js'), '/* payment test fixture */\n')
  writeFileSync(join(repo, '.cap/PROFILE.md'), '# Profile\n项目画像存在，但不能替代任务调查。\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo })
  return repo
}

function run(repo, ...args) {
  return spawnSync('bash', [guard, ...args, repo], { cwd: repo, encoding: 'utf8', env: portableEnv() })
}

function fingerprints(repo) {
  return JSON.parse(execFileSync(process.execPath, [fingerprintScript, repo, '--json'], { cwd: repo, encoding: 'utf8' }))
}

function writeContext(repo, { includeTests = true } = {}) {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const snapshot = fingerprints(repo)
  writeFileSync(join(repo, '.cap/task-context.md'), `# Task Context

- intent: 接入新的支付渠道
- branch: ${branch}
- head: ${head}
- index-fingerprint: ${snapshot.index}
- worktree-fingerprint: ${snapshot.worktree}
- untracked-fingerprint: ${snapshot.untracked}
- inspected-at: 2026-07-21T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`src/payment-controller.js\` — 支付入口

## Call chain and data flow
- \`src/payment-controller.js\` → \`src/payment-service.js\` — 调用支付服务

## Similar implementations
- \`src/payment-service.js\` — 现有支付模式

## History usage
- candidates: none
- outcome: not_used
- reason: 没有匹配的历史经验候选
- plan-impact: none
- verification-impact: none

## Tests and environment
${includeTests ? '- `test/payment.test.js` — 支付测试入口' : '- 尚未定位测试'}

## Evidence sources
- \`test/payment.test.js\` — 测试资产引用，不记录敏感正文

## Current truth and decisions
- observed-at: 2026-07-21T00:00:00Z
- sources: 当前 Git、测试环境状态和用户授权消息
- user-decisions: 只允许当前测试范围，不触及生产
- external-state: 测试环境可用，尚未执行外部写入
- conflicts: none
- invalidates-on: 环境、授权、分支、HEAD 或执行范围变化

## External operation boundary
- environment: test
- authorization: 已授权当前测试动作
- minimum-impact: 单次测试范围
- recovery: 测试数据清理
- invalidates-on: 环境或执行范围变化

## Impact surface
- modify: \`src/payment-service.js\` — 新渠道实现
- inspect-only: \`src/payment-controller.js\` — 保持入口兼容
- out-of-scope: \`src/settlement/**\` — 不修改结算

## Profile drift
- none
`)
}

function writeWorkingTreeContext(repo) {
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const snapshot = fingerprints(repo)
  writeFileSync(join(repo, '.cap/task-context.md'), `# Task Context

- intent: 初始化新项目
- branch: ${branch}
- head: working-tree
- index-fingerprint: ${snapshot.index}
- worktree-fingerprint: ${snapshot.worktree}
- untracked-fingerprint: ${snapshot.untracked}
- inspected-at: 2026-08-13T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`src/payment-controller.js\` — 初始入口

## Call chain and data flow
- \`src/payment-controller.js\` → \`src/payment-service.js\` — 初始调用关系

## Similar implementations
- \`src/payment-service.js\` — 当前工作区模式

## History usage
- candidates: none
- outcome: not_used
- reason: 没有匹配的历史经验候选
- plan-impact: none
- verification-impact: none

## Tests and environment
- \`test/payment.test.js\` — 初始测试入口

## Evidence sources
- \`test/payment.test.js\` — 工作区测试资产

## External operation boundary
- environment: local
- authorization: not-needed
- minimum-impact: 当前工作区
- recovery: 删除未提交文件
- invalidates-on: 产生首个 Commit

## Impact surface
- modify: \`src/payment-service.js\` — 初始实现
- inspect-only: \`src/payment-controller.js\` — 初始入口
- out-of-scope: \`src/settlement/**\` — 不修改结算

## Profile drift
- none
`)
}

test('PROFILE alone cannot unlock planning', () => {
  const repo = fixture()
  const result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /缺少 \.cap\/task-context\.md/)
})

test('both entries report every reconnaissance defect in one pass', () => {
  const repo = fixture(); writeContext(repo)
  const path = join(repo, '.cap/task-context.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^- (index-fingerprint|worktree-fingerprint|untracked-fingerprint):.*\n/gm, '').replace('- `test/payment.test.js` — 支付测试入口', '- no test path'))
  for (const result of [run(repo), spawnSync(process.execPath, [join(root, 'scripts/cap-runtime.mjs'), 'context', repo], { env: portableEnv(), encoding: 'utf8' })]) {
    assert.equal(result.status, 1)
    for (const missing of ['index', 'worktree', 'untracked', 'Tests and environment']) assert.ok(result.stderr.includes(missing), result.stderr)
  }
})

test('malformed modify paths fail closed even alongside valid inspect-only paths', () => {
  const repo = fixture(); writeContext(repo)
  const path = join(repo, '.cap/task-context.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace('- modify: `src/payment-service.js`', '- modify: payment-service.js、README'))
  const result = run(repo)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /modify_pattern_invalid/)
})

test('implementation cannot infer a safe empty modify surface from inspect-only entries', () => {
  const repo = fixture(); writeContext(repo)
  const path = join(repo, '.cap/task-context.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace('- modify: `src/payment-service.js` — 新渠道实现\n', ''))
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /task_context_modify_pattern_missing/)
})

test('fresh repository evidence unlocks implementation', () => {
  const repo = fixture(); writeContext(repo)
  const result = run(repo, '--intent', '接入新的支付渠道', '--stage', 'implement')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS/)
})

test('repository without a first commit uses working-tree as its stable context head', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cap-context-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(repo, 'test'), { recursive: true }); mkdirSync(join(repo, '.cap'), { recursive: true })
  writeFileSync(join(repo, 'src/payment-controller.js'), 'export const pay = service => service.pay()\n')
  writeFileSync(join(repo, 'src/payment-service.js'), 'export const paymentService = { pay: () => "ok" }\n')
  writeFileSync(join(repo, 'test/payment.test.js'), '/* fixture */\n')
  writeWorkingTreeContext(repo)
  const result = run(repo, '--intent', '初始化新项目', '--stage', 'implement')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS/)
})

test('a new commit makes the reconnaissance stale', () => {
  const repo = fixture(); writeContext(repo)
  appendFileSync(join(repo, 'src/payment-service.js'), '// changed\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'change code'], { cwd: repo })
  const result = run(repo, '--stage', 'test')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /HEAD 已变化/)
})

test('staged changes make the recorded index fingerprint stale', () => {
  const repo = fixture(); writeContext(repo)
  appendFileSync(join(repo, 'src/payment-service.js'), '// staged change\n')
  execFileSync('git', ['add', 'src/payment-service.js'], { cwd: repo })
  const result = run(repo, '--stage', 'test')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /index fingerprint 已变化/)
})

test('unstaged tracked changes make the worktree fingerprint stale', () => {
  const repo = fixture(); writeContext(repo)
  appendFileSync(join(repo, 'src/payment-service.js'), '// worktree change\n')
  const result = run(repo, '--stage', 'test')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /worktree fingerprint 已变化/)
})

test('pre-existing dirty files in the planned modify surface block a new Task', () => {
  const repo = fixture()
  appendFileSync(join(repo, 'src/payment-service.js'), '// previous task change\n')
  mkdirSync(join(repo, '.cap'), { recursive: true })
  execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_new'], { cwd: repo })
  writeFileSync(join(repo, '.cap/STATE.md'), `task-id: task_new\nbranch: ${execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()}\nworktree: ${repo}\n`)
  writeContext(repo)

  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未归属改动重叠/)
  assert.match(result.stderr, /src\/payment-service\.js/)
})

test('globstar modify scope includes files directly under its prefix', () => {
  const repo = fixture()
  appendFileSync(join(repo, 'src/payment-service.js'), '// existing dirty code\n')
  execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_new'], { cwd: repo })
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, '.cap/STATE.md'), `task-id: task_new\nbranch: ${branch}\nworktree: ${repo}\n`)
  writeContext(repo)
  const path = join(repo, '.cap/task-context.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace('`src/payment-service.js` — 新渠道实现', '`src/**/*.js` — 新渠道实现'))
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /preexisting_dirty_overlap/)
})

test('precisely adopted dirty files require matching Task, baseline and cited user authority', () => {
  const repo = fixture()
  appendFileSync(join(repo, 'src/payment-service.js'), '// prior work\n')
  const baseline = JSON.parse(execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_new'], { encoding: 'utf8' }))
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, '.cap/STATE.md'), `task-id: task_new\nbranch: ${branch}\nworktree: ${repo}\n`)
  writeContext(repo)
  const path = join(repo, '.cap/task-context.md')
  const original = readFileSync(path, 'utf8')
  const declaration = `\n## Dirty ownership\n- task-id: task_new\n- baseline-digest: ${baselineDigest(baseline.payload)}\n- authority: user-message:fixture-ownership\n- adopted: \`src/payment-service.js\`\n`
  writeFileSync(path, original + declaration)
  assert.equal(run(repo).status, 0)
  writeFileSync(path, original + declaration.replace('user-message:fixture-ownership', 'model:guessed'))
  assert.match(run(repo).stderr, /task_context_dirty_adoption_invalid/)
  writeFileSync(path, original + declaration.replace(baselineDigest(baseline.payload), 'a'.repeat(64)))
  assert.match(run(repo).stderr, /task_context_dirty_adoption_invalid/)
})

test('pre-existing dirty files outside the planned modify surface remain allowed', () => {
  const repo = fixture()
  appendFileSync(join(repo, 'README.md'), 'previous task note\n')
  execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_new'], { cwd: repo })
  writeFileSync(join(repo, '.cap/STATE.md'), `task-id: task_new\nbranch: ${execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()}\nworktree: ${repo}\n`)
  writeContext(repo)

  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 0, result.stderr)
})

test('retries cannot overwrite the original dirty ownership baseline', () => {
  const repo = fixture()
  appendFileSync(join(repo, 'src/payment-service.js'), '// original dirty change\n')
  const first = JSON.parse(execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_retry'], { cwd: repo, encoding: 'utf8' }))
  appendFileSync(join(repo, 'README.md'), 'later dirty change\n')
  const second = JSON.parse(execFileSync(process.execPath, [baselineScript, 'capture', repo, 'task_retry'], { cwd: repo, encoding: 'utf8' }))
  const saved = JSON.parse(readFileSync(first.path, 'utf8'))

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.deepEqual(saved.dirtyPaths.map(item => item.path), ['src/payment-service.js'])
})

test('untracked source changes make the untracked fingerprint stale', () => {
  const repo = fixture(); writeContext(repo)
  writeFileSync(join(repo, 'src/new-channel.js'), 'export const channel = true\n')
  const result = run(repo, '--stage', 'test')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /untracked fingerprint 已变化/)
})

test('context and boundary guards resolve the canonical Git root from a nested directory', () => {
  const repo = fixture(); writeContext(repo)
  const nested = join(repo, 'src', 'nested'); mkdirSync(nested, { recursive: true })
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, '.cap/STATE.md'), `# Cap State: fixture\nbranch: ${branch}\nworktree: ${repo}\nstage: implement\nstatus: in-progress\n`)
  const contextResult = spawnSync('bash', [guard, '--stage', 'implement', nested], { cwd: nested, encoding: 'utf8', env: portableEnv() })
  assert.equal(contextResult.status, 0, contextResult.stderr)
  const boundaryResult = spawnSync('sh', [boundaryGuard], { cwd: nested, encoding: 'utf8', env: portableEnv() })
  assert.equal(boundaryResult.status, 0, boundaryResult.stderr)
  assert.match(boundaryResult.stdout, /边界一致/)
})

test('context guard rejects a self-consistent sibling worktree after the session locks another root', () => {
  const repoA = fixture()
  const repoB = `${repoA}-sibling`
  const lockRoot = `${repoA}-session-locks`
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/sibling', repoB], { cwd: repoA })
  mkdirSync(join(repoB, '.cap'), { recursive: true })
  writeContext(repoB)
  const branchB = execFileSync('git', ['branch', '--show-current'], { cwd: repoB, encoding: 'utf8' }).trim()
  writeFileSync(join(repoB, '.cap/STATE.md'), `# Cap State: sibling\nbranch: ${branchB}\nworktree: ${repoB}\nstage: implement\nstatus: in-progress\n`)
  const env = { ...process.env, CODEX_THREAD_ID: 'context-guard-a-b', CAPITAL_AGENT_SESSION_LOCK_DIR: lockRoot }
  execFileSync(process.execPath, [sessionRootScript, 'capture', repoA], { cwd: repoA, env })

  const result = spawnSync('bash', [guard, '--stage', 'implement', repoB], { cwd: repoB, encoding: 'utf8', env })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /本会话锁定.*拒绝切换/)
})

test('missing test evidence blocks the workflow', () => {
  const repo = fixture(); writeContext(repo, { includeTests: false })
  const result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /没有测试或配置路径/)
})

test('missing external operation boundary blocks handoff', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = execFileSync('sed', ['/^- recovery:/d', context], { encoding: 'utf8' })
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'test')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /缺少 recovery/)
})

test('external actions require current truth and decisions', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = readFileSync(context, 'utf8').replace(/\n## Current truth and decisions[\s\S]*?\n## External operation boundary/, '\n## External operation boundary')
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Current truth and decisions/)
})

test('production actions cannot bypass current truth with authorization none', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = readFileSync(context, 'utf8')
    .replace(/\n## Current truth and decisions[\s\S]*?\n## External operation boundary/, '\n## External operation boundary')
    .replace('- environment: test', '- environment: production')
    .replace('- authorization: 已授权当前测试动作', '- authorization: none')
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Current truth and decisions/)
})

test('unresolved cross-session decision conflicts block external actions', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = readFileSync(context, 'utf8').replace('- conflicts: none', '- conflicts: unresolved:用户要求保持 CI 关闭，但当前计划准备开启 CI')
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /current_truth_conflict_unresolved/)
})

test('duplicate current truth sections fail closed even when the first section is clean', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  appendFileSync(context, `
## Current truth and decisions
- observed-at: 2026-07-21T00:00:00Z
- sources: later conflicting source
- user-decisions: later decision
- external-state: changed
- conflicts: unresolved:later section must not be ignored
- invalidates-on: any change
`)
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /current_truth_duplicate/)
})

test('duplicate current truth fields fail closed when an older clean value appears first', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = readFileSync(context, 'utf8').replace(
    '- conflicts: none',
    '- conflicts: none\n- conflicts: unresolved:later field must not be ignored',
  )
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'implement')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /current_truth_field_duplicate.*conflicts/)
})

test('history usage must explain candidate adoption and plan/verification impact', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  const content = readFileSync(context, 'utf8').replace(/## History usage[\s\S]*?\n## Tests and environment/, '## Tests and environment')
  writeFileSync(context, content)
  const result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /History usage/)
})

test('history usage rejects whitespace-only values and trims candidates before enum checks', () => {
  const repo = fixture(); writeContext(repo)
  const context = join(repo, '.cap/task-context.md')
  let content = readFileSync(context, 'utf8').replace('- reason: 没有匹配的历史经验候选', '- reason:   ')
  writeFileSync(context, content)
  let result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /History usage 缺少 reason/)

  writeContext(repo)
  content = readFileSync(context, 'utf8')
    .replace('- candidates: none', '- candidates: none   ')
    .replace('- outcome: not_used', '- outcome: direct_adopted')
  writeFileSync(context, content)
  result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /candidates=none/)
})
