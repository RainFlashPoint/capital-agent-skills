import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    knowledgeDisposition: 'local-only',
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

test('code anchors discover an archived experience without title or intent keyword overlap', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/history/index/task_anchor.json'), JSON.stringify({
    taskId: 'task_anchor', title: '无关的历史标题', intentSummary: '无关的历史意图', keywords: ['legacy-only'],
    experienceIndex: {
      schema: 'cap-experience-index/v1',
      sourceCommit: git(repo, ['rev-parse', 'HEAD']),
      codePaths: ['src/payment/callback.ts'],
      symbols: ['PaymentStatus_PROCESSING'],
      entryPoints: ['支付回调入口'],
      invariants: ['PaymentStatus_PROCESSING 不能直接写入成功'],
      retrievalCues: ['完全不相关的召回词'], decisionRules: ['完全不相关的规则'],
    },
  }))
  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', '继续处理一个无关需求',
    '--anchor', 'src/payment/callback.ts', '--anchor', 'PaymentStatus_PROCESSING',
    '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  const match = result.matches.find(item => item.source_type === 'cap_index' && /task_anchor/.test(item.file))
  assert.ok(match)
  assert.deepEqual(match.matchedAnchors.sort(), ['PaymentStatus_PROCESSING', 'src/payment/callback.ts'].sort())
  assert.match(match.reason, /代码锚点命中/)
  assert.equal(match.sourceCommitRelation, 'current')
  assert.equal(result.scanned.code_anchors, true)
})

test('git commit paths also participate in code-anchor matching', () => {
  const repo = fixture()
  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', '完全不相关的任务', '--anchor', 'protocol.md', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  const match = result.matches.find(item => item.source_type === 'commit' && /1147协议/.test(item.subject))
  assert.ok(match)
  assert.deepEqual(match.matchedAnchors, ['protocol.md'])
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

test('pending sync and stale harvest debt are visible and prioritized without reading snapshot bodies', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/history/index/task_pending.json'), JSON.stringify({
    taskId: 'task_pending', title: '1147 协议待补报', knowledgeDisposition: 'pending-sync',
    experienceIndex: { retrievalCues: ['1147 协议签署'], decisionRules: ['先补报知识'] },
  }))
  const snapshot = join(repo, '.cap/local-state/stale/task_stale/snapshot_a')
  mkdirSync(snapshot, { recursive: true })
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify({
    oldTaskId: 'task_stale', oldBranch: 'history/huiyuan-1147-contract', knowledgeDisposition: 'needs-harvest',
  }))
  writeFileSync(join(snapshot, 'experience.md'), 'STALE_BODY_MUST_NOT_BE_READ\n')
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', '1147 协议签署', '--limit', '20', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  const pending = result.matches.find(item => item.file === '.cap/history/index/task_pending.json')
  const stale = result.matches.find(item => item.source_type === 'cap_stale')
  const local = result.matches.find(item => item.file === '.cap/history/index/task_1147.json')
  assert.equal(pending.knowledgeDisposition, 'pending-sync')
  assert.equal(stale.knowledgeDisposition, 'needs-harvest')
  assert.equal(local.knowledgeDisposition, 'local-only')
  assert.ok(result.matches.indexOf(pending) < result.matches.indexOf(stale))
  assert.ok(result.matches.indexOf(stale) < result.matches.indexOf(local))
  assert.equal(result.matches.some(item => JSON.stringify(item).includes('STALE_BODY_MUST_NOT_BE_READ')), false)
})

test('unresolved knowledge debt remains visible when the next task has no keyword overlap', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/history/index/task_pending_unrelated.json'), JSON.stringify({
    taskId: 'task_pending_unrelated', title: '旧支付批次', knowledgeDisposition: 'pending-sync',
    experienceIndex: { retrievalCues: ['完全不同的支付批次'], decisionRules: ['恢复后补报'] },
  }))
  const snapshot = join(repo, '.cap/local-state/stale/task_stale_unrelated/snapshot_a')
  mkdirSync(snapshot, { recursive: true })
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify({
    oldTaskId: 'task_stale_unrelated', oldBranch: 'legacy/payment-batch', knowledgeDisposition: 'needs-harvest',
  }))

  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', '新增移动端主题切换动画', '--limit', '20', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  assert.ok(result.matches.some(item => item.file === '.cap/history/index/task_pending_unrelated.json'))
  assert.ok(result.matches.some(item => item.source_type === 'cap_stale' && item.taskId === 'task_stale_unrelated'))
})

