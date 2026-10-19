import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
function browser() {
  const context = vm.createContext({ state: { progressBestCache: new Map() },
    window: { localStorage: { setItem() {} } }, PROGRESS_BEST_CACHE_LIMIT: 600,
    PROGRESS_BEST_STORAGE_KEY: "test-progress-cache" });
  for (const [file, binding] of [
    ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
    ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
    ["test-command-provenance.js", "TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
    ["turn-lifecycle.js", "TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
  ]) {
    vm.runInContext(readFileSync(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), context);
    vm.runInContext(`const ${binding};`, context);
  }
  for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) vm.runInContext(match[0], context);
  return context;
}
function status(total, passed, verified = false) {
  return { targetStage: "pa24", command: "make test-pa24", testsPassed: passed,
    testsTotal: total, allTestsPassed: passed === total, stages: [{ name: "pa24",
      status: passed === total ? "pass" : "fail", total, passed,
      ...(verified ? { totalFromReport: true } : {}) }] };
}
function record(testStatus) {
  return { eventType: "ralph.test-status", event: { testStatus } };
}

test("latest verified stage report replaces a larger inferred history total", () => {
  const b = browser();
  assert.equal(b.buildStageTotalAnchors([
    record(status(435, 295)), record(status(296, 296, true)),
    record(status(435, 295)), // Stale inferred evidence cannot restore the hint.
  ]).get("pa24"), 296);
  assert.equal(b.buildStageTotalAnchors([
    record(status(296, 296, true)), record(status(300, 299, true)),
  ]).get("pa24"), 300, "a genuinely expanded reported suite remains visible");
});

test("live tracker resets its denominator when a verified report arrives", () => {
  const b = browser();
  const tracker = { stageTotals: new Map() };
  b.seedAgentTestProgressTracker(tracker, record(status(435, 295)));
  assert.equal(tracker.stageTotals.get("pa24"), 435);
  b.seedAgentTestProgressTracker(tracker, record(status(296, 296, true)));
  assert.equal(tracker.stageTotals.get("pa24"), 296);
});

test("focused reports cannot replace a verified full-stage denominator", () => {
  const b = browser();
  const full = status(296, 296, true);
  const focused = { ...status(2, 2, true), command: "make -C pa24 check TEST=tests/example.t" };
  assert.equal(b.buildStageTotalAnchors([record(full), record(focused)]).get("pa24"), 296);
  const tracker = { stageTotals: new Map() };
  b.seedAgentTestProgressTracker(tracker, record(full));
  b.seedAgentTestProgressTracker(tracker, record(focused));
  assert.equal(tracker.stageTotals.get("pa24"), 296);
});

test("saved browser best with an obsolete total cannot override corrected progress", () => {
  const b = browser();
  const startedAt = "2026-10-19T14:03:00Z";
  const progress = total => ({ turn: 429, stage: "pa24", recordedAt: startedAt,
    start: { passed: total, total, recordedAt: startedAt },
    current: { passed: total, total }, best: { passed: total, total } });
  b.mergeProgressBestCache("scratch/run", progress(435));
  const corrected = b.mergeProgressBestCache("scratch/run", progress(296)).progress;
  assert.equal(corrected.current.total, 296);
  assert.equal(corrected.best.total, 296);
  assert.equal(corrected.best.passed, 296);
});
