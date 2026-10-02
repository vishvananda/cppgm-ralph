import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
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

async function browserHelpers() {
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
  return browser;
}

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
    const earlier = { ...structuredClone(baseline), recordedAt: "2026-10-02T04:00:00.000Z" };
    const records = [
      { eventType: "ralph.phase-status", turnNumber: 206,
        event: { phaseStatus: { stage: "pa32", testStatus: earlier } } },
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

    const browser = await browserHelpers();
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

test("historical totals cannot enlarge the current turn's explicit report or its complete pass", async () => {
  const browser = await browserHelpers();
  const start = { ...baseline, ...deriveTestStatusFromReportOutput(report(213), baseline) };
  const records = [
    { eventType: "ralph.test-status", turnNumber: 216,
      recordedAt: "2026-10-02T13:05:35.518Z", event: { testStatus: baseline } },
    { eventType: "ralph.phase-status", turnNumber: 217,
      recordedAt: "2026-10-02T13:06:29.857Z",
      event: { action: "turn-start", phaseStatus: { stage: "pa32", testStatus: start } } },
    { eventType: "item.completed", turnNumber: 217,
      recordedAt: "2026-10-02T13:27:47.391Z", event: { item: {
        id: "complete-stage", type: "command_execution", command: "make test-pa32", exit_code: 0,
        aggregated_output: "===== pa32 =====\n" +
          "pa32 object-roundtrip: PASS (25/25)\n" +
          "===== ALL TESTS PASSED SUCCESSFULLY! (219 / 219) =====\n",
      } } },
  ];
  assert.equal(browser.buildStageTotalAnchors(records).get("pa32"), 425,
    "the fixture must retain the older inflated hint");
  const progress = browser.buildAgentTestProgressState(records).latest;
  assert.equal(progress.start.passed, 213);
  assert.equal(progress.start.passedUpperBound, 213);
  assert.equal(progress.start.total, 219);
  assert.equal(progress.current.passed, 219);
  assert.equal(progress.current.total, 219);
  assert.equal(progress.best.passed, 219);
  assert.equal(progress.best.total, 219);
  assert.equal(browser.buildTestStatusMap(records).get(217).testsTotal, 219);
  const inferred = browser.inferCurrentFullRunStatus(start, progress);
  assert.equal(inferred.testsPassed, 219);
  assert.equal(inferred.testsTotal, 219);
});

test("command-derived counted reports keep their own denominator despite historical anchors", async () => {
  const browser = await browserHelpers();
  const record = { eventType: "item.completed", turnNumber: 217,
    recordedAt: "2026-10-02T13:27:47.391Z", event: { item: {
      id: "complete-stage", type: "command_execution", command: "make test-pa32", exit_code: 0,
      aggregated_output: "===== pa32 =====\n===== TEST SUMMARY: 219 / 219 TESTS PASSED =====\n",
    } } };
  const derived = browser.deriveTestStatusFromCommand(record);
  const anchors = vm.runInContext('new Map([["pa32", 425]])', browser);
  const anchored = browser.anchorTestStatusTotals(derived, anchors);
  assert.equal(anchored.allTestsPassed, true);
  assert.equal(anchored.testsPassed, 219);
  assert.equal(anchored.testsTotal, 219);
  assert.equal(anchored.stages[0].total, 219);
  assert.equal(anchored.stages[0].passed, 219);
  const progress = browser.inferSelectedReportSummaryProgress(
    record.event.item.aggregated_output,
    browser.parseAgentTestCommand("make test-pa32"),
    { stageTotals: anchors }, 0,
  );
  assert.equal(progress.total, 219);
  assert.equal(progress.passed, 219);
});

test("partial stage evidence still uses a full-stage total when no counted report is available", async () => {
  const browser = await browserHelpers();
  const partial = { targetStage: "pa32", testsPassed: 3, testsTotal: 25,
    stages: [{ name: "pa32", status: "fail", passed: 3, passedUpperBound: 3, total: 25 }] };
  const anchors = vm.runInContext('new Map([["pa32", 219]])', browser);
  const anchored = browser.anchorTestStatusTotals(partial, anchors);
  assert.equal(anchored.testsPassed, 3);
  assert.equal(anchored.testsTotal, 219);
  assert.equal(anchored.stages[0].passedUpperBound, 197);
});

async function auditFixture(passed = 219, stageReportTotal = 219) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ralph-audit-total-"));
  await mkdir(path.join(temp, "events"));
  await mkdir(path.join(temp, "checks"));
  const headers = "===== pa1 =====\n===== pa2 =====\n";
  const output = passed === 219
    ? headers + "===== ALL TESTS PASSED SUCCESSFULLY! (319 / 319) =====\n"
    : headers + "pa2/tests/case.t: ERROR: output does not match\n" +
      `===== TEST SUMMARY: ${100 + passed} / 319 TESTS PASSED =====\n`;
  await writeFile(path.join(temp, "last-test.log"), output);
  await writeFile(path.join(temp, "checks", "last-stageTests.log"),
    `===== pa2 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (${stageReportTotal} / ${stageReportTotal}) =====\n`);
  await writeFile(path.join(temp, "checks", "last-priorThroughTests.log"),
    "===== pa1 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (100 / 100) =====\n");
  for (const [name, time] of [
    ["stageTests", "2026-10-02T13:47:28.837Z"],
    ["priorThroughTests", "2026-10-02T13:47:16.348Z"],
  ]) {
    await utimes(path.join(temp, "checks", `last-${name}.log`), new Date(time), new Date(time));
  }
  const stage = { name: "pa2", status: "pass", passed: 425, passedUpperBound: 425,
    total: 425, failed: 0 };
  const stageStatus = { command: "make test-pa2", targetStage: "pa2", targetSubset: null,
    recordedAt: "2026-10-02T13:47:28.837Z", exitCode: 0, allTestsPassed: true,
    stageCount: 1, testsPassed: 425, testsTotal: 425, reportSummaryHasCounts: true,
    stages: [stage] };
  const priorStatus = { command: "make test-report-through-pa1", targetStage: "pa2",
    targetSubset: null, recordedAt: "2026-10-02T13:47:16.348Z", exitCode: 0,
    allTestsPassed: true, testsPassed: 150, testsTotal: 150, stageCount: 1,
    stages: [{ name: "pa1", status: "pass", passed: 150, total: 150 }] };
  const throughStatus = { command: "make test-report-through-pa2", targetStage: "pa2",
    targetSubset: null, recordedAt: "2026-10-02T13:48:05.714Z", exitCode: passed === 219 ? 0 : 2,
    allTestsPassed: passed === 219, reportSummaryHasCounts: true,
    testsPassed: 100 + passed, testsTotal: 319, stageCount: 2,
    stages: [{ name: "pa1", status: "pass", passed: 100, total: 100 }, stage] };
  const records = [
    { eventType: "ralph.phase-status", turnNumber: 217,
      recordedAt: "2026-10-02T13:47:28.837Z", event: { action: "checked", phaseStatus: {
        stage: "pa2", testStatus: structuredClone(stageStatus), checks: [
          { name: "stageTests", testStatus: structuredClone(stageStatus) },
          { name: "priorThroughTests", testStatus: structuredClone(priorStatus) },
        ],
      } } },
    { eventType: "ralph.test-status", turnNumber: 217,
      recordedAt: "2026-10-02T13:47:28.837Z", event: { testStatus: structuredClone(stageStatus) } },
    { eventType: "ralph.phase-status", turnNumber: 218,
      recordedAt: "2026-10-02T13:48:06.959Z", event: { action: "turn-start", phaseStatus: {
        stage: "pa2", testStatus: structuredClone(throughStatus),
        checks: [{ name: "tests", testStatus: structuredClone(throughStatus) }],
      } } },
    { eventType: "ralph.test-status", turnNumber: 218,
      recordedAt: "2026-10-02T13:48:06.959Z", event: { testStatus: structuredClone(throughStatus) } },
  ];
  return { temp, records };
}

