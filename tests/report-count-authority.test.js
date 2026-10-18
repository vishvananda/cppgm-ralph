import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import "../ralph-viz/test-progress-evidence.js";
import { evaluateStageProgress } from "../checkpoint-progress.js";

const source = readFileSync(new URL("../ralph.js", import.meta.url), "utf8");
function parser(total = 1427) {
  const hints = new Map([["pa35", { name: "pa35", status: "pass", passed: total, total }]]);
  const context = vm.createContext({
    TEST_PROGRESS_EVIDENCE: globalThis.RALPH_TEST_PROGRESS_EVIDENCE,
    STAGE_COUNT_HINTS: hints, getPrimaryCheck: () => ({ command: "make -C pa35 test-progress" }),
  });
  const start = source.indexOf("function analyzeTestProgress(");
  vm.runInContext(source.slice(start, source.indexOf("function buildTestStatusLines(", start)), context);
  for (const name of ["normalizeStageName", "normalizeTestSubset", "addStageCountHintsFromTestStatus",
    "addInferredStageCountHintFromStatus"]) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], context);
  }
  return { hints, context, parse: (output, options = {}) => context.analyzeTestProgress(output, null, {
    targetStage: "pa35", command: "make -C pa35 test-progress", exitCode: 1, ...options,
  }) };
}
function report(total = 1389, passed = 173) {
  return `===== pa35 =====\ncorrectness: PASS (3/3)\n` +
    `performance: FAIL (${passed - 3}/${total - 3})\n` +
    `===== TEST SUMMARY: ${passed} / ${total} TESTS PASSED =====\n`;
}

test("a reconciled complete report replaces the inherited rung total", () => {
  const { parse, hints } = parser();
  const status = parse(report());
  assert.equal(status.testsTotal, 1389);
  assert.equal(status.testsPassed, 173);
  assert.equal(status.testsPassedUpperBound, 173);
  assert.equal(status.stages[0].total, 1389);
  assert.equal(status.stages[0].totalFromReport, true);
  assert.equal(hints.get("pa35").total, 1389);
  const partial = parse("===== pa35 =====\nperformance: FAIL after 2/44 passed\n");
  assert.equal(partial.testsTotal, 1389);
  assert.equal(partial.testsPassedUpperBound, 1388);
});

test("unchanged and expanded complete suites retain their actual counts", () => {
  for (const total of [1427, 1500]) {
    const { parse, hints } = parser();
    assert.equal(parse(report(total)).testsTotal, total);
    assert.equal(hints.get("pa35").total, total);
  }
});

test("incomplete and fail-fast reports retain historical coverage", () => {
  for (const output of [
    "===== pa35 =====\nperformance: FAIL after 2/44 passed\n",
    "===== pa35 =====\nperformance: running 44 tests\n",
    report().replace("173 / 1389", "173 / 1400"),
    report().replace("FAIL (170/1386)", "FAIL after 170/1386 passed"),
  ]) {
    const { parse, hints } = parser();
    const status = parse(output);
    assert.equal(status.testsTotal, 1427);
    assert.notEqual(status.stages[0].totalFromReport, true);
    assert.equal(hints.get("pa35").total, 1427);
  }
});

test("focused commands cannot replace the whole-stage hint", () => {
  for (const options of [{ targetSubset: "smoke" },
    { command: "make test-pa35 GLOB=tests/smoke.t" },
    { command: "make -C pa35 check TEST=tests/smoke.t" }]) {
    const { parse, hints } = parser();
    const status = parse(report(2, 2).replace("correctness: PASS (3/3)\n", "")
      .replace("performance: FAIL (-1/-1)", "performance: PASS (2/2)"), options);
    assert.notEqual(status.stages[0].totalFromReport, true);
    assert.equal(hints.get("pa35").total, 1427);
  }
});

test("reduced real coverage remains visible to the checkpoint guard", () => {
  const baseline = parser().parse(report(1427));
  const current = parser().parse(report());
  assert.equal(evaluateStageProgress({ baselineTestStatus: baseline,
    currentTestStatus: current, stage: "pa35" }).reason, "coverage-reduced");
});

test("loading a later authoritative report replaces an older high-water hint", () => {
  const { context } = parser();
  const hints = new Map();
  for (const total of [1427, 1389]) {
    const status = parser(total).parse(report(total));
    context.addStageCountHintsFromTestStatus(hints, status);
  }
  assert.equal(hints.get("pa35").total, 1389);
});

function browser() {
  const context = vm.createContext({});
  for (const [file, binding] of [
    ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
    ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
    ["test-command-provenance.js", "TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
    ["turn-lifecycle.js", "TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
  ]) {
    vm.runInContext(readFileSync(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), context);
    vm.runInContext(`const ${binding};`, context);
  }
  const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
  for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) vm.runInContext(match[0], context);
  return context;
}

test("viewer keeps inherited history and the fork's current denominator distinct", () => {
  const records = [];
  for (const [turn, total] of [[366, 1427], [367, 1389], [368, 1389]]) {
    const status = parser(total).parse(report(total));
    status.recordedAt = `2026-10-18T${turn - 351}:00:00Z`;
    records.push({ recordedAt: status.recordedAt, turnNumber: turn,
      eventType: "ralph.phase-status", event: { action: "turn-start",
        phaseStatus: { phase: "implement", stage: "pa35", testStatus: status } } });
    records.push({ recordedAt: status.recordedAt, turnNumber: turn,
      eventType: "ralph.test-status", event: { testStatus: status } });
  }
  const progress = browser().buildAgentTestProgressState(records);
  assert.equal(progress.byTurn.get(366).current.total, 1427);
  assert.equal(progress.byTurn.get(367).current.total, 1389);
  assert.equal(progress.latest.current.total, 1389);
  assert.equal(progress.latest.current.passed, 173);
  assert.equal(progress.latest.best.total, 1389);
});
