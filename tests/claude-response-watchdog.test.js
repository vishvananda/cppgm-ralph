import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createClaudeResponseWatchdog, findSelfWaits, pollingPattern, readProcesses } from '../claude-response-watchdog.js';

const script = "until ! pgrep -f 'watchdog/example.sh' >/dev/null; do sleep 5; done; cat $RALPH_ARTIFACT_DIR/sweep.out";
const row = (pid, ppid, argv, extra = {}) => ({ pid, ppid, argv, start: '100', namespace: 'pid:[test]', ...extra });
const root = row(1, 0, ['claude']);
const poll = row(2, 1, ['/bin/bash', '-c', script]);
const sleeper = row(3, 2, ['sleep', '5']);
const success = { type: 'result', subtype: 'success', is_error: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('recognizes only literal negative polling loops, including the Claude wrapper', () => {
  assert(pollingPattern(poll.argv));
  const quoted = "'" + script.replaceAll("'", "'\"'\"'") + "'";
  assert(pollingPattern(['/bin/bash', '-c', `source snapshot || true && eval ${quoted} < /dev/null && pwd -P >| /tmp/claude-123-cwd`]));
  for (const command of [
    script.replace('sleep 5', 'make build'), script.replace('! pgrep', 'pgrep'),
    script.replace('done; cat', 'done; rm'), script.replace('example.sh', '$(command)'),
    script.replace('sleep 5;', 'sleep 5; touch marker;'), 'make test',
  ]) assert.equal(pollingPattern(['/bin/bash', '-c', command]), null, command);
});

test('requires a sole self match and harmless children within the actual process subtree', () => {
  assert.deepEqual(findSelfWaits([root, poll, sleeper], 1), [poll]);
  assert.deepEqual(findSelfWaits([root, poll, sleeper, row(4, 1, ['sh', 'watchdog/example.sh'])], 1), []);
  assert.deepEqual(findSelfWaits([root, poll, sleeper, row(4, 99, ['sh', 'watchdog/example.sh'])], 1), []);
  assert.deepEqual(findSelfWaits([root, poll, row(4, 2, ['make', 'test'])], 1), []);
  assert.deepEqual(findSelfWaits([root, poll, sleeper], 99), []);
  assert.deepEqual(findSelfWaits([root, poll, sleeper, row(4, 99, ['sh', 'watchdog/example.sh'], { namespace: 'other' })], 1), [poll]);
});

test('recognizes literal report guards, double-quoted process patterns and read-only tails', () => {
  const command = 'until grep -q "TESTS PASSED\\|FAIL\\|Error" /tmp/final-through.log 2>/dev/null && ! pgrep -f "test-report-through-pa31" >/dev/null; do sleep 5; done; tail -1 /tmp/final-through.log';
  assert(pollingPattern(['/bin/bash', '-c', command]));
  const quoted = "'" + command.replaceAll("'", "'\"'\"'") + "'";
  const wrapped = `source snapshot || true && eval ${quoted} < /dev/null && pwd -P >| /tmp/claude-79f1-cwd`;
  const waiter = row(2, 1, ['/bin/bash', '-c', wrapped]);
  assert.deepEqual(findSelfWaits([root, waiter, sleeper], 1), [waiter]);
  assert.deepEqual(findSelfWaits([root, waiter, sleeper,
    row(4, 99, ['make', 'test-report-through-pa31'])], 1), []);
  for (const unsafe of [
    command.replace('grep -q', 'touch marker && grep -q'),
    command.replace('TESTS PASSED', '$(touch marker)'),
    command.replace('do sleep 5;', 'do make build; sleep 5;'),
    command + '; rm /tmp/marker',
  ]) assert.equal(pollingPattern(['/bin/bash', '-c', unsafe]), null, unsafe);
});

test('recognizes file-size guards and space-containing patterns with multiple report reads', () => {
  const commands = [
    'until [ -s /tmp/pa35w/through33.log ] && ! pgrep -f "test-report-through" >/dev/null; do sleep 15; done; tail -6 /tmp/pa35w/through33.log',
    'until ! pgrep -f "make inception" >/dev/null; do sleep 15; done; grep -c "MATCH" /tmp/pa35w/inception.log; grep -E "MISMATCH|DIFFER|rror" /tmp/pa35w/inception.log | head; tail -3 /tmp/pa35w/inception.log',
  ];
  for (const command of commands) {
    const quoted = "'" + command.replaceAll("'", "'\"'\"'") + "'";
    const wrapped = `source snapshot || true && eval ${quoted} < /dev/null && pwd -P >| /tmp/claude-79f1-cwd`;
    const waiter = row(2, 1, ['/bin/bash', '-c', wrapped]);
    assert(pollingPattern(waiter.argv));
    assert.deepEqual(findSelfWaits([root, waiter, sleeper], 1), [waiter]);
    const worker = command.includes('make inception')
      ? ['make', 'inception'] : ['make', 'test-report-through-pa33'];
    assert.deepEqual(findSelfWaits([root, waiter, sleeper, row(4, 99, worker)], 1), []);
    for (const unsafe of [
      command + '; touch marker',
      command.replace('do sleep 15;', 'do make build; sleep 15;'),
      command.replace('>/dev/null;', '>/tmp/marker;'),
      command.replace('done;', 'done; echo $(touch marker);'),
      command.replace(/pgrep -f "[^"]+"/, 'pgrep -f "$(touch marker)"'),
    ]) assert.equal(pollingPattern(['/bin/bash', '-c', unsafe]), null, unsafe);
  }
});

test('recognizes report guards after the process wait and literal completion messages', () => {
  const command = 'until ! pgrep -f "check.pl" >/dev/null && grep -q "exit=" /tmp/tasks/result.output; do sleep 15; done; echo done';
  for (const script of [command, command.replace('grep -q "exit=" /tmp/tasks/result.output', '[ -s /tmp/tasks/result.output ]')]) {
    const quoted = "'" + script.replaceAll("'", "'\"'\"'") + "'";
    for (const body of [script, `source snapshot || true && eval ${quoted} < /dev/null && pwd -P >| /tmp/claude-79f1-cwd`]) {
      const waiter = row(2, 1, ['/bin/bash', '-c', body]);
      assert(pollingPattern(waiter.argv));
      assert.deepEqual(findSelfWaits([root, waiter, sleeper], 1), [waiter]);
      assert.deepEqual(findSelfWaits([root, waiter, sleeper, row(4, 99, ['perl', 'check.pl'])], 1), []);
    }
  }
  for (const unsafe of [
    command.replace('exit=', '$(touch marker)'),
    command.replace('grep -q "exit="', 'touch marker && grep -q "exit="'),
    command.replace('echo done', 'echo $(touch marker)'),
    command.replace('echo done', 'echo done >/tmp/marker'),
    command.replace('do sleep 15;', 'do make build; sleep 15;'),
    command.replace('done; echo done', 'done; rm /tmp/marker'),
  ]) assert.equal(pollingPattern(['/bin/bash', '-c', unsafe]), null, unsafe);
});

test('recognizes read-only counter guards and report pipelines without executing shell text', () => {
  const command = 'until [ $(ls /tmp/fz-trim/log* | xargs grep -l "^done\\|seed 3[0-9]\\|" 2>/dev/null | wc -l) -ge 0 ] && ! pgrep -f "fuzz.sh" >/dev/null; do sleep 20; done; cat /tmp/fz-trim/log* | grep -v "^$" | grep -vc "ok$"; cat /tmp/fz-trim/log* | grep -iv " ok$" | head -20';
  const quoted = "'" + command.replaceAll("'", "'\"'\"'") + "'";
  for (const body of [command, `source snapshot || true && eval ${quoted} < /dev/null && pwd -P >| /tmp/claude-123-cwd`]) {
    const waiter = row(2, 1, ['/bin/bash', '-c', body]);
    assert(pollingPattern(waiter.argv));
    assert.deepEqual(findSelfWaits([root, waiter, sleeper], 1), [waiter]);
    assert.deepEqual(findSelfWaits([root, waiter, sleeper, row(4, 99, ['bash', 'fuzz.sh'])], 1), []);
  }
  for (const unsafe of [
    command.replace('xargs grep', 'xargs sh'),
    command.replace('ls /tmp/fz-trim/log*', 'touch /tmp/marker'),
    command.replace('wc -l', 'wc -l > /tmp/marker'),
    command.replace('wc -l', 'wc -l $(touch /tmp/marker)'),
    command.replace('ls /tmp/fz-trim/log*', 'ls `touch /tmp/marker`'),
    command.replace('cat /tmp/fz-trim/log*', 'cat "${BAD@P}"'),
    command.replace('cat /tmp/fz-trim/log*', '"cat 2>/dev/null" /tmp/report'),
    command.replace('cat /tmp/fz-trim/log*', '"c\\at" /tmp/report'),
    command + '; rm /tmp/marker',
    command.replace('head -20', 'sh /tmp/helper'),
  ]) assert.equal(pollingPattern(['/bin/bash', '-c', unsafe]), null, unsafe);
});

test('rechecks a previously busy wait after real work ends, with a single warning', async () => {
  let reads = 0;
  const signals = [], events = [];
  const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 5,
    snapshot: async () => ++reads === 1
      ? [root, poll, sleeper, row(4, 1, ['sh', 'watchdog/example.sh'])] : [root, poll, sleeper],
    signal: p => signals.push(p), onStatus: e => events.push(e.status) });
  guard.observe(success);
  await delay(40);
  guard.close();
  assert.deepEqual(signals, [3, 2]);
  assert.deepEqual(events, ['waiting', 'self-wait-stopped']);
});

