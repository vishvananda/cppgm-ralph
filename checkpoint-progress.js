function normalizedTargetPart(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function stageSnapshot(testStatus, stage) {
  const entry = (testStatus?.stages ?? []).find((candidate) => candidate?.name === stage);
  if (!entry) {
    return null;
  }
  const passed = normalizedCount(entry.passed);
  const total = normalizedCount(entry.total);
  if (passed == null || total == null || passed > total) {
    return null;
  }
  return { passed, total, complete: entry.status === "pass" && passed >= total };
}

export function normalizePendingCheckpoint(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const phase = normalizedTargetPart(value.phase);
  const stage = normalizedTargetPart(value.stage);
  const subset = normalizedTargetPart(value.subset);
  const baselinePassed = normalizedCount(value.baselinePassed);
  const achievedPassed = normalizedCount(value.achievedPassed);
  const total = normalizedCount(value.total);
  if (
    !phase ||
    !stage ||
    baselinePassed == null ||
    achievedPassed == null ||
    total == null ||
    baselinePassed >= achievedPassed ||
    achievedPassed > total
  ) {
    return null;
  }
  return {
    phase,
    stage,
    subset,
    baselinePassed,
    achievedPassed,
    total,
    createdTurnNumber: normalizedCount(value.createdTurnNumber),
    updatedTurnNumber: normalizedCount(value.updatedTurnNumber),
  };
}

export function pendingCheckpointForTarget(value, { phase, stage, subset = null }) {
  const pending = normalizePendingCheckpoint(value);
  if (!pending) {
    return null;
  }
  return pending.phase === normalizedTargetPart(phase) &&
    pending.stage === normalizedTargetPart(stage) &&
    pending.subset === normalizedTargetPart(subset)
    ? pending
    : null;
}

export function updatePendingCheckpoint({
  pendingCheckpoint,
  phase,
  stage,
  subset = null,
  checkpointEnabled,
  phaseAttempted,
  primaryPassed,
  baselineTestStatus,
  currentTestStatus,
  turnNumber,
}) {
  if (!checkpointEnabled || primaryPassed || !normalizedTargetPart(phase) || !normalizedTargetPart(stage)) {
    return null;
  }

  const target = { phase, stage, subset };
  const existing = pendingCheckpointForTarget(pendingCheckpoint, target);
  if (!phaseAttempted) {
    return existing;
  }

  const current = stageSnapshot(currentTestStatus, normalizedTargetPart(stage));
  if (!current || current.complete) {
    return null;
  }

  if (existing) {
    if (current.total !== existing.total || current.passed <= existing.achievedPassed) {
      return existing;
    }
    return {
      ...existing,
      achievedPassed: current.passed,
      updatedTurnNumber: normalizedCount(turnNumber),
    };
  }

  const baseline = stageSnapshot(baselineTestStatus, normalizedTargetPart(stage));
  if (!baseline || baseline.total !== current.total || current.passed <= baseline.passed) {
    return null;
  }
  const normalizedTurn = normalizedCount(turnNumber);
  return {
    phase: normalizedTargetPart(phase),
    stage: normalizedTargetPart(stage),
    subset: normalizedTargetPart(subset),
    baselinePassed: baseline.passed,
    achievedPassed: current.passed,
    total: current.total,
    createdTurnNumber: normalizedTurn,
    updatedTurnNumber: normalizedTurn,
  };
}

export function evaluatePendingCheckpointProgress({
  pendingCheckpoint,
  phase,
  stage,
  subset = null,
  currentPassed,
  currentTotal,
}) {
  const pending = pendingCheckpointForTarget(pendingCheckpoint, { phase, stage, subset });
  if (!pending) {
    return null;
  }
  const passed = normalizedCount(currentPassed);
  const total = normalizedCount(currentTotal);
  if (passed == null || total == null || total !== pending.total) {
    return { pending, passed: false, totalMatches: false };
  }
  return {
    pending,
    passed: passed >= pending.achievedPassed,
    totalMatches: true,
  };
}
