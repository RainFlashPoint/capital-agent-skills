import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url)); const script = join(root, 'scripts/cap-history-audit.mjs')
const hash = s => createHash('sha256').update(s).digest('hex')
function fixture(entries = []) { const repo = mkdtempSync(join(tmpdir(), 'cap-history-audit-')); for (const e of entries) { const dir = join(repo, '.cap/history', e.task); mkdirSync(join(dir), { recursive: true }); const text = e.text ?? `schema: cap-experience/v1\ntitle: reusable ${e.task}\n`; writeFileSync(join(dir, 'experience.md'), text); writeFileSync(join(dir, 'manifest.json'), JSON.stringify(e.manifest ?? { schemaVersion: 1, taskId: e.task, status: 'completed', artifacts: [{ path: 'experience.md', sha256: hash(text), size: Buffer.byteLength(text) }] })); mkdirSync(join(repo, '.cap/history/index'), { recursive: true }); writeFileSync(join(repo, '.cap/history/index', `${e.task}.json`), JSON.stringify(e.index ?? { schemaVersion: 1, taskId: e.task, status: 'completed', experienceIndex: { path: `.cap/history/${e.task}/experience.md` } })) } return repo }
function run(repo, ...args) { return JSON.parse(execFileSync(process.execPath, [script, '--repo', repo, '--json', ...args], { encoding: 'utf8' })) }
test('normal, bad hash, unknown schema and secret are classified without prose', () => { const repo = fixture([{ task: 'ok' }, { task: 'bad', manifest: { artifacts: [{ path: 'experience.md', sha256: 'deadbeef', size: 1 }] } }, { task: 'old', text: 'schema: cap-experience/v0\ntitle: old\n' }, { task: 'secret', text: 'schema: cap-experience/v1\ntoken: sk-123456789012345\n' }]); const out = run(repo); assert.equal(out.scanned, 4); assert.equal(out.counts.pass, 1); assert.ok(out.candidates.find(x => x.task_id === 'bad').issues.includes('hash_mismatch')); assert.equal(JSON.stringify(out).includes('sk-123456789012345'), false); assert.equal(out.candidates.find(x => x.task_id === 'old').status, 'needs-review') })
test('symlink escape and duplicate content are flagged', () => { const repo = fixture([{ task: 'a', text: 'schema: cap-experience/v1\ntitle: same\n' }, { task: 'b', text: 'schema: cap-experience/v1\ntitle: same\n' }, { task: 'c', text: 'schema: cap-experience/v1\ntitle: same\n' }]); const outside = join(tmpdir(), `history-audit-secret-${process.pid}`); writeFileSync(outside, 'schema: cap-experience/v1\ntitle: outside\n'); unlinkSync(join(repo, '.cap/history/a/experience.md')); symlinkSync(outside, join(repo, '.cap/history/a/experience.md'), 'file'); const out = run(repo); assert.ok(out.candidates.find(x => x.task_id === 'a').issues.includes('missing_or_unsafe_experience')); assert.ok(out.candidates.find(x => x.task_id === 'b').issues.includes('duplicate_content')) })
test('limit bounds index enumeration', () => { const repo = fixture([{ task: 'a', text: 'schema: cap-experience/v1\ntitle: same\n' }, { task: 'b', text: 'schema: cap-experience/v1\ntitle: same\n' }, { task: 'c', text: 'schema: cap-experience/v1\ntitle: same\n' }]); const out = run(repo, '--limit', '1'); assert.equal(out.scanned, 1) })

test('wrong manifest identity fails and legacy schema cannot mask bad hash',()=>{
 const repo=fixture([{task:'wrong',manifest:{schemaVersion:1,taskId:'other',status:'completed',artifacts:[]}},{task:'legacy',text:'schema: cap-experience/v0\n',manifest:{schemaVersion:1,taskId:'legacy',status:'completed',artifacts:[{path:'experience.md',sha256:'bad',size:26}]}}])
 const out=run(repo);assert.ok(out.candidates.every(x=>x.status==='fail'))
})
test('sensitive and duplicate candidates need review',()=>{
 const text='schema: cap-experience/v1\ntoken: private-placeholder\n'
 const out=run(fixture([{task:'a',text},{task:'b',text}]))
 assert.equal(out.counts['needs-review'],2);assert.doesNotMatch(JSON.stringify(out),/private-placeholder/)
})
test('invalid task data and unsafe filename are not reflected',()=>{
 const repo=fixture([{task:'valid',index:{schemaVersion:1,taskId:'bad/private-marker',status:'completed'}}])
 writeFileSync(join(repo,'.cap/history/index','bad private-marker.json'),'null')
 const out=run(repo);assert.doesNotMatch(JSON.stringify(out),/private-marker/);assert.equal(out.counts.fail,2)
})
test('duplicate JSON keys are rejected',()=>{
 const repo=fixture([{task:'a'}]);writeFileSync(join(repo,'.cap/history/index/a.json'),'{"taskId":"a","taskId":"b"}')
 assert.equal(run(repo).candidates[0].issues[0],'invalid_json')
})
test('bounded audit explicitly reports truncation',()=>{
 const out=run(fixture([{task:'a'},{task:'b'}]),'--limit','1');assert.equal(out.scanned,1);assert.equal(out.truncated,true)
})
