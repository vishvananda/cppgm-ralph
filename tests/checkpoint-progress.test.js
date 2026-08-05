import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePendingCheckpointProgress,
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