test('stale reconnaissance rejects symlinked and oversized manifests', () => {
  const repo = fixture()
  const taskRoot = join(repo, '.cap/local-state/stale/task_unsafe')
  mkdirSync(join(taskRoot, 'oversized'), { recursive: true })
  writeFileSync(join(taskRoot, 'oversized/manifest.json'), JSON.stringify({ oldTaskId: 'OVERSIZED_STALE_MARKER', padding: 'x'.repeat(300 * 1024) }))
  const outside = join(tmpdir(), `cap-stale-manifest-${process.pid}.json`)
  writeFileSync(outside, JSON.stringify({ oldTaskId: 'SYMLINK_STALE_MARKER' }))
  mkdirSync(join(taskRoot, 'linked'), { recursive: true })
  symlinkSync(outside, join(taskRoot, 'linked/manifest.json'))
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'OVERSIZED_STALE_MARKER SYMLINK_STALE_MARKER', '--limit', '20', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_stale' && item.taskId === 'OVERSIZED_STALE_MARKER'), false)
  assert.equal(result.matches.some(item => item.source_type === 'cap_stale' && item.taskId === 'SYMLINK_STALE_MARKER'), false)
})

test('stale reconnaissance ignores a plain-file root without crashing', () => {
  const repo = fixture()
  mkdirSync(join(repo, '.cap/local-state'), { recursive: true })
  writeFileSync(join(repo, '.cap/local-state/stale'), 'STALE_ROOT_PLAIN_FILE_MARKER\n')
  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', 'STALE_ROOT_PLAIN_FILE_MARKER', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_stale'), false)
})

test('stale task enumeration is bounded before reading snapshot manifests', () => {
  const repo = fixture()
  const staleRoot = join(repo, '.cap/local-state/stale')
  mkdirSync(staleRoot, { recursive: true })
  for (let index = 0; index < 1000; index += 1) mkdirSync(join(staleRoot, `a-${String(index).padStart(4, '0')}`))
  const boundedTask = join(staleRoot, 'a-0000')
  for (let index = 0; index < 1000; index += 1) mkdirSync(join(boundedTask, `a-${String(index).padStart(4, '0')}`))
  const nestedOverflow = join(boundedTask, 'zzzz-overflow-snapshot')
  mkdirSync(nestedOverflow)
  writeFileSync(join(nestedOverflow, 'manifest.json'), JSON.stringify({
    oldTaskId: 'STALE_SNAPSHOT_OVERFLOW_MARKER', knowledgeDisposition: 'needs-harvest',
  }))
  const overflow = join(staleRoot, 'zzzz-overflow-task/snapshot')
  mkdirSync(overflow, { recursive: true })
  writeFileSync(join(overflow, 'manifest.json'), JSON.stringify({
    oldTaskId: 'STALE_ENUMERATION_OVERFLOW_MARKER', knowledgeDisposition: 'needs-harvest',
  }))

  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', 'STALE_ENUMERATION_OVERFLOW_MARKER STALE_SNAPSHOT_OVERFLOW_MARKER', '--limit', '20', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_stale'), false)
})

test('malformed index field shapes are treated as untrusted metadata instead of crashing reconnaissance', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/history/index/malformed.json'), JSON.stringify({
    title: { injected: true }, keywords: 'not-an-array', knowledgeDisposition: { forged: 'synced' },
    experienceIndex: { retrievalCues: 'not-an-array', decisionRules: [null, { bad: true }] },
  }))
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'malformed', '--limit', '20', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  const match = result.matches.find(item => item.file === '.cap/history/index/malformed.json')
  assert.equal(match.knowledgeDisposition, 'legacy-unknown')
})

test('history index symlinks cannot make reconnaissance read outside the repository', () => {
  const repo = fixture()
  const outside = join(tmpdir(), `cap-history-index-${process.pid}`)
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'outside.json'), JSON.stringify({ title: 'INDEX_SYMLINK_ESCAPE_MARKER', experienceIndex: { retrievalCues: ['INDEX_SYMLINK_ESCAPE_MARKER'] } }))
  const indexRoot = join(repo, '.cap/history/index')
  rmSync(indexRoot, { recursive: true, force: true })
  symlinkSync(outside, indexRoot)
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'INDEX_SYMLINK_ESCAPE_MARKER', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_index' && String(item.file).includes('outside.json')), false)
})

