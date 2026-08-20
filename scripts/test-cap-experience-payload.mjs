import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts/cap-experience-payload.mjs')

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }).trim()
}

function fixture({ complete = true, remote = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'cap-experience-payload-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'fixture@example.com'])
  git(repo, ['config', 'user.name', 'Fixture'])
  if (remote) git(repo, ['remote', 'add', 'origin', 'https://token@example.com/org/payment.git'])
  mkdirSync(join(repo, '.cap/verify'), { recursive: true })
  mkdirSync(join(repo, '.cap/review'), { recursive: true })
  writeFileSync(join(repo, '.cap/STATE.md'), `# Cap State: 纠正支付产品线\n\nstage: done\nstatus: development-complete\ntask-id: task_payment\nsession-id: session_payment\n\n## Decisions log\n- 回调仅作验签后的查询唤醒，最终状态通过查询接口收敛。\n- 新渠道配置默认停用，验证后按反向顺序清理。\n`)
  if (complete) {
    writeFileSync(join(repo, '.cap/spec.md'), `# 支付产品线纠正规格\n\n## Goal\n将错误的快捷收银台实现纠正为行业直接支付，避免调用错误产品接口。\n\n## Contract\n- 编码前核对厂商产品线与交易码矩阵。\n- 处理中状态必须通过官方查询接口收敛。\n\n## Safety\n- 环境与 Host 必须显式配置，未知环境 fail closed。\n- 测试配置默认停用，只允许模拟卡和最小金额。\n\n## Out of scope\n- 生产真实卡和真实资金。\n`)
    writeFileSync(join(repo, '.cap/verify/logic-report.md'), `# Logic Verification Report\n\nstatus: LOCAL_PASS_SERVER_ENV_BLOCKED\nsource-commit: pending\n\n## Evidence\n- RED：旧实现断言失败，符合预期。\n- 模块测试 145 个：144 通过、0 失败、0 错误、1 跳过。\n- SDK HTTP Mock 3/3 通过。\n\n## External journey\n- 唯一一笔 0.02 沙箱支付从 PROCESSING 查询收敛到 SUCCESS。\n\n## Environment exclusions\n- 独立 Provider 缺少历史 Maven 私有依赖，属于 ENV_BLOCKED。\n\n## Gate\n- Server Test Action: action_payment_test\n`)
    writeFileSync(join(repo, '.cap/review/summary.md'), `# Review Summary\n\nstatus: clean\nfindings: 0\n`)
  }
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'finish payment integration'])
  return repo
}

function generate(repo, intent = '纠正支付产品线并完成最小沙箱验收') {
  return JSON.parse(execFileSync(process.execPath, [script, repo, '--commit', 'HEAD', '--intent', intent, '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
}

test('standard cap artifacts deterministically produce a complete record_experience payload', () => {
  const repo = fixture()
  const result = generate(repo)
  assert.equal(result.ready, true)
  assert.equal(result.payload.task_id, 'task_payment')
  assert.equal(result.payload.session_id, 'session_payment')
  assert.equal(result.payload.repo_url, 'https://example.com/org/payment.git')
  assert.match(result.payload.experience.problem, /错误的快捷收银台.*行业直接支付/)
  assert.match(result.payload.experience.solution, /交易码矩阵/)
  assert.ok(result.payload.experience.conditions.some(item => /fail closed/.test(item)))
  assert.ok(result.payload.experience.counterexamples.some(item => /真实资金/.test(item)))
  assert.ok(result.payload.experience.evidence_refs.includes('.cap/verify/logic-report.md'))
  assert.ok(result.payload.experience.evidence_refs.includes('action:action_payment_test'))
  assert.doesNotMatch(result.payload.experience.outcome, /\bfailed\b|失败|错误/i)
  assert.equal(result.payload.verify_verdict.logic.status, 'PASS')
  assert.equal(result.payload.review_verdict.status, 'PASS')
  assert.ok(result.payload.changed_files.includes('.cap/spec.md'))
})

test('missing lesson or verification evidence fails closed instead of emitting a legacy fallback', () => {
  const result = generate(fixture({ complete: false }))
  assert.equal(result.ready, false)
  assert.ok(result.missing.includes('problem'))
  assert.ok(result.missing.includes('verification_evidence'))
  assert.equal('payload' in result, false)
})

test('symlinked cap evidence outside the repository is ignored', () => {
  const repo = fixture({ complete: false })
  const outside = join(tmpdir(), `cap-experience-secret-${process.pid}.md`)
  writeFileSync(outside, '## Goal\nSYMLINK_ESCAPE_MARKER should never become knowledge\n')
  symlinkSync(outside, join(repo, '.cap/spec.md'))
  const result = generate(repo)
  assert.equal(result.ready, false)
  assert.equal(JSON.stringify(result).includes('SYMLINK_ESCAPE_MARKER'), false)
})

test('sensitive values in cap prose are redacted before the payload can leave the repository', () => {
  const repo = fixture()
  const privateIp = ['10', '2', '7', '214'].join('.')
  writeFileSync(join(repo, '.cap/spec.md'), `# 支付纠正\n\n## Goal\n纠正支付产品线并阻止错误接口继续处理业务请求。\n\n## Contract\n- 商户号 1234567890123456 的密钥 secret=do-not-send 只保留本地，测试 account 10004 不得外发。\n\n## Safety\n- 测试服务位于 ${privateIp}，仅允许测试环境。\n\n## Out of scope\n- 生产真实资金。\n`)
  git(repo, ['add', '.cap/spec.md'])
  git(repo, ['commit', '-qm', 'add sensitive fixture'])
  const serialized = JSON.stringify(generate(repo))
  assert.equal(serialized.includes('1234567890123456'), false)
  assert.equal(serialized.includes('10004'), false)
  assert.equal(serialized.includes('do-not-send'), false)
  assert.equal(serialized.includes(privateIp), false)
  assert.match(serialized, /\[REDACTED_/)
})

test('failed verification and cleanup-required review cannot be promoted to PASS by loose text matches', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/verify/logic-report.md'), `# Logic Verification Report\n\nstatus: FAIL\n\n## Evidence\n- 0 passed, 3 failed.\n\n## External journey\n- Journey failed before completion.\n`)
  writeFileSync(join(repo, '.cap/review/summary.md'), `# Review Summary\n\nstatus: cleanup-required\nfindings: 3\n`)
  git(repo, ['add', '.cap/verify/logic-report.md', '.cap/review/summary.md'])
  git(repo, ['commit', '-qm', 'record failed evidence'])
  const result = generate(repo)
  assert.equal(result.ready, false)
  assert.ok(result.missing.includes('verification_evidence'))
  assert.equal('payload' in result, false)
})

test('idempotency identity changes when the experience intent changes', () => {
  const repo = fixture()
  const first = generate(repo, '纠正支付产品线并完成沙箱验收')
  const second = generate(repo, '纠正支付产品线并补齐回调查询收敛')
  assert.equal(first.ready, true)
  assert.equal(second.ready, true)
  assert.notEqual(first.payload.idempotency_key, second.payload.idempotency_key)
})

test('portable local repositories without an origin remote use the canonical Git root identity', () => {
  const repo = fixture({ remote: false })
  const result = generate(repo)
  assert.equal(result.ready, true)
  assert.equal(result.payload.repo_url, realpathSync(repo))
})
