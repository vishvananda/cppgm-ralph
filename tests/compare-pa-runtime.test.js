import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve("scripts/compare-pa-costs.js");

test("PA comparison separates active runtime from additive subagent time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-runtime-test-"));
  const codexDir = path.join(directory, "codex", "sessions");
  const claudeDir = path.join(directory, "claude");
  const eventPath = path.join(directory, "run.jsonl");
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
      },
    }),
    record("2026-08-22T00:10:00.000Z", "turn.completed", { usage: {} }),
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
