import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePendingCheckpointProgress,
  evaluateStageProgress,
  normalizePendingCheckpoint,
  updatePendingCheckpoint,
} from "../checkpoint-progress.js";

function status(passed, total = 69, stage = "pa25") {
  return {
    stages: [{
      name: stage,
      status: passed >= total ? "pass" : "fail",
      passed,
      total,
    }],
  };
}

test("checkpoint progress survives a blocker recovery without accepting regression", () => {
  const pending = updatePendingCheckpoint({
    pendingCheckpoint: null,
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(16),
    currentTestStatus: status(46),
    turnNumber: 134,
  });

  assert.deepEqual(pending, {
    phase: "implement",
    stage: "pa25",
    subset: null,
    baselinePassed: 16,
    achievedPassed: 46,
    total: 69,
    createdTurnNumber: 134,
    updatedTurnNumber: 134,
  });
  assert.equal(evaluatePendingCheckpointProgress({
    pendingCheckpoint: pending,
    phase: "implement",
    stage: "pa25",
    currentPassed: 46,
    currentTotal: 69,
  }).passed, true);
  assert.equal(evaluatePendingCheckpointProgress({
    pendingCheckpoint: pending,
    phase: "implement",
    stage: "pa25",
    currentPassed: 45,
    currentTotal: 69,
  }).passed, false);
});

test("checkpoint watermark advances monotonically and clears on completion", () => {
  const initial = updatePendingCheckpoint({
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(16),
    currentTestStatus: status(46),
    turnNumber: 134,
  });
  const regressed = updatePendingCheckpoint({
    pendingCheckpoint: initial,
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(46),
    currentTestStatus: status(40),
    turnNumber: 135,
  });
  assert.deepEqual(regressed, initial);

  const advanced = updatePendingCheckpoint({
    pendingCheckpoint: initial,
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(46),
    currentTestStatus: status(52),
    turnNumber: 135,
  });
  assert.equal(advanced.baselinePassed, 16);
  assert.equal(advanced.achievedPassed, 52);
  assert.equal(advanced.updatedTurnNumber, 135);

  assert.equal(updatePendingCheckpoint({
    pendingCheckpoint: advanced,
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: true,
    baselineTestStatus: status(52),
    currentTestStatus: status(69),
    turnNumber: 136,
  }), null);
});

test("malformed and mismatched checkpoint state is ignored", () => {
  assert.equal(normalizePendingCheckpoint({
    phase: "implement",
    stage: "pa25",
    baselinePassed: 46,
    achievedPassed: 46,
    total: 69,
  }), null);

  const pending = updatePendingCheckpoint({
    phase: "implement",
    stage: "pa25",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(16),
    currentTestStatus: status(46),
    turnNumber: 134,
  });
  assert.equal(evaluatePendingCheckpointProgress({
    pendingCheckpoint: pending,
    phase: "implement",
    stage: "pa26",
    currentPassed: 46,
    currentTotal: 69,
  }), null);
  assert.equal(evaluatePendingCheckpointProgress({
    pendingCheckpoint: pending,
    phase: "implement",
    stage: "pa25",
    currentPassed: 46,
    currentTotal: 70,
  }).totalMatches, false);
});

test("adding passing tests does not count as implementation progress", () => {
  const result = evaluateStageProgress({
    baselineTestStatus: status(503, 505, "pa23"),
    currentTestStatus: status(506, 508, "pa23"),
    stage: "pa23",
    mode: "improve",
  });

  assert.equal(result.passed, false);
  assert.equal(result.reason, "failures-not-reduced");
  assert.equal(result.baseline.knownFailed, 2);
  assert.equal(result.current.knownFailed, 2);
});

test("progress requires fewer failures with nondecreasing test coverage", () => {
  assert.equal(evaluateStageProgress({
    baselineTestStatus: status(494, 496, "pa23"),
    currentTestStatus: status(498, 499, "pa23"),
    stage: "pa23",
    mode: "improve",
  }).passed, true);

  const removedFailure = evaluateStageProgress({
    baselineTestStatus: status(494, 496, "pa23"),
    currentTestStatus: status(494, 495, "pa23"),
    stage: "pa23",
    mode: "improve",
  });
  assert.equal(removedFailure.passed, false);
  assert.equal(removedFailure.reason, "coverage-reduced");

  const incompletePass = evaluateStageProgress({
    baselineTestStatus: status(494, 496, "pa23"),
    currentTestStatus: status(495, 495, "pa23"),
    stage: "pa23",
    mode: "improve",
  });
  assert.equal(incompletePass.passed, false);
  assert.equal(incompletePass.reason, "coverage-reduced");
});

test("preserve mode permits added passing tests but not new failures", () => {
  assert.equal(evaluateStageProgress({
    baselineTestStatus: status(494, 496, "pa23"),
    currentTestStatus: status(497, 499, "pa23"),
    stage: "pa23",
    mode: "preserve",
  }).passed, true);
  assert.equal(evaluateStageProgress({
    baselineTestStatus: status(494, 496, "pa23"),
    currentTestStatus: status(496, 499, "pa23"),
    stage: "pa23",
    mode: "preserve",
  }).passed, false);
});

test("bounded fail-fast evidence cannot satisfy a progress gate", () => {
  const current = status(10, 45, "pa23");
  current.stages[0].passedUpperBound = 44;
  const result = evaluateStageProgress({
    baselineTestStatus: status(40, 45, "pa23"),
    currentTestStatus: current,
    stage: "pa23",
    mode: "improve",
  });
  assert.equal(result.passed, false);
  assert.equal(result.reason, "inexact-counts");
});

test("bounded fail-fast evidence cannot establish or preserve a pending checkpoint", () => {
  const baseline = status(10, 45, "pa23");
  baseline.stages[0].passedUpperBound = 44;
  const current = status(11, 45, "pa23");
  current.stages[0].passedUpperBound = 44;
  assert.equal(updatePendingCheckpoint({
    phase: "implement",
    stage: "pa23",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: baseline,
    currentTestStatus: current,
    turnNumber: 1,
  }), null);

  const pending = updatePendingCheckpoint({
    phase: "implement",
    stage: "pa23",
    checkpointEnabled: true,
    phaseAttempted: true,
    primaryPassed: false,
    baselineTestStatus: status(40, 45, "pa23"),
    currentTestStatus: status(41, 45, "pa23"),
    turnNumber: 1,
  });
  const evaluation = evaluatePendingCheckpointProgress({
    pendingCheckpoint: pending,
    phase: "implement",
    stage: "pa23",
    currentPassed: 10,
    currentPassedUpperBound: 44,
    currentTotal: 45,
  });
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.totalMatches, true);
  assert.equal(evaluation.exact, false);
});