test('successful result warns, rechecks, and cancels only the proven loop and its sleep', async () => {
  const events = [], signals = [];
  const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 5,
    snapshot: async () => [root, poll, sleeper], signal: pid => signals.push(pid), onStatus: e => events.push(e.status) });
  guard.observe(success);
  await delay(30);
  guard.close();
  assert.deepEqual(signals, [3, 2]);
  assert.deepEqual(events, ['waiting', 'self-wait-stopped']);
});

test('live work, new model activity, failures and closed hosts are never cancelled', async () => {
  for (const next of [{ type: 'assistant' }, { type: 'result', is_error: true }, 'close']) {
    const signals = [], events = [];
    const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 5,
      snapshot: async () => [root, poll], signal: p => signals.push(p), onStatus: e => events.push(e) });
    guard.observe(success);
    if (next === 'close') guard.close(); else guard.observe(next);
    await delay(20);
    guard.close();
    assert.deepEqual(signals, []); assert.deepEqual(events, []);
  }
  const signals = [], events = [];
  const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 5,
    snapshot: async () => [root, row(2, 1, ['make', 'test'])],
    signal: p => signals.push(p), onStatus: e => events.push(e.status) });
  guard.observe(success);
  await delay(25); guard.close();
  assert.deepEqual(signals, []); assert.deepEqual(events, ['waiting']);
});

