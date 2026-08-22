import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/test-progress-evidence.js";

const {
  aggregateTargetEvidence,
  anchorPartialStageEvidence,
  directStageTestCommand,
  expandedProgressTargetTotal,
  targetEvidence,
} = globalThis.RALPH_TEST_PROGRESS_EVIDENCE;

test("fail-fast evidence preserves an unknown tail", () => {
  const evidence = targetEvidence({
    passed: 10,
    total: 45,
    status: "fail",
    mode: "fail-fast",
  });
  assert.deepEqual(evidence, {
    passed: 10,
    passedUpperBound: 44,
    total: 45,
    status: "fail",
    evidence: "fail-fast",
  });
  assert.deepEqual(aggregateTargetEvidence([evidence]), {
    passed: 10,
    passedUpperBound: 44,
    total: 45,
    unknown: 34,
    knownFailed: 1,
    status: "fail",
  });
});

test("aggregate evidence combines an exact prefix with a fail-fast target", () => {
  const exact = targetEvidence({ passed: 30, total: 30, status: "pass" });
  const partial = targetEvidence({
    passed: 10,
    total: 45,
    status: "fail",
    mode: "fail-fast",
  });
  assert.deepEqual(aggregateTargetEvidence([exact, partial]), {
    passed: 40,
    passedUpperBound: 74,
    total: 75,
    unknown: 34,
    knownFailed: 1,
    status: "fail",
  });
});

test("partial fail-fast sub-suite leaves the rest of its stage unknown", () => {
  const partial = targetEvidence({
    passed: 3,
    total: 7,
    status: "fail",
    mode: "fail-fast",
  });
  assert.deepEqual(anchorPartialStageEvidence(partial, 78), {
    passed: 3,
    passedUpperBound: 77,
    total: 78,
    unknown: 74,
    knownFailed: 1,
    status: "fail",
  });
});

test("partial exhaustive sub-suite preserves all of its known failures", () => {
  const partial = targetEvidence({ passed: 3, total: 7, status: "fail" });
  assert.deepEqual(anchorPartialStageEvidence(partial, 78), {
    passed: 3,
    passedUpperBound: 74,
    total: 78,
    unknown: 71,
    knownFailed: 4,
    status: "fail",
  });
});

test("recognizes direct stage tests and their fail-fast semantics", () => {
  assert.deepEqual(directStageTestCommand("make -C pa37 test"), {
    stage: "pa37",
    hasSubset: false,
    failFast: true,
  });
  assert.deepEqual(directStageTestCommand("make test-pa37"), {
    stage: "pa37",
    hasSubset: false,
    failFast: false,
  });
  assert.deepEqual(
    directStageTestCommand("KEEP_GOING=1 make -C /work/repo/pa37 test TEST=tests/a.t"),
    { stage: "pa37", hasSubset: true, failFast: false },
  );
  assert.equal(directStageTestCommand("make test-report-through-pa37"), null);
  assert.equal(directStageTestCommand("make -C pa37 test-driver-o2"), null);
});

test("configured stage totals allow modest full-stage growth", () => {
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 104,
    observedTotal: 108,
    priorStageTotal: 4756,
  }), 108);
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 108,
    baselineTotal: 104,
    observedTotal: 111,
    priorStageTotal: 4756,
  }), 111);
});

test("configured stage totals reject subsets, shrinkage, and full-run totals", () => {
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 104,
    observedTotal: 108,
    priorStageTotal: 4756,
    hasSubset: true,
  }), null);
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 104,
    observedTotal: 103,
    priorStageTotal: 4756,
  }), null);
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 104,
    observedTotal: 4864,
    priorStageTotal: 4756,
  }), null);
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 104,
    observedTotal: 200,
  }), null);
  assert.equal(expandedProgressTargetTotal({
    targetTotal: 130,
    baselineTotal: 104,
    observedTotal: 131,
  }), null);
});
