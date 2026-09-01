function normalizedSubset(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

export function normalizeCheckpointReviewState(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const phase = typeof value.phase === "string" ? value.phase.trim() : "";
  const stage = typeof value.stage === "string" ? value.stage.trim() : "";
  const acceptedSinceReview = Number.isInteger(value.acceptedSinceReview)
    ? value.acceptedSinceReview
    : -1;
  const acceptedTotal = Number.isInteger(value.acceptedTotal)
    ? value.acceptedTotal
    : -1;
  if (!phase || !stage || acceptedSinceReview < 0 || acceptedTotal < acceptedSinceReview) {
    return null;
  }
  return {
    phase,
    stage,
    subset: normalizedSubset(value.subset),
    acceptedSinceReview,
    acceptedTotal,
    lastAcceptedTurnNumber: Number.isInteger(value.lastAcceptedTurnNumber)
      ? value.lastAcceptedTurnNumber
      : null,
  };
}

export function checkpointReviewStateForTarget(value, { phase, stage, subset = null }) {
  const state = normalizeCheckpointReviewState(value);
  if (!state || state.phase !== phase || state.stage !== stage ||
      state.subset !== normalizedSubset(subset)) {
    return null;
  }
  return state;
}

export function recordAcceptedCheckpoint({
  checkpointReview,
  phase,
  stage,
  subset = null,
  turnNumber = null,
}) {
  const current = checkpointReviewStateForTarget(checkpointReview, {
    phase,
    stage,
    subset,
  }) ?? {
    phase,
    stage,
    subset: normalizedSubset(subset),
    acceptedSinceReview: 0,
    acceptedTotal: 0,
    lastAcceptedTurnNumber: null,
  };
  return {
    ...current,
    acceptedSinceReview: current.acceptedSinceReview + 1,
    acceptedTotal: current.acceptedTotal + 1,
    lastAcceptedTurnNumber: Number.isInteger(turnNumber) ? turnNumber : null,
  };
}

export function checkpointReviewDue(value, every) {
  const state = normalizeCheckpointReviewState(value);
  return Boolean(state && Number.isInteger(every) && every > 0 &&
    state.acceptedSinceReview >= every);
}

export function markCheckpointReviewed(value) {
  const state = normalizeCheckpointReviewState(value);
  return state ? { ...state, acceptedSinceReview: 0 } : null;
}
