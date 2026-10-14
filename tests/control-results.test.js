import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import "../ralph-viz/test-progress-evidence.js";
import { deriveTestStatusFromReportOutput } from "../ralph-viz/server.js";
import { evaluateStageProgress } from "../checkpoint-progress.js";

const source = readFileSync(new URL("../ralph.js", import.meta.url), "utf8");
function parse(output, exitCode = 2) {
  const context = vm.createContext({
    TEST_PROGRESS_EVIDENCE: globalThis.RALPH_TEST_PROGRESS_EVIDENCE,
    STAGE_COUNT_HINTS: new Map(), getPrimaryCheck: () => ({ command: "make test-pa12" }),
  });
  const start = source.indexOf("function analyzeTestProgress(");
  vm.runInContext(source.slice(start, source.indexOf("function buildTestStatusLines(", start)), context);
  for (const name of ["normalizeStageName", "normalizeTestSubset"]) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], context);
  }
  return context.analyzeTestProgress(output, null, {
    targetStage: "pa12", command: "make test-pa12", exitCode,
  });
}
const summary = "===== TEST SUMMARY: 316 / 316 TESTS PASSED =====\n";
const legacy = "===== pa12 =====\n" +
  "tests/controls/536-parameter-object-extent-boundary.cpp: source-to-LowIR compile failed\n" +
  "cppgm++: no viable built-in conversion\n" + summary;

test("legacy control failure remains visible beside passing ordinary counts", () => {
  const result = parse(legacy);
  assert.equal(result.allTestsPassed, false);
  assert.equal(result.failingStage, "pa12");
  assert.equal(result.stages[0].status, "fail");
  assert.equal(result.testsPassed, 316);
  assert.match(result.firstFailureLine, /controls.*compile failed/);
  const viewer = deriveTestStatusFromReportOutput(legacy, result);
  assert.equal(viewer.stages[0].status, "fail");
  assert.equal(viewer.stages[0].failed, 1);
  assert.match(viewer.firstFailureLine, /controls/);
});

test("a nonzero command cannot complete a fully counted stage or count as progress", () => {
  const result = parse("===== pa12 =====\n" + summary);
  assert.equal(result.stages[0].status, "fail");
  for (const mode of ["improve", "preserve"]) {
    const progress = evaluateStageProgress({ baselineTestStatus: result,
      currentTestStatus: result, stage: "pa12", mode });
    assert.equal(progress.passed, false);
    assert.equal(progress.reason, "uncounted-failure");
  }
});

test("the control test shape contributes its ordinary counted lane", () => {
  const result = parse("===== pa12 =====\npa12 tests: PASS (316/316)\n" +
    "pa12 tests/controls: FAIL (42/43)\n" +
    "pa12/tests/controls/200-extent.t: ERROR: control predicate failed\n" +
    "===== TEST SUMMARY: 358 / 359 TESTS PASSED =====\n");
  assert.equal(result.testsPassed, 358);
  assert.equal(result.testsTotal, 359);
  assert.equal(result.stages[0].targets.find(row => row.name.endsWith("controls")).status, "fail");
  assert.equal(result.failingStage, "pa12");
});
