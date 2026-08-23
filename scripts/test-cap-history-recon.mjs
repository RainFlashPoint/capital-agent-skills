import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts/cap-history-recon.mjs')

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }).trim()
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'cap-history-recon-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'fixture@example.com'])
  git(repo, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-qm', 'initial unrelated project'])
  git(repo, ['switch', '-qc', 'history/huiyuan-1147-contract'])
  writeFileSync(join(repo, 'protocol.md'), '1147 协议生成与签署传递节点\n')
  git(repo, ['add', 'protocol.md'])
  git(repo, ['commit', '-qm', 'feat: 快乐通宝增加1147协议'])
  git(repo, ['switch', '-q', 'main'])
  mkdirSync(join(repo, '.cap/history/index'), { recursive: true })
  mkdirSync(join(repo, '.cap/history/task-secret'), { recursive: true })
  writeFileSync(join(repo, '.cap/history/index/task_1147.json'), JSON.stringify({
    task_id: 'task_1147', title: '快乐通宝 1147 协议', branch: 'history/huiyuan-1147-contract',
    experienceIndex: {
      schema: 'cap-experience-index/v1',
      retrievalCues: ['当再次处理电子协议签署顺序时', '签署传递节点、异步协议回执'],
      decisionRules: ['当回执异步到达时，必须先绑定协议版本再推进签署状态'],
      path: '.cap/history/task_1147/experience.md',
    },
  }))
  writeFileSync(join(repo, '.cap/history/task-secret/STATE.md'), 'NEVER_RECURSIVELY_LOAD_ME 独占绝密召回词\n')
  return repo
}

test('one read-only invocation surfaces the relevant historical branch, commit and cap index', () => {
  const repo = fixture()
  const beforeBranch = git(repo, ['branch', '--show-current'])
  const beforeStatus = git(repo, ['status', '--porcelain=v1'])
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', '继续完成快乐通宝1147协议的签署传递', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  assert.ok(result.matches.some(item => item.source_type === 'branch' && item.branch === 'history/huiyuan-1147-contract'))
  assert.ok(result.matches.some(item => item.source_type === 'commit' && /1147/.test(item.subject)))
  assert.ok(result.matches.some(item => item.source_type === 'cap_index' && /task_1147/.test(item.file)))
  assert.equal(git(repo, ['branch', '--show-current']), beforeBranch)
  assert.equal(git(repo, ['status', '--porcelain=v1']), beforeStatus)
})

test('local experience retrieval cues make an archived task discoverable without scanning its body', () => {
  const repo = fixture()
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', '异步协议回执应该如何处理', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  const match = result.matches.find(item => item.source_type === 'cap_index' && /task_1147/.test(item.file))
  assert.ok(match)
  assert.equal(match.inspect.value, '.cap/history/index/task_1147.json')
})

test('history reconnaissance does not recursively read cap history snapshots', () => {
  const repo = fixture()
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'NEVER_RECURSIVELY_LOAD_ME', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  assert.equal(result.matches.some(item => String(item.file || '').includes('task-secret')), false)
})

test('cap memory symlinks cannot make reconnaissance read files outside the repository', () => {
  const repo = fixture()
  const outside = join(tmpdir(), `cap-history-secret-${process.pid}.txt`)
  writeFileSync(outside, 'SYMLINK_ESCAPE_MARKER\n')
  symlinkSync(outside, join(repo, '.cap/PROFILE.md'))
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'SYMLINK_ESCAPE_MARKER', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_memory'), false)
})
