import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const variant of ['simple', 'report-guarded', 'file-guarded', 'inception']) test(`a successful response with a ${variant} self-wait returns to goal verification and external checks`,
  { skip: process.platform !== 'linux' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-response-watchdog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const work = path.join(root, 'work');
    const complete = path.join(root, 'complete');
    const check = path.join(root, 'check.sh');
    const agent = path.join(root, 'claude.mjs');
    fs.mkdirSync(work);
    const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    execFileSync('git', ['init', '--bare', '-q', path.join(root, 'remote.git')]);
    git('remote', 'add', 'origin', path.join(root, 'remote.git')); git('push', '-qu', 'origin', 'HEAD');
    const marker = `unique-watchdog-${path.basename(root)}/${variant === 'inception' ? 'make inception' : 'sweep.sh'}`;
    const report = path.join(root, 'through.log');
    fs.writeFileSync(report, '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) =====\n');
    const pollCommand = {
      simple: `until ! pgrep -f '${marker}' >/dev/null; do sleep 30; done`,
      'report-guarded': `until grep -q "TESTS PASSED\\|FAIL\\|Error" ${report} 2>/dev/null && ! pgrep -f "${marker}" >/dev/null; do sleep 30; done; tail -1 ${report}`,
      'file-guarded': `until [ -s ${report} ] && ! pgrep -f "${marker}" >/dev/null; do sleep 30; done; tail -6 ${report}`,
      inception: `until ! pgrep -f "${marker}" >/dev/null; do sleep 30; done; grep -c "MATCH" ${report}; grep -E "MISMATCH|DIFFER|rror" ${report} | head; tail -3 ${report}`,
    }[variant];
    fs.writeFileSync(check, `#!/bin/sh
if test -f '${complete}'; then
  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='; exit 0
fi
echo 'fixture.t: ERROR: incomplete'
echo '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='; exit 1
`, { mode: 0o755 });
    fs.writeFileSync(agent, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
let input=''; for await (const part of process.stdin) input+=part;
const emit=e=>process.stdout.write(JSON.stringify({session_id:'watchdog-fixture',...e})+'\\n');
if (input==='/goal clear') { console.log(JSON.stringify({result:'cleared'})); process.exit(0); }
emit({type:'system',subtype:'init'});
emit({type:'assistant',message:{content:[{type:'text',text:'Ready to hand off.'}]}});
const poll=spawn('/bin/bash',['-c',${JSON.stringify(pollCommand)}],{stdio:'ignore'});
setTimeout(()=>emit({type:'result',subtype:'success',is_error:false,result:'Work complete'}),100);
poll.on('exit',()=>{
  fs.writeFileSync(${JSON.stringify(complete)},'complete');
  emit({type:'attachment',attachment:{type:'goal_status',met:true,reason:'Handoff ready'}});
  emit({type:'result',subtype:'success',is_error:false,result:'Background wait cleared'});
});
`, { mode: 0o755 });
    const config = path.join(root, 'run.config.json');
    fs.writeFileSync(config, JSON.stringify({
      name: 'watchdog-fixture', provider: 'claude', model: 'fixture', workdir: work,
      useExistingWorkdir: true, stateBaseDir: path.join(root, 'state'), testCommand: check,
      claudePath: agent, loopGoalsEnabled: true, maxTurns: 1,
      sessionIsolation: false, resourceLimits: false,
    }));
    const run = spawnSync(process.execPath, ['ralph.js'], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, RALPH_CONFIG: config, RALPH_CLAUDE_RESPONSE_GRACE_MS: '30',
        RALPH_SESSION_ISOLATION: '0', RALPH_RESOURCE_LIMITS: '0' },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Claude response finished; waiting on background tasks/);
    assert.match(run.stdout, /Stopped verified self-matching Claude polling shell/);
    assert(fs.existsSync(complete), 'Only poll exit makes the external gate pass');
    assert.match(run.stdout, /Phase check status: tests pass \(0\)/);
    assert(run.stdout.indexOf('goal_status complete') < run.stdout.indexOf('Phase check status: tests pass (0)'));
  });
