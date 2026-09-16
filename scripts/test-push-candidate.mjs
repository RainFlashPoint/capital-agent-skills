import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCandidateDelivery, buildPushAuthorizationFingerprint } from './client-delivery.mjs'
import { parseArguments, runPushCandidateDelivery } from './cap-push-candidate.mjs'

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'cap-push-candidate-'))
  const remote = await mkdtemp(join(tmpdir(), 'cap-push-candidate-remote-'))
  git(remote, ['init', '--bare'])
  git(repo, ['init', '-b', 'feature/test'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  await mkdir(join(repo, '.cap'))
  await writeFile(join(repo, '.cap/PROFILE.md'), 'harness-mode: server\n')
  await writeFile(join(repo, '.cap/STATE.md'), 'task-id: task_candidate\nsession-id: session_candidate\n')
  await writeFile(join(repo, 'source.txt'), 'candidate\n')
  git(repo, ['add', 'source.txt'])
  git(repo, ['commit', '-m', 'candidate'])
  git(repo, ['remote', 'add', 'origin', remote])
  return { repo, remote, head: git(repo, ['rev-parse', 'HEAD']), branch: 'feature/test', taskId: 'task_candidate' }
}

function authorizationFor({ remote, taskId, branch, head }) {
  return buildPushAuthorizationFingerprint({ repoUrl: remote, pushUrl: remote, taskId, branch, commitSha: head })
}

const verificationFor = source => ({ passed: true, status: 'PASS', outcome: 'PASS', sourceCommit: source.head, executedAt: '2026-09-14T00:00:00.000Z' })

test('controlled candidate delivery pushes, reads the exact remote ref, records live candidate, refreshes CI and reads canonical Task', async () => {
  const source = await fixture()
  const requests = []
  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })
      if (String(url).endsWith('/commit-reconcile')) return response(200, { code: 0, data: { taskId: source.taskId } })
      if (String(url).endsWith('/ci/refresh')) return response(202, { code: 0, data: { status: 'queued' } })
      return response(200, { code: 0, data: { id: source.taskId, currentCommit: source.head, candidateExplicit: true } })
    },
  })

  assert.equal(result.ok, true)
  assert.equal(git(source.remote, ['rev-parse', `refs/heads/${source.branch}`]), source.head)
  assert.deepEqual(requests.map(item => `${item.method} ${new URL(item.url).pathname}`), [
    `POST /api/tasks/${source.taskId}/commit-reconcile`,
    `POST /api/tasks/${source.taskId}/ci/refresh`,
    `GET /api/tasks/${source.taskId}`,
  ])
  const fingerprint = authorizationFor(source)
  assert.equal(requests[0].body.delivery_candidate, true)
  assert.equal(requests[0].body.commit_sha, source.head)
  assert.equal(requests[0].body.branch, source.branch)
  assert.equal(requests[0].body.idempotency_key, `delivery-candidate:${source.taskId}:${source.head}:${fingerprint}`)
  assert.equal(requests[0].body.verification.authorizationFingerprint, fingerprint)
  assert.equal(requests[0].body.verification.remoteReadbackSha, source.head)
})

test('candidate remote proof reads the live ref instead of trusting a forged local tracking ref', async () => {
  const source = await fixture()
  git(source.repo, ['push', '-u', 'origin', source.branch])
  const remoteHead = source.head
  await writeFile(join(source.repo, 'source.txt'), 'new local head\n')
  git(source.repo, ['add', 'source.txt'])
  git(source.repo, ['commit', '-m', 'not pushed'])
  const localHead = git(source.repo, ['rev-parse', 'HEAD'])
  git(source.repo, ['update-ref', `refs/remotes/origin/${source.branch}`, localHead])
  const authorizedFingerprint = buildPushAuthorizationFingerprint({ repoUrl: source.remote, pushUrl: source.remote, taskId: source.taskId, branch: source.branch, commitSha: localHead })

  const candidate = await buildCandidateDelivery(source.repo, {
    authorizedFingerprint,
    verification: { ...verificationFor(source), sourceCommit: localHead },
  })

  assert.equal(candidate.ok, false)
  assert.equal(candidate.reason, 'source_commit_not_remote')
  assert.equal(candidate.remoteCommitSha, remoteHead)
})

