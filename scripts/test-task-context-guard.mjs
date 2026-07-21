import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = join(root, 'skills/cap-flow/scripts/cap-context-guard')

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
  return spawnSync('bash', [guard, ...args, repo], { cwd: repo, encoding: 'utf8' })
}

function writeContext(repo, { includeTests = true } = {}) {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, '.cap/task-context.md'), `# Task Context

- intent: 接入新的支付渠道
- branch: ${branch}
- head: ${head}
- inspected-at: 2026-07-21T00:00:00Z
- profile-used-as: index-only

## Entry points
- \`src/payment-controller.js\` — 支付入口

## Call chain and data flow
- \`src/payment-controller.js\` → \`src/payment-service.js\` — 调用支付服务

## Similar implementations
- \`src/payment-service.js\` — 现有支付模式

## Tests and environment
${includeTests ? '- `test/payment.test.js` — 支付测试入口' : '- 尚未定位测试'}

## Impact surface
- modify: \`src/payment-service.js\` — 新渠道实现
- inspect-only: \`src/payment-controller.js\` — 保持入口兼容
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

test('fresh repository evidence unlocks implementation', () => {
  const repo = fixture(); writeContext(repo)
  const result = run(repo, '--intent', '接入新的支付渠道', '--stage', 'implement')
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

test('missing test evidence blocks the workflow', () => {
  const repo = fixture(); writeContext(repo, { includeTests: false })
  const result = run(repo, '--stage', 'plan')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /没有测试或配置路径/)
})