test('history index enumeration is bounded and reports truncation', () => {
  const repo = fixture()
  const indexRoot = join(repo, '.cap/history/index')
  for (let index = 0; index < 1005; index += 1) {
    writeFileSync(join(indexRoot, `bulk-${String(index).padStart(4, '0')}.json`), JSON.stringify({
      taskId: `bulk-${index}`, title: `bulk marker ${index}`, knowledgeDisposition: 'local-only',
    }))
  }
  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', 'bulk marker', '--limit', '20', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  assert.ok(result.scanned.cap_history_index_entries <= 1000)
  assert.equal(result.scanned.cap_history_index_truncated, true)
})

test('SHA-256 commit-shaped source identifiers are not rejected as invalid', () => {
  const repo = fixture()
  writeFileSync(join(repo, '.cap/history/index/task_sha256.json'), JSON.stringify({
    taskId: 'task_sha256', title: 'SHA256 source marker',
    experienceIndex: { sourceCommit: 'a'.repeat(64), retrievalCues: ['SHA256_SOURCE_MARKER'] },
  }))
  const result = JSON.parse(execFileSync(process.execPath, [script, repo, '--intent', 'SHA256_SOURCE_MARKER', '--json'], {
    encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' },
  }))
  const match = result.matches.find(item => item.file === '.cap/history/index/task_sha256.json')
  assert.ok(match)
  assert.equal(match.sourceCommitRelation, 'unknown')
})

test('real SHA-256 repositories retain commit path anchors during reconnaissance', t => {
  const repo = mkdtempSync(join(tmpdir(), 'cap-history-sha256-'))
  try {
    git(repo, ['init', '--object-format=sha256', '-q', '-b', 'main'])
  } catch {
    t.skip('installed Git does not support SHA-256 repositories')
    return
  }
  git(repo, ['config', 'user.email', 'fixture@example.com'])
  git(repo, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(repo, 'sha256-anchor.txt'), 'anchor\n')
  git(repo, ['add', 'sha256-anchor.txt'])
  git(repo, ['commit', '-qm', 'feat: SHA-256 anchor history'])

  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', 'unrelated intent', '--anchor', 'sha256-anchor.txt', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  const match = result.matches.find(item => item.source_type === 'commit' && /SHA-256 anchor/.test(item.subject))
  assert.ok(match)
  assert.equal(match.commit.length, 64)
  assert.deepEqual(match.matchedAnchors, ['sha256-anchor.txt'])
})

test('archive root symlinks and plain files are ignored without escaping or crashing', () => {
  for (const kind of ['symlink', 'file']) {
    const repo = fixture()
    const archiveRoot = join(repo, '.cap/archive')
    if (kind === 'symlink') {
      const outside = mkdtempSync(join(tmpdir(), 'cap-archive-outside-'))
      mkdirSync(outside, { recursive: true })
      mkdirSync(join(outside, 'ARCHIVE_ESCAPE_MARKER'))
      symlinkSync(outside, archiveRoot)
    } else {
      writeFileSync(archiveRoot, 'ARCHIVE_PLAIN_FILE_MARKER\n')
    }
    const result = JSON.parse(execFileSync(process.execPath, [
      script, repo, '--intent', kind === 'symlink' ? 'ARCHIVE_ESCAPE_MARKER' : 'ARCHIVE_PLAIN_FILE_MARKER', '--json',
    ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
    assert.equal(result.matches.some(item => item.source_type === 'cap_archive'), false)
  }
})

test('archive enumeration is bounded before candidate scoring', () => {
  const repo = fixture()
  const archiveRoot = join(repo, '.cap/archive')
  mkdirSync(archiveRoot, { recursive: true })
  for (let index = 0; index < 1000; index += 1) mkdirSync(join(archiveRoot, `a-${String(index).padStart(4, '0')}`))
  mkdirSync(join(archiveRoot, 'zzzz-ARCHIVE_OVERFLOW_MARKER'))

  const result = JSON.parse(execFileSync(process.execPath, [
    script, repo, '--intent', 'ARCHIVE_OVERFLOW_MARKER', '--limit', '20', '--json',
  ], { encoding: 'utf8', env: { ...process.env, CAPITAL_AGENT_MODE: 'local' } }))
  assert.equal(result.matches.some(item => item.source_type === 'cap_archive'), false)
})
