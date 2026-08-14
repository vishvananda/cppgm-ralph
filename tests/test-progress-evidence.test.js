import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/test-progress-evidence.js";

const {
  aggregateTargetEvidence,
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
