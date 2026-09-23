import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main as exportViz } from "../scripts/export-viz-static.js";

const RALPH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Unreal Agent completes a Ralph turn with a prompt goal and usage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-unreal-turn-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "work");
  const stateBaseDir = path.join(root, "state");
  const unrealStateDir = path.join(root, "unreal-state");
  const tracePath = path.join(root, "runner-request.json");
  const runnerPath = path.join(root, "fake-unreal.mjs");
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
  echo '===== pa1 ====='
  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='
  exit 0
fi
echo '===== pa1 ====='
echo 'pa1/tests/incomplete.t: ERROR: not complete'
echo '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='
exit 1
`, { mode: 0o755 });
  await fs.writeFile(runnerPath, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const workspace = flag('-workspace');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
fs.writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify({
  request, workspace, sessionDirectory: flag('-session-directory'),
  logDirectory: flag('-log-directory'), provider: process.env.UNREAL_HARNESS_LLM_PROVIDER,
}));
fs.writeFileSync(path.join(workspace, 'pass'), 'passed\\n');
execFileSync('git', ['add', 'pass'], { cwd: workspace });
execFileSync('git', ['commit', '-qm', 'pass fixture'], { cwd: workspace });
const emit = (item) => process.stdout.write(JSON.stringify(item) + '\\n');
emit({ Sequence: 1, Kind: 'model_response', Data: { Response: {
  ID: 'response-1', Stop: 'complete',
  Output: [
    { ProviderID: 'call-1', Type: 'tool_call', Data: { CallID: 'call-1', Name: 'Bash', Arguments: JSON.stringify({ command: 'echo checked' }) } },
    { ProviderID: 'message-1', Type: 'message', Data: { Role: 'assistant', Text: 'Done.' } },
  ],
  Usage: { InputTokens: 100, CachedInputTokens: 40, OutputTokens: 12, ReasoningTokens: 2 },
} } });
fs.mkdirSync(flag('-session-directory'), { recursive: true });
fs.writeFileSync(path.join(flag('-session-directory'), request.session_id + '.session.jsonl'),
  JSON.stringify({ type: 'item', data: {
    Item: { Kind: 'tool_call_status', Data: { CallID: 'call-1', Status: { WaitingFor: ['op-1'] } } },
    Operations: [{ ID: 'op-1', Status: 'completed', State: { Result: { Out: 'checked\\n', Err: '', ExitCode: 0 } } }],
  } }) + '\\n');
`, { mode: 0o755 });
  await fs.writeFile(configPath, JSON.stringify({
    provider: "unreal",
    name: "unreal-prototype",
    model: "gpt-6-astra",
    reasoningEffort: "high",
    workdir,
    useExistingWorkdir: true,
    stateBaseDir,
    unrealStateDir,
    unrealPath: runnerPath,
    testCommand: checkPath,
    initialStage: "pa1",
    loopGoalsEnabled: true,
    maxTurns: 2,
    resourceLimits: false,
    sessionIsolation: false,
  }));

  const run = spawnSync(process.execPath, [path.join(RALPH_ROOT, "ralph.js")], {
    cwd: RALPH_ROOT,
    env: { ...process.env, RALPH_CONFIG: configPath, RALPH_RESOURCE_LIMITS: "0" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 0, `Ralph failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const trace = JSON.parse(await fs.readFile(tracePath, "utf8"));
  assert.equal(trace.workspace, workdir);
  assert.equal(trace.provider, "openai-codex");
  assert.equal(trace.request.model, "gpt-6-astra");
  assert.equal(trace.request.thinking_level, "high");
  assert.match(trace.request.session_id, /^unreal-[0-9a-f-]{36}$/i);
  assert.match(trace.request.prompt, /## Ralph Portable Goal/);
  assert.match(trace.request.prompt, /Ralph will verify the external checks/);
  assert.equal(trace.request.prompt.includes("complete_ralph_goal"), false);
  assert.equal(trace.sessionDirectory, path.join(unrealStateDir, "sessions"));
  assert.equal(trace.logDirectory, path.join(unrealStateDir, "logs"));

  const stateDir = path.join(stateBaseDir, "unreal-prototype-gpt-6-astra-high");
  const state = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.threadId, trace.request.session_id);
  const eventFiles = await fs.readdir(path.join(stateDir, "events"));
  const events = (await fs.readFile(path.join(stateDir, "events", eventFiles.find((file) => file.endsWith(".jsonl"))), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(events.some((record) => record.eventType === "thread.started"));
  assert.ok(events.some((record) => record.eventType === "item.completed" && record.event.item.text === "Done."));
  assert.ok(events.some((record) => record.eventType === "item.completed" &&
    record.event.item.type === "command_execution" &&
    record.event.item.aggregated_output === "checked\n" &&
    record.event.item.exit_code === 0));
  const completed = events.find((record) => record.eventType === "turn.completed");
  assert.deepEqual(completed.event.usage, {
    input_tokens: 100, cached_input_tokens: 40, output_tokens: 12,
    reasoning_output_tokens: 2, total_tokens: 112,
  });
  const goal = JSON.parse(await fs.readFile(path.join(stateDir, "current-goal.json"), "utf8"));
  assert.equal(goal.status, "complete");

  const exportDir = path.join(root, "export");
  await exportViz([
    "--out", exportDir, "--run", path.basename(stateDir), "--ralph-dir", stateBaseDir,
    "--work-dir", root, "--no-published-base", "--no-compare",
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(exportDir, "data", "runs.json"), "utf8"));
  const summary = JSON.parse(await fs.readFile(path.join(exportDir, "data", manifest.runs[0].dataPath), "utf8"));
  const turnPath = summary.turns.find((turn) => turn.turn === "1")?.path;
  assert.ok(turnPath, "first turn should be exported");
  const exportedTurn = JSON.parse(await fs.readFile(path.join(exportDir, "data", turnPath), "utf8"));
  assert.ok(exportedTurn.events.some((record) => record.eventType === "item.completed" &&
    record.event.item?.aggregated_output === "checked\n"));
});
