import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { readRunStateSummary, turnExecutionDurationEntries } from "../ralph-viz/server.js";

const lifecycle = globalThis.RALPH_TURN_LIFECYCLE;
const origin = Date.parse("2026-09-08T17:56:38.815Z");
const event = (ms, type, data = {}) => ({
  turnNumber: 43, threadId: "root-thread", recordedAt: new Date(origin + ms).toISOString(),
  eventType: type, event: { type, ...data },
});
const start = (ms) => event(ms, "ralph.phase-status", {
  action: "turn-start", phaseStatus: { stage: "pa1", phase: "implement", allRequiredPassed: false },
});
const startup = () => [start(0), event(0, "ralph.prompt", { prompt: "Implement pa1" }),
  event(875, "thread.started"), event(924, "turn.started")];
const failure = () => event(48667, "ralph.turn-failed", { error: { message: "request timed out" } });

const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
const browser = vm.createContext({
  TURN_LIFECYCLE: lifecycle, ACTIVE_EVENT_GAP_MS: 600_000,
  displayTurnForRecord: (r) => r.turnNumber, eventThreadId: (r) => r.threadId,
  isUsageBaselineRecord: () => false,
});
for (const name of ["isActiveCurrentRunTurn", "activeCurrentRunTurnStartMs", "latestTurnStartMs",
  "buildTurnDurationMap", "buildTurnAttemptWindows", "isTurnAttemptBoundaryRecord", "findTurnAttemptIndex",
  "isDurationSpanActivity", "isCodexTimingActivity", "isLimitWaitEvent", "subtractLimitWaitOverlap",
  "activeEventDurationMs", "isTimedWorkStartEvent", "isTimedWorkEndEvent", "isCommandStartEvent", "isCommandEndEvent"]) {
  const tail = app.slice(app.indexOf(`function ${name}(`));
  assert.ok(tail.startsWith(`function ${name}(`), name);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(end < 0 ? tail : tail.slice(0, end + 1), browser);
}

test("historical reconnect errors contribute actual elapsed time, not just startup time", () => {
  const events = [...startup(), event(48667, "error", { message: "Reconnecting... 2/5 (request timed out)" }),
    event(2 * 3600_000, "ralph.turn-restart")];
  assert.equal(turnExecutionDurationEntries(events)[0].durationMs, 48667);
  assert.equal(browser.buildTurnDurationMap(events).get(43).durationMs, 48667);
});

test("failed attempts stop live timers, but reconnect notices and new retries do not", () => {
  const run = { state: { active: true, turnsCompleted: 42, activeTurn: { status: "running" } } };
  const records = [...startup(), event(40000, "error", { message: "Reconnecting... 2/5 (request timed out)" })];
  assert.equal(browser.isActiveCurrentRunTurn(run, 43, records), true);
  records.push(failure());
  assert.equal(lifecycle.failedAttemptEndMs(records, 43), origin + 48667);
  assert.equal(browser.isActiveCurrentRunTurn(run, 43, records), false);
  assert.equal(browser.activeCurrentRunTurnStartMs(run, 43, records), null);
  records.push(start(2 * 3600_000));
  assert.equal(lifecycle.failedAttemptEndMs(records, 43), null);
  assert.equal(browser.isActiveCurrentRunTurn(run, 43, records), true);
  assert.equal(browser.activeCurrentRunTurnStartMs(run, 43, records), origin + 2 * 3600_000);
  run.state.activeTurn.status = "failed";
  assert.equal(browser.isActiveCurrentRunTurn(run, 43, []), false, "state also stops the clock when events are paged out");
});

test("abandoned command cards do not extend a failed turn into idle time", () => {
  const events = [...startup(), event(1000, "item.started", { item: { id: "cmd", type: "command_execution" } }), failure()];
  const options = { includeOpenCommandTail: true, nowMs: origin + 3 * 3600_000 };
  assert.equal(turnExecutionDurationEntries(events, new Map(), options)[0].durationMs, 48667);
  assert.equal(browser.buildTurnDurationMap(events, options).get(43).durationMs, 48667);
  events.push(start(2 * 3600_000), event(2 * 3600_000, "ralph.prompt"), event(2 * 3600_000 + 60000, "turn.completed"));
  assert.equal(turnExecutionDurationEntries(events, new Map(), options)[0].durationMs, 108667);
  assert.equal(browser.buildTurnDurationMap(events, options).get(43).durationMs, 108667);
});

test("state summary distinguishes a resumable failed phase from a running attempt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const state = { activePhase: "implement", turnsCompleted: 42, updatedAt: new Date().toISOString(),
    eventLogPath: "/fixture/events/run.jsonl", activeTurn: { status: "failed", endedAt: failure().recordedAt } };
  await fs.writeFile(file, JSON.stringify(state));
  const failed = await readRunStateSummary(file, "run");
  assert.equal(failed.active, false);
  assert.equal(failed.activePhase, "implement");
  assert.equal(failed.activeTurn.status, "failed");
  state.activeTurn.status = "running";
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await readRunStateSummary(file, "run")).active, true);
});

test("comparison duration counts failed and successful attempts without restart downtime", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-failed-comparison-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const codexDir = path.join(directory, "codex");
  const claudeDir = path.join(directory, "claude");
  await fs.mkdir(codexDir);
  await fs.mkdir(claudeDir);
  const file = path.join(directory, "run-gpt-6-astra.jsonl");
  for (const failedMs of [48667, 0]) {
    const events = [start(0), event(0, "ralph.prompt"), event(failedMs, "ralph.turn-failed"),
      start(2 * 3600_000), event(2 * 3600_000, "ralph.prompt"),
      event(2 * 3600_000 + 60000, "turn.completed", { usage: { input_tokens: 100, output_tokens: 10 } })];
    await fs.writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
    const comparison = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/compare-pa-costs.js"),
      "--format", "json", "--through", "pa1", "--codex-dir", codexDir, "--claude-dir", claudeDir, file], { encoding: "utf8" }));
    assert.equal(comparison.runs[0].total.durationMs, failedMs + 60000);
    assert.equal(comparison.rows[0].runs[0].durationMs, failedMs + 60000);
  }
});