for (const passed of [219, 213]) {
  test(`audit progress uses ${passed}/219 from consistent stage and through-report counts`, async () => {
    const { temp, records } = await auditFixture(passed);
    try {
      await augmentLatestTestStatusFromLog(records, path.join(temp, "events", "run.jsonl"));
      const latest = records.at(-1).event.testStatus;
      assert.equal(latest.testsTotal, 319);
      assert.equal(latest.stages.at(-1).total, 219);
      assert.equal(latest.stages.at(-1).passed, passed);
      assert.equal(latest.stages.at(-1).totalFromReport, true);
      assert.equal(records[0].event.phaseStatus.testStatus.testsTotal, 219);
      assert.equal(records[0].event.phaseStatus.checks[1].testStatus.testsTotal, 100);
      const browser = await browserHelpers();
      const progress = browser.buildAgentTestProgressState(records).latest;
      assert.equal(progress.turn, 218);
      assert.equal(progress.current.total, 219);
      assert.equal(progress.current.passed, passed);
      assert.equal(progress.start.total, 219);
      assert.equal(progress.best.total, 219);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}

test("an inconsistent older stage report cannot override an audit's stage total", async () => {
  const { temp, records } = await auditFixture(219, 220);
  try {
    await augmentLatestTestStatusFromLog(records, path.join(temp, "events", "run.jsonl"));
    const latest = records.at(-1).event.testStatus;
    assert.equal(latest.testsTotal, 319);
    assert.equal(latest.stages.at(-1).total, 425);
    assert.equal(latest.stages.at(-1).totalFromReport, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a dedicated check log cannot replace a historical check from another time", async () => {
  const { temp, records } = await auditFixture();
  try {
    const newer = new Date("2026-10-02T14:00:00.000Z");
    await utimes(path.join(temp, "checks", "last-stageTests.log"), newer, newer);
    await augmentLatestTestStatusFromLog(records, path.join(temp, "events", "run.jsonl"));
    assert.equal(records[0].event.phaseStatus.testStatus.testsTotal, 425);
    assert.equal(records[0].event.phaseStatus.checks[0].testStatus.testsTotal, 425);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