test('a changed matching set or reused PID cancels recovery, and observation races are safe', async () => {
  for (const replacement of [
    [root, poll, row(4, 1, ['sh', 'watchdog/example.sh'])],
    [root, { ...poll, start: 'new' }],
  ]) {
    let reads = 0;
    const signals = [];
    const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 1,
      snapshot: async () => ++reads === 1 ? [root, poll] : replacement,
      signal: p => signals.push(p) });
    guard.observe(success); await delay(20); guard.close();
    assert.deepEqual(signals, []);
  }
  let release;
  const signals = [];
  const guard = createClaudeResponseWatchdog({ rootPid: 1, graceMs: 1,
    snapshot: () => new Promise(resolve => { release = resolve; }), signal: p => signals.push(p) });
  guard.observe(success); await delay(10); guard.observe({ type: 'assistant' });
  release([root, poll]); await delay(10); guard.close();
  assert.deepEqual(signals, []);
});

test('recovers a real self-matching shell without leaving its sleep holding the process open',
  { skip: process.platform !== 'linux' }, async t => {
    const marker = `ralph-watchdog-${process.pid}-${Date.now()}/sweep.sh`;
    const shell = spawn('/bin/bash', ['-c', `until ! pgrep -f '${marker}' >/dev/null && grep -q "exit=" /dev/null; do sleep 30; done; echo done`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(shell, 'exit');
    t.after(() => { try { shell.kill('SIGTERM'); } catch {} });
    let children = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(50);
      const before = await readProcesses();
      children = before.filter(p => p.ppid === shell.pid);
      if (children.some(p => p.argv[0] === 'sleep')) break;
    }
    assert(children.some(p => p.argv[0] === 'sleep'));
    const guard = createClaudeResponseWatchdog({ rootPid: process.pid, graceMs: 5 });
    t.after(() => guard.close());
    guard.observe(success);
    await Promise.race([exited, delay(10000).then(() => { throw new Error('Polling shell was not recovered'); })]);
    await delay(20);
    const after = await readProcesses();
    assert(!after.some(p => children.some(c => c.pid === p.pid && c.start === p.start)));
  });
