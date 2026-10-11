import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve("scripts/compare-pa-costs.js");

test("V5 comparison totals include PA35 in the default native display", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-v5-comparison-"));
  const workDir = path.join(directory, "work");
  const ralphDir = path.join(workDir, ".ralph");
  const codexDir = path.join(directory, "codex");
  const claudeDir = path.join(directory, "claude");
  const eventsDir = path.join(ralphDir, "v5sol-gpt-6.1-sol-high", "events");
  for (const dir of [eventsDir, codexDir, claudeDir]) await mkdir(dir, { recursive: true });
  const record = (recordedAt, eventType, event) => ({
    recordedAt, threadId: "v5-thread", turnNumber: 1, eventType,
    event: { type: eventType, ...event },
  });
  const events = [
    record("2026-10-11T00:00:00Z", "ralph.phase-status", {
      action: "turn-start", phaseStatus: { stage: "pa35", phase: "implement", allRequiredPassed: false },
    }),
    record("2026-10-11T00:00:00Z", "ralph.prompt", { prompt: "Implement pa35" }),
    record("2026-10-11T00:10:00Z", "turn.completed", {
      usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, total_tokens: 1100 },
    }),
  ];
  try {
    await writeFile(path.join(workDir, "v5sol.config.json"), JSON.stringify({ assignmentLayout: "v5" }));
    await writeFile(path.join(eventsDir, "run.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT, "--format", "json", "--through", "pa40", "--work-dir", workDir,
      "--ralph-dir", ralphDir, "--codex-dir", codexDir, "--claude-dir", claudeDir, "v5sol-gpt-6.1-sol-high",
    ]);
    const comparison = JSON.parse(stdout);
    const stage = comparison.rows.find(row => row.pa === "pa35").runs[0];
    assert.equal(comparison.runs[0].layout.id, "v5");
    assert.equal(comparison.displayLayout, "v5");
    assert.equal(stage.durationMs, 600000);
    assert(stage.cost > 0);
    assert.equal(comparison.runs[0].total.cost, stage.cost);
    assert.equal(comparison.runs[0].total.activeDurationMs, stage.activeDurationMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PA comparison includes subagent time and mixed-model cost", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-runtime-test-"));
  const codexDir = path.join(directory, "codex", "sessions");
  const claudeDir = path.join(directory, "claude");
  const eventPath = path.join(directory, "run-gpt-5.6-sol.jsonl");
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  const record = (recordedAt, eventType, event) => ({
    recordedAt,
    threadId: "root-thread",
    turnNumber: 1,
    eventType,
    event: { type: eventType, ...event },
  });
  const events = [
    record("2026-08-22T00:00:00.000Z", "ralph.phase-status", {
      action: "turn-start",
      phaseStatus: { stage: "pa1", phase: "implement", allRequiredPassed: false },
    }),
    record("2026-08-22T00:00:00.000Z", "ralph.prompt", { prompt: "Implement pa1" }),
    record("2026-08-22T00:01:00.000Z", "item.started", {
      item: { id: "child-1", type: "subagent", provider: "claude", status: "running" },
    }),
    record("2026-08-22T00:05:00.000Z", "item.completed", {
      item: {
        id: "child-1",
        type: "subagent",
        provider: "claude",
        status: "completed",
        duration_ms: 4 * 60 * 1000,
        model: "gpt-5.6-luna",
        usage: {
          input_tokens: 2000,
          cached_input_tokens: 1000,
          output_tokens: 200,
          reasoning_output_tokens: 100,
          total_tokens: 2200,
        },
      },
    }),
    record("2026-08-22T00:10:00.000Z", "turn.completed", {
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 500,
        output_tokens: 100,
        reasoning_output_tokens: 50,
        total_tokens: 1100,
      },
    }),
  ];

  try {
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT,
      "--format", "json",
      "--through", "pa1",
      "--codex-dir", codexDir,
      "--claude-dir", claudeDir,
      eventPath,
    ]);
    const comparison = JSON.parse(stdout);
    const summary = comparison.rows[0].runs[0];
    assert.equal(summary.durationMs, 10 * 60 * 1000);
    assert.equal(summary.activeDurationMs, 10 * 60 * 1000);
    assert.equal(summary.totalDurationMs, 14 * 60 * 1000);
    assert.equal(comparison.runs[0].total.activeDurationMs, 10 * 60 * 1000);
    assert.equal(comparison.runs[0].total.totalDurationMs, 14 * 60 * 1000);
    assert.equal(summary.cost, 0.00621);
    assert.equal(comparison.runs[0].total.cost, 0.00621);
    assert.equal(summary.usage.total_tokens, 3300);
    assert.deepEqual(
      summary.usage.model_usage.map(({ model, cost_usd }) => ({ model, cost_usd })),
      [
        { model: "gpt-5.6-luna", cost_usd: 0.00046 },
        { model: "gpt-5.6-sol", cost_usd: 0.00575 },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PA comparison prices each root turn with its phase agent model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-phase-model-test-"));
  const codexDir = path.join(directory, "codex", "sessions");
  const claudeDir = path.join(directory, "claude");
  const eventPath = path.join(directory, "run-claude-fable-5.jsonl");
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  const record = (recordedAt, eventType, event) => ({
    recordedAt,
    threadId: "luna-thread",
    turnNumber: 1,
    eventType,
    event: { type: eventType, ...event },
  });
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
    reasoning_output_tokens: 50,
    total_tokens: 1100,
  };
  const events = [
    record("2026-08-22T00:00:00.000Z", "ralph.phase-status", {
      action: "turn-start",
      phaseStatus: { stage: "pa1", phase: "implement", allRequiredPassed: false },
      agentProfile: {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
      },
    }),
    record("2026-08-22T00:00:00.000Z", "ralph.prompt", { prompt: "Implement pa1" }),
    record("2026-08-22T00:10:00.000Z", "turn.completed", { usage }),
  ];

  try {
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT,
      "--format", "json",
      "--through", "pa1",
      "--codex-dir", codexDir,
      "--claude-dir", claudeDir,
      eventPath,
    ]);
    const comparison = JSON.parse(stdout);
    const summary = comparison.rows[0].runs[0];
    assert.equal(summary.cost, 0.00023);
    assert.deepEqual(
      summary.usage.model_usage.map(({ model, cost_usd }) => ({ model, cost_usd })),
      [{ model: "gpt-5.6-luna", cost_usd: 0.00023 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