test('candidate HTTP rejection is fail-closed and never enters Outbox', async () => {
  const source = await fixture()
  const requests = []
  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET' })
      return response(409, { code: 409, msg: 'candidate blocked' })
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'candidate_delivery')
  assert.equal(result.reason, 'candidate_request_failed')
  assert.equal(requests.length, 1)
  await assert.rejects(readFile(join(source.repo, '.cap/outbox.jsonl'), 'utf8'), /ENOENT/)
})

test('missing platform configuration and local-only repositories stop before Push', async () => {
  const missingConfig = await fixture()
  const missing = await runPushCandidateDelivery(missingConfig.repo, {
    taskId: missingConfig.taskId,
    branch: missingConfig.branch,
    commitSha: missingConfig.head,
    authorizedFingerprint: authorizationFor(missingConfig),
    verification: verificationFor(missingConfig),
  })
  assert.equal(missing.reason, 'platform_config_missing')
  assert.throws(() => git(missingConfig.remote, ['rev-parse', `refs/heads/${missingConfig.branch}`]))

  const localOnly = await fixture()
  await writeFile(join(localOnly.repo, '.cap/PROFILE.md'), 'harness-mode: local-only\n')
  const requests = []
  const blocked = await runPushCandidateDelivery(localOnly.repo, {
    taskId: localOnly.taskId,
    branch: localOnly.branch,
    commitSha: localOnly.head,
    authorizedFingerprint: authorizationFor(localOnly),
    verification: verificationFor(localOnly),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async url => { requests.push(String(url)); return response(200, { code: 0 }) },
  })
  assert.equal(blocked.reason, 'repository_harness_local_only')
  assert.deepEqual(requests, [])
  assert.throws(() => git(localOnly.remote, ['rev-parse', `refs/heads/${localOnly.branch}`]))
})

test('local-only policy takes precedence over missing platform credentials', async () => {
  const source = await fixture()
  await writeFile(join(source.repo, '.cap/PROFILE.md'), 'harness-mode: local-only\n')

  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
  })

  assert.equal(result.stage, 'preflight')
  assert.equal(result.reason, 'repository_harness_local_only')
  assert.throws(() => git(source.remote, ['rev-parse', `refs/heads/${source.branch}`]))
})

test('a rejected Git push performs no platform request and creates no candidate Outbox event', async () => {
  const source = await fixture()
  const hook = join(source.remote, 'hooks', 'pre-receive')
  await writeFile(hook, '#!/bin/sh\nexit 1\n')
  await chmod(hook, 0o755)
  const requests = []
  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async url => { requests.push(String(url)); return response(200, { code: 0 }) },
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'push')
  assert.equal(result.reason, 'git_push_failed')
  assert.deepEqual(requests, [])
  await assert.rejects(readFile(join(source.repo, '.cap/outbox.jsonl'), 'utf8'), /ENOENT/)
})

test('accepted candidate plus failed CI refresh returns a retryable partial result and still reads canonical Task', async () => {
  const source = await fixture()
  const requests = []
  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async (url, options = {}) => {
      requests.push(`${options.method || 'GET'} ${new URL(String(url)).pathname}`)
      if (String(url).endsWith('/commit-reconcile')) return response(200, { code: 0, data: { taskId: source.taskId } })
      if (String(url).endsWith('/ci/refresh')) return response(503, { code: 503, msg: 'worker unavailable' })
      return response(200, { code: 0, data: { id: source.taskId, currentCommit: source.head, candidateExplicit: true } })
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.stage, 'ci_refresh')
  assert.equal(result.candidateAccepted, true)
  assert.equal(result.reason, 'ci_refresh_failed')
  assert.deepEqual(requests, [
    `POST /api/tasks/${source.taskId}/commit-reconcile`,
    `POST /api/tasks/${source.taskId}/ci/refresh`,
    `GET /api/tasks/${source.taskId}`,
  ])
})

test('CLI rejects option-shaped remote names before Git or network work', () => {
  assert.throws(() => parseArguments(['--repo', '.', '--remote', '--force', '--task', 'task_1']), /push_candidate_remote_invalid/)
})

