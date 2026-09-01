import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointReviewDue,
  checkpointReviewStateForTarget,
  markCheckpointReviewed,
  normalizeCheckpointReviewState,
  recordAcceptedCheckpoint,
} from "../checkpoint-review.js";

test("checkpoint review cadence counts accepted checkpoints for one target", () => {
  let state = null;
  for (let index = 1; index <= 4; index += 1) {
    state = recordAcceptedCheckpoint({
      checkpointReview: state,
      phase: "implement",
      stage: "pa17",
      turnNumber: index,
    });
    assert.equal(checkpointReviewDue(state, 4), index === 4);
  }

  assert.deepEqual(state, {
    phase: "implement",
    stage: "pa17",
    subset: null,
    acceptedSinceReview: 4,
    acceptedTotal: 4,
    lastAcceptedTurnNumber: 4,
  });

  state = markCheckpointReviewed(state);
  assert.equal(state.acceptedSinceReview, 0);
  assert.equal(state.acceptedTotal, 4);
  assert.equal(checkpointReviewDue(state, 4), false);

  state = recordAcceptedCheckpoint({
    checkpointReview: state,
    phase: "implement",
    stage: "pa17",
    turnNumber: 5,
  });
  assert.equal(state.acceptedSinceReview, 1);
  assert.equal(state.acceptedTotal, 5);
});

test("checkpoint review cadence resets when the target changes", () => {
  const pa17 = recordAcceptedCheckpoint({
    checkpointReview: null,
    phase: "implement",
    stage: "pa17",
    subset: "course",
    turnNumber: 2,
  });
  const pa18 = recordAcceptedCheckpoint({
    checkpointReview: pa17,
    phase: "implement",
    stage: "pa18",
    subset: "course",
    turnNumber: 3,
  });

  assert.equal(checkpointReviewStateForTarget(pa17, {
    phase: "implement",
    stage: "pa18",
    subset: "course",
  }), null);
  assert.deepEqual(pa18, {
    phase: "implement",
    stage: "pa18",
    subset: "course",
    acceptedSinceReview: 1,
    acceptedTotal: 1,
    lastAcceptedTurnNumber: 3,
  });
});

test("invalid persisted checkpoint review state is ignored", () => {
  assert.equal(normalizeCheckpointReviewState(null), null);
  assert.equal(normalizeCheckpointReviewState({
    phase: "implement",
    stage: "pa17",
    acceptedSinceReview: 3,
    acceptedTotal: 2,
  }), null);
  assert.equal(checkpointReviewDue({
    phase: "implement",
    stage: "pa17",
    acceptedSinceReview: 1,
    acceptedTotal: 1,
  }, 0), false);
});
