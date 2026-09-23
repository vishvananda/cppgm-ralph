import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as exportViz } from "../scripts/export-viz-static.js";

const RALPH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Strands completes and exports a Ralph turn with goal, command output, and usage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-strands-turn-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "work");
  const stateBaseDir = path.join(root, "state");
  const tracePath = path.join(root, "request.json");
  const runnerPath = path.join(root, "fake-strands.mjs");
  const checkPath = path.join(root, "check.sh");
  const configPath = path.join(root, "ralph.config.json");
  await fs.mkdir(path.join(workdir, "pa1"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "ralph-test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Ralph Test"], { cwd: workdir });
  await fs.writeFile(path.join(workdir, "pa1", "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });

  await fs.writeFile(checkPath, `#!/bin/sh
if test -f '${workdir}/pass'; then
  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='
  exit 0
fi
echo 'pa1/tests/incomplete.t: ERROR: not complete'
exit 1
`, { mode: 0o755 });
  await fs.writeFile(runnerPath, `import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
fs.writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ request,
  apiKeyPresent: Boolean(process.env.OPENAI_API_KEY) }));
fs.writeFileSync(path.join(process.cwd(), 'pass'), 'passed\\n');
execFileSync('git', ['add', 'pass'], { cwd: process.cwd() });
execFileSync('git', ['commit', '-qm', 'pass fixture'], { cwd: process.cwd() });
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
const toolUse = { toolUseId: 'call-1', name: 'shell', input: { command: 'echo checked' } };
emit({ type: 'driver.started', sessionId: request.sessionId });
emit({ type: 'model.start' });
emit({ type: 'model.content', block: { reasoning: { text: 'Check the fixture.' } } });
emit({ type: 'model.content', block: { toolUse } });
emit({ type: 'model.usage', usage: { input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 }, output_tokens: 12,
  output_tokens_details: { reasoning_tokens: 2 } } });
emit({ type: 'model.complete' });
emit({ type: 'tool.start', toolUse });
emit({ type: 'tool.complete', toolUse, result: { toolResult: { status: 'success',
  content: [{ json: { output: 'checked\\n', error: '', exit_code: 0 } }] } } });
emit({ type: 'model.start' });
emit({ type: 'model.content', block: { text: 'Done.' } });
emit({ type: 'model.complete' });
emit({ type: 'driver.completed', usage: { inputTokens: 100, outputTokens: 12 } });
`);
  await fs.writeFile(configPath, JSON.stringify({
    provider: "strands", name: "strands-prototype", model: "gpt-6-luna",
    reasoningEffort: "max", workdir, useExistingWorkdir: true,
    stateBaseDir, strandsPath: runnerPath, testCommand: checkPath,
    initialStage: "pa1", loopGoalsEnabled: true, maxTurns: 2,
    resourceLimits: false, sessionIsolation: false,
  }));

  const run = spawnSync(process.execPath, [path.join(RALPH_ROOT, "ralph.js")], {
    cwd: RALPH_ROOT,
    env: { ...process.env, OPENAI_API_KEY: "must-not-pass", RALPH_CONFIG: configPath,
      RALPH_RESOURCE_LIMITS: "0" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(run.status, 0, `Ralph failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const trace = JSON.parse(await fs.readFile(tracePath, "utf8"));
  assert.equal(trace.apiKeyPresent, false);
  assert.equal(trace.request.model, "gpt-6-luna");
  assert.equal(trace.request.effort, "max");
  assert.match(trace.request.sessionId, /^strands-[0-9a-f-]{36}$/i);
  assert.match(trace.request.prompt, /## Ralph Portable Goal/);
  assert.match(trace.request.prompt, /Ralph will verify the external checks/);

  const stateDir = path.join(stateBaseDir, "strands-prototype-gpt-6-luna-max");
  const eventFiles = await fs.readdir(path.join(stateDir, "events"));
  const events = (await fs.readFile(path.join(stateDir, "events", eventFiles.find((file) => file.endsWith(".jsonl"))), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(events.some((record) => record.event?.item?.type === "reasoning" &&
    record.event.item.response_command_count === 1));
  assert.ok(events.some((record) => record.event?.item?.aggregated_output === "checked\n"));
  assert.deepEqual(events.find((record) => record.eventType === "turn.completed")?.event.usage, {
    input_tokens: 100, cached_input_tokens: 40, output_tokens: 12,
    reasoning_output_tokens: 2, total_tokens: 112,
  });
  const goal = JSON.parse(await fs.readFile(path.join(stateDir, "current-goal.json"), "utf8"));
  assert.equal(goal.status, "complete");

  const exportDir = path.join(root, "export");
  await exportViz(["--out", exportDir, "--run", path.basename(stateDir),
    "--ralph-dir", stateBaseDir, "--work-dir", root, "--no-published-base", "--no-compare"]);
  const manifest = JSON.parse(await fs.readFile(path.join(exportDir, "data", "runs.json"), "utf8"));
  const summary = JSON.parse(await fs.readFile(path.join(exportDir, "data", manifest.runs[0].dataPath), "utf8"));
  const turnPath = summary.turns.find((turn) => turn.turn === "1")?.path;
  assert.ok(turnPath);
  const exported = JSON.parse(await fs.readFile(path.join(exportDir, "data", turnPath), "utf8"));
  assert.ok(exported.events.some((record) => record.event?.item?.aggregated_output === "checked\n"));
});
