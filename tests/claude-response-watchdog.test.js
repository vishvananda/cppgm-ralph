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
    const shell = spawn('/bin/bash', ['-c', `until ! pgrep -f '${marker}' >/dev/null; do sleep 30; done`],
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
    await Promise.race([exited, delay(2000).then(() => { throw new Error('Polling shell was not recovered'); })]);
    await delay(20);
    const after = await readProcesses();
    assert(!after.some(p => children.some(c => c.pid === p.pid && c.start === p.start)));
  });
