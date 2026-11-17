import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// AUDIT_SCRIPT lets the same cases measure the exact parent implementation.
const audit=resolve(process.env.AUDIT_SCRIPT||fileURLToPath(new URL('../runtime/execution/contract-audit.mjs',import.meta.url)))
const git=(r,...args)=>execFileSync('git',args,{cwd:r,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
function file(r,p,text){mkdirSync(join(r,p,'..'),{recursive:true});writeFileSync(join(r,p),text)}
function fixture(){const r=mkdtempSync(join(tmpdir(),'audit-calibration-'));roots.push(r);git(r,'init','-q');git(r,'config','user.email','fixture@example.invalid');git(r,'config','user.name','Fixture');file(r,'.gitignore','.cap/\n');file(r,'README.md','baseline');git(r,'add','.');git(r,'commit','-qm','baseline');return r}
function scan(r,mode='diff'){const p=spawnSync(process.execPath,[audit,'--repo',r,'--mode',mode],{encoding:'utf8'});assert.equal(p.error,undefined);return {exitCode:p.status,...JSON.parse(p.stdout)}}
const roots=[],matrix=[]
after(()=>{if(process.env.AUDIT_MATRIX)writeFileSync(process.env.AUDIT_MATRIX,JSON.stringify(matrix,null,2)+'\n');for(const root of roots)rmSync(root,{recursive:true,force:true})})
export const cases=[]
for(const path of ['backend/app/validator.py','workers/runner/lib/validator.mjs','server/check.js','services/check.ts','bin/check.cjs','check.jsx']) cases.push({id:`wiring ${path}`,files:{'docs/contracts/a.schema.json':'{}',[path]:path.endsWith('.py')?'schema = "a.schema.json"':'const schema = "a.schema.json"'},ok:true,failures:[]})
for(const receiver of ['user','cfg','ctx'])cases.push({id:`JS ${receiver} explicit`,files:{'backend/gate.mjs':`if (${receiver}.enforce === true) { deny() }`},ok:false,failures:['safety_opt_in']})
for(const condition of ['input.enforce == True','input.enforce is True','input.enforce == true','cfg.enforce','input.enforce'])cases.push({id:`Python ${condition}`,files:{'backend/gate.py':`if ${condition}:\n    deny()\n`},ok:false,failures:['safety_opt_in']})
for(const [id,path,text] of [
 ['non-safety truthy','backend/theme.js','if (input.enforce) render()'],
 ['aggregate path is business','backend/aggregate.js','if (cfg.enforce) render()'],
 ['navigate path is business','backend/navigate.js','if (cfg.enforce) render()'],
 ['unrelated adjacent identifier','backend/theme.js','if (cfg.enforce) render()\nconst aggregate = 1'],
 ['unrelated function declaration','backend/theme.js','if (input.enforce) render()\nfunction deny() {}'],
 ['unrelated following call','backend/theme.js','if (input.enforce) render()\ndeny()'],
 ['unrelated same-line call','backend/theme.js','if (input.enforce) render(); deny()'],
 ['regex sample is data','backend/gate.js','const pattern = /if (cfg.enforce) deny()/;'],
 ['normal config read','backend/gate.py','enabled = cfg.enforce\n'],
 ['legacy business field','backend/gate.py','if user.legacy:\n    archive_order()'],
 ['comment and string','backend/gate.js','// if (ctx.enforce === true) deny()\nconst sample="if (user.enforce === true) deny()"'],
 ['Python multiline string','backend/gate.py','text = """\nif cfg.enforce:\n    deny()\n"""'],
 ['ordinary feature','backend/gate.js','if (cfg.darkMode === true) render()'],
 ['business legacy explicit','backend/gate.js','if (user.legacy === true) archiveOrder()']
])cases.push({id,files:{[path]:text},ok:true,failures:[]})
cases.push({id:'safety action in ordinary path',files:{'backend/feature.js':'if (ctx.enforce === true) { deny() }'},ok:false,failures:['safety_opt_in']})
cases.push({id:'unwired contract',files:{'docs/contracts/a.schema.json':'{}'},ok:false,failures:['contract_not_wired']})
cases.push({id:'test-only reference',files:{'docs/contracts/a.schema.json':'{}','backend/tests/check.py':'schema="a.schema.json"'},ok:false,failures:['contract_not_wired']})
cases.push({id:'version only reference',files:{'docs/contracts/a.schema.json':'{}','backend/gate.py':'schema="a/v1"'},ok:false,failures:['contract_not_wired']})
cases.push({id:'comment only reference',files:{'docs/contracts/a.schema.json':'{}','backend/check.js':'/* "a.schema.json" */'},ok:false,failures:['contract_not_wired']})
for(const dir of ['node_modules','web/node_modules/next','vendor','third_party','dist','build','.cap','backend/__pycache__','tests','fixtures']) cases.push({id:`excluded ${dir}`,files:{[`${dir}/gate.js`]:'if (cfg.enforce === true) deny()',[`${dir}/a.schema.json`]:'{}'},ok:true,failures:[],forceTracked:true})
export function runCase(c){const r=fixture();for(const [p,s]of Object.entries(c.files))file(r,p,s);if(c.forceTracked)git(r,'add','-f',...Object.keys(c.files));return scan(r,c.mode||'diff')}
for(const c of cases)test(c.id,()=>{const result=runCase(c);matrix.push({id:c.id,input:c.files,expected:{ok:c.ok,failures:c.failures},output:result});assert.equal(result.ok,c.ok);assert.deepEqual(result.failures.map(f=>f.code),c.failures)})
test('full is advisory; diff ignores committed legacy findings',()=>{const r=fixture();file(r,'backend/gate.py','if cfg.enforce:\n    deny()');file(r,'docs/contracts/a.schema.json','{}');git(r,'add','.');git(r,'commit','-qm','legacy');assert.equal(scan(r).ok,true);const full=scan(r,'full');assert.equal(full.exitCode,0);assert.equal(full.ok,true);assert.equal(full.advisory,true);assert.equal(full.scanComplete,true);assert.equal(full.gatePassed,null);assert.deepEqual(full.failures.map(f=>f.code),['contract_not_wired','safety_opt_in'])})
test('consistent counters measure inventory, production and unique reads',()=>{const r=fixture();file(r,'backend/check.py','x=1');file(r,'tests/gate.py','x=2');file(r,'dist/gate.js','x=3');file(r,'notes.txt','note');const diff=scan(r),full=scan(r,'full');for(const v of [diff,full]){assert.equal(v.inventoryFiles,6);assert.equal(v.productionFiles,1);assert.equal(v.inspectedFiles,1);assert.equal(v.scannedFiles,undefined)}})
test('modified source scans added lines with file-wide comment state',()=>{const r=fixture();file(r,'backend/gate.py','deny()\n');git(r,'add','.');git(r,'commit','-qm','source');file(r,'backend/gate.py','deny()\nif cfg.enforce:\n    deny()\n');assert.equal(scan(r).ok,false);file(r,'backend/gate.py','deny()\ntext="""\nif cfg.enforce:\n    deny()\n"""\n');assert.equal(scan(r).ok,true)})
test('tracked dependency schemas excluded even in full inventory',()=>{const r=fixture();file(r,'web/node_modules/pkg/a.schema.json','{}');git(r,'add','.');git(r,'commit','-qm','dependency');assert.equal(scan(r,'full').checked,0)})
test('incomplete scans and invalid modes remain failures in advisory mode',()=>{const r=fixture();symlinkSync('/etc/hosts',join(r,'gate.py'));for(const mode of ['diff','full']){const v=scan(r,mode);assert.equal(v.exitCode,1);assert.equal(v.ok,false);assert.equal(v.failures[0].code,'contract_audit_error')}assert.equal(scan(r,'invalid').exitCode,1)})