test('a distinct Git pushurl is bound to authorization before any remote write', async () => {
  const source = await fixture()
  const pushRemote = await mkdtemp(join(tmpdir(), 'cap-push-candidate-pushurl-'))
  git(pushRemote, ['init', '--bare'])
  git(source.repo, ['remote', 'set-url', '--add', '--push', 'origin', pushRemote])

  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
  })

  assert.equal(result.stage, 'preflight')
  assert.equal(result.reason, 'push_authorization_required')
  assert.throws(() => git(pushRemote, ['rev-parse', `refs/heads/${source.branch}`]))

  const authorized = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: buildPushAuthorizationFingerprint({ repoUrl: source.remote, pushUrl: pushRemote, taskId: source.taskId, branch: source.branch, commitSha: source.head }),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async url => {
      if (String(url).endsWith('/commit-reconcile')) return response(200, { code: 0, data: {} })
      if (String(url).endsWith('/ci/refresh')) return response(202, { code: 0, data: {} })
      return response(200, { code: 0, data: { id: source.taskId, currentCommit: source.head, candidateExplicit: true } })
    },
  })
  assert.equal(authorized.ok, true)
  assert.equal(git(pushRemote, ['rev-parse', `refs/heads/${source.branch}`]), source.head)
  assert.throws(() => git(source.remote, ['rev-parse', `refs/heads/${source.branch}`]))
})

test('verification evidence must bind the exact candidate Commit and reject unknown fields before Push', async () => {
  for (const verification of [
    { ...verificationFor({ head: 'a'.repeat(40) }) },
    { ...verificationFor(sourcePlaceholder()), debugToken: 'must-not-leave-client' },
  ]) {
    const source = await fixture()
    if (verification.sourceCommit === sourcePlaceholder().head) verification.sourceCommit = source.head
    const result = await runPushCandidateDelivery(source.repo, {
      taskId: source.taskId,
      branch: source.branch,
      commitSha: source.head,
      authorizedFingerprint: authorizationFor(source),
      verification,
      serverUrl: 'https://capital.example.test',
      userKey: 'user-key',
    })
    assert.equal(result.stage, 'preflight')
    assert.match(result.reason, /^verification_(commit_mismatch|fields_invalid)$/)
    assert.throws(() => git(source.remote, ['rev-parse', `refs/heads/${source.branch}`]))
  }
})

test('canonical readback must confirm this Task and candidate Commit', async () => {
  const source = await fixture()
  const result = await runPushCandidateDelivery(source.repo, {
    taskId: source.taskId,
    branch: source.branch,
    commitSha: source.head,
    authorizedFingerprint: authorizationFor(source),
    verification: verificationFor(source),
    serverUrl: 'https://capital.example.test',
    userKey: 'user-key',
    fetchImpl: async url => {
      if (String(url).endsWith('/commit-reconcile')) return response(200, { code: 0, data: {} })
      if (String(url).endsWith('/ci/refresh')) return response(202, { code: 0, data: {} })
      return response(200, { code: 0, data: { id: source.taskId, currentCommit: 'b'.repeat(40), candidateExplicit: true } })
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.stage, 'canonical_readback')
  assert.equal(result.reason, 'canonical_candidate_mismatch')
})

test('real CLI rejects local-only before reading verification or platform configuration', async () => {
  const source = await fixture()
  await writeFile(join(source.repo, '.cap/PROFILE.md'), 'harness-mode: local-only\n')
  const result = spawnSync(process.execPath, [
    join(import.meta.dirname, 'cap-push-candidate.mjs'), '--repo', source.repo,
    '--task', source.taskId, '--branch', source.branch, '--commit', source.head,
    '--authorization-fingerprint', authorizationFor(source),
    '--verification-json', join(source.repo, 'missing-verification.json'), '--json',
  ], { encoding: 'utf8', env: { ...process.env, HOME: join(source.repo, 'missing-home') } })

  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).reason, 'repository_harness_local_only')
})

function sourcePlaceholder() {
  return { head: 'c'.repeat(40) }
}
