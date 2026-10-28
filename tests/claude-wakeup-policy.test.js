import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a scheduled fallback cannot hold a completed Claude handoff open', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-wakeup-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const ready = path.join(root, 'ready');
  const check = path.join(root, 'check.sh');
  const agent = path.join(root, 'claude.mjs');
  fs.mkdirSync(work);
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  execFileSync('git', ['init', '--bare', '-q', path.join(root, 'remote.git')]);
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-qu', 'origin', 'HEAD');
  fs.writeFileSync(check, `#!/bin/sh
if test -f '${ready}'; then echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='; exit 0; fi
echo 'fixture.t: ERROR: incomplete'; echo '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='; exit 1
`, { mode: 0o755 });
  fs.writeFileSync(agent, `#!/usr/bin/env node
import fs from 'node:fs';
let input=''; for await(const part of process.stdin) input+=part;
if(input==='/goal clear'){console.log(JSON.stringify({result:'cleared'}));process.exit(0);}
const emit=e=>process.stdout.write(JSON.stringify({session_id:'wakeup-fixture',...e})+'\\n');
emit({type:'system',subtype:'init'});
const at=process.argv.indexOf('--disallowed-tools');
const denied=at<0?[]:process.argv[at+1].split(',');
if(!denied.includes('WebSearch'))throw Error('Existing web-search policy was lost');
if(!denied.includes('ScheduleWakeup')) {
  emit({type:'result',subtype:'success',is_error:false,result:'Checks finished; fallback alarm still pending'});
  setTimeout(()=>{},60000);
} else {
  fs.writeFileSync(${JSON.stringify(ready)},'checked');
  emit({type:'assistant',message:{content:[{type:'text',text:'Handoff complete.'}]}});
  emit({type:'attachment',attachment:{type:'goal_status',met:true,reason:'Ready for external checks'}});
  emit({type:'result',subtype:'success',is_error:false,result:'Handoff complete.'});
}
`, { mode: 0o755 });
  const config = path.join(root, 'run.config.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wakeup-fixture', provider: 'claude', model: 'fixture',
    workdir: work, useExistingWorkdir: true, stateBaseDir: path.join(root, 'state'), testCommand: check,
    claudePath: agent, loopGoalsEnabled: true, maxTurns: 1, webSearchEnabled: false,
    sessionIsolation: false, resourceLimits: false }));
  const run = spawnSync(process.execPath, ['ralph.js'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, RALPH_CONFIG: config, RALPH_SESSION_ISOLATION: '0', RALPH_RESOURCE_LIMITS: '0' },
  });
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
  assert(fs.existsSync(ready));
  assert.match(run.stdout, /goal_status complete/);
  assert.match(run.stdout, /Phase check status: tests pass \(0\)/);
});
