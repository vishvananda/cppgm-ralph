import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { runCodexGoalHost } from '../../codex-goal-host.js';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const artifacts = process.argv[3];
const child = spawn(config.codexPath, ['app-server', '--listen', 'stdio://'], {
  cwd: config.workdir, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let sequence = 0;
let initialized = false;
let messages = '';
const client = {
  onNotification: null,
  onFailure: null,
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  },
  async initialize() {
    if (initialized) return;
    await this.request('initialize', {
      clientInfo: { name: 'ralph', title: 'Ralph scaffold verifier', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    initialized = true;
  },
};
const fail = error => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  client.onFailure?.(error);
};
child.on('error', fail);
child.on('exit', (code, signal) => fail(new Error(`Probe host exited: ${code}/${signal}`)));
child.stderr.on('data', data => fs.appendFileSync(path.join(artifacts, 'codex-stderr.txt'), data));
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const event = JSON.parse(line);
  fs.appendFileSync(path.join(artifacts, 'codex-smoke.jsonl'), `${line}\n`);
  if (event.id != null && pending.has(event.id)) {
    const request = pending.get(event.id);
    pending.delete(event.id);
    if (event.error) request.reject(new Error(JSON.stringify(event.error)));
    else request.resolve(event.result);
  } else if (event.method) {
    if (event.method === 'item/agentMessage/delta') messages += event.params?.delta ?? '';
    client.onNotification?.(event);
  }
});
try {
  await client.initialize();
  const options = {
    model: config.model, cwd: config.workdir, approvalPolicy: config.approvalPolicy,
    sandbox: config.sandboxMode,
    config: { features: { goals: true }, model_reasoning_effort: config.reasoningEffort },
  };
  const { thread } = await client.request('thread/start', options);
  assert(thread?.id);
  await client.request('thread/goal/set', {
    threadId: thread.id, status: 'active',
    objective: 'Connectivity probe only: reply READY and mark this existing goal complete with update_goal. Do not read or change files.',
  });
  const goal = await runCodexGoalHost({
    client, threadId: thread.id, resumeParams: options,
    input: [{ type: 'text', text: 'Fulfill the existing connectivity goal. No file reads, changes or shell commands.' }],
    onEvent: () => {}, continuationPrompt: 'Finish the existing connectivity goal.',
  });
  assert.equal(goal.status, 'complete');
  assert(messages.includes('READY'));
  fs.writeFileSync(path.join(artifacts, 'goal-completion.json'),
    `${JSON.stringify({ threadId: thread.id, goal, messages }, null, 2)}\n`);
  console.log('Default-profile Sol/high inference and native goal completion: PASS');
} finally {
  lines.close();
  child.kill('SIGTERM');
}
