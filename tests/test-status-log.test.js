import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import {
  augmentLatestTestStatusFromLog,
  deriveTestStatusFromReportOutput,
} from "../ralph-viz/server.js";

const baseline = {
  recordedAt: "2026-10-02T04:58:03.923Z",
  command: "make test-pa32", targetStage: "pa32", targetSubset: null, exitCode: 2,
  testsPassed: 0, testsPassedUpperBound: 0, testsTotal: 425,
  stages: [{ name: "pa32", status: "fail", passed: 0, passedUpperBound: 0,
    total: 425, failed: 219, targets: [] }],
};
const report = (passed) => "===== pa32 =====\n" +
  "pa32/tests/o0/case.t: ERROR: got EXIT_NOT_IMPLEMENTED\n" +
  `===== TEST SUMMARY: ${passed} / 219 TESTS PASSED =====\n`;

test("explicit zero aggregate overrides inflated historical stage totals", () => {
  const status = deriveTestStatusFromReportOutput(report(0), baseline);
  assert.equal(status.testsPassed, 0);
  assert.equal(status.testsPassedUpperBound, 0);
  assert.equal(status.testsTotal, 219);
  assert.equal(status.stages[0].passed, 0);
  assert.equal(status.stages[0].passedUpperBound, 0);
  assert.equal(status.stages[0].total, 219);
  assert.equal(status.stages[0].failed, 219);
});

test("explicit partial aggregate does not count absent failure diagnostics as passes", () => {
  const status = deriveTestStatusFromReportOutput(report(82), baseline);
  assert.equal(status.testsPassedUpperBound, 82);
  assert.equal(status.testsUnknown, 0);
  assert.equal(status.stages[0].passed, 82);
  assert.equal(status.stages[0].passedUpperBound, 82);
  assert.equal(status.stages[0].failed, 137);
});

test("explicit full pass uses the report total rather than historical hints", () => {
  const status = deriveTestStatusFromReportOutput(
    "===== pa32 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (219 / 219) =====\n", baseline);
  assert.equal(status.stages[0].status, "pass");
  assert.equal(status.stages[0].passed, 219);
  assert.equal(status.stages[0].passedUpperBound, 219);
  assert.equal(status.stages[0].total, 219);
  assert.equal(status.stages[0].failed, 0);
});

test("multi-stage failure lines do not invent passes when stage evidence is missing", () => {
  const status = deriveTestStatusFromReportOutput(
    "===== pa31 =====\n===== pa32 =====\n" +
      "pa32/tests/case.t: ERROR: output does not match\n" +
      "===== TEST SUMMARY: 84 / 303 TESTS PASSED =====\n",
    { ...baseline, stages: [
      { name: "pa31", status: "pass", total: 84, passed: 84 },
      { name: "pa32", status: "fail", total: 425 },
    ] },
  );
  assert.equal(status.stages[0].passed, 84);
  assert.equal(status.stages[1].passed, 0);
  assert.equal(status.stages[1].unknown, 424);
});

test("uncounted all-pass reports retain known stage totals", () => {
  const status = deriveTestStatusFromReportOutput(
    "===== pa32 =====\n===== ALL TESTS PASSED SUCCESSFULLY! =====\n", baseline);
  assert.equal(status.stages[0].passed, 425);
  assert.equal(status.stages[0].total, 425);
  assert.equal(status.reportSummaryHasCounts, false);
});

test("a report for a different stage cannot replace the current stage", () => {
  assert.equal(deriveTestStatusFromReportOutput(
    "===== pa31 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (84 / 84) =====\n",
    baseline), null);
});

test("report augmentation keeps the same check's baseline consistent in browser progress", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ralph-status-log-"));
  try {
    await mkdir(path.join(temp, "events"));
    await writeFile(path.join(temp, "last-test.log"), report(0));
    const earlier = { ...structuredClone(baseline), recordedAt: "2026-10-02T04:00:00.000Z",
      command: "make test-pa31", targetStage: "pa31",
      stages: [{ ...baseline.stages[0], name: "pa31" }] };
    const records = [
      { eventType: "ralph.phase-status", turnNumber: 206,
        event: { phaseStatus: { stage: "pa31", testStatus: earlier } } },
      { eventType: "ralph.phase-status", turnNumber: 207,
        recordedAt: "2026-10-02T04:58:19.526Z",
        event: { action: "turn-start", phaseStatus: { stage: "pa32",
          testStatus: structuredClone(baseline),
          checks: [{ testStatus: structuredClone(baseline) }] } } },
      { eventType: "ralph.test-status", turnNumber: 207,
        recordedAt: "2026-10-02T04:58:19.526Z",
        event: { testStatus: structuredClone(baseline) } },
      { eventType: "ralph.agent-progress", turnNumber: 207,
        recordedAt: "2026-10-02T05:02:47.820Z",
        event: { progress: { stage: "pa32", passed: 82, passedUpperBound: 82,
          total: 219, status: "fail", commandKind: "single", commandTarget: "test-pa32" } } },
    ];
    await augmentLatestTestStatusFromLog(records, path.join(temp, "events", "run.jsonl"));
    assert.equal(earlier.testsTotal, 425, "a different check must retain its original evidence");
    assert.equal(records[1].event.phaseStatus.testStatus.testsTotal, 219);
    assert.equal(records[1].event.phaseStatus.checks[0].testStatus.testsTotal, 219);

    const browser = vm.createContext({ state: { progressBestCache: new Map() } });
    for (const [file, binding] of [
      ["entry-dedupe.js", "ENTRY_DEDUPE=RALPH_ENTRY_DEDUPE"],
      ["turn-lifecycle.js", "TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
      ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
      ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
      ["test-command-provenance.js", "TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
      ["assignment-layouts.js", "ASSIGNMENT_LAYOUT=RALPH_ASSIGNMENT_LAYOUT"],
    ]) {
      vm.runInContext(await readFile(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), browser);
      vm.runInContext(`const ${binding};`, browser);
    }
    const app = await readFile(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
    for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) {
      vm.runInContext(match[0], browser);
    }
    const progress = browser.buildAgentTestProgressState(records).latest;
    assert.equal(progress.start.passed, 0);
    assert.equal(progress.current.passed, 82);
    assert.equal(progress.best.passed, 82, "the invented 206-pass peak must disappear");
    assert.equal(progress.current.total, 219);
    assert.equal(progress.start.total, 219);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
