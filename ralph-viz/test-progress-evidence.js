(function installRalphTestProgressEvidence(root) {
  function finiteCount(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function targetEvidence({ passed, total, status, mode = "exact" }) {
    const normalizedTotal = finiteCount(total);
    const normalizedPassed = Math.min(normalizedTotal, finiteCount(passed));
    const passedUpperBound = mode === "fail-fast"
      ? Math.max(normalizedPassed, normalizedTotal - 1)
      : mode === "running"
        ? normalizedTotal
        : normalizedPassed;
    return {
      passed: normalizedPassed,
      passedUpperBound,
      total: normalizedTotal,
      status: status === "pass" ? "pass" : status === "running" ? "running" : "fail",
      evidence: mode,
    };
  }

  function aggregateTargetEvidence(targets) {
    const entries = Array.from(targets ?? []);
    const passed = entries.reduce((sum, target) => sum + finiteCount(target?.passed), 0);
    const passedUpperBound = entries.reduce((sum, target) => {
      const total = finiteCount(target?.total);
      const lower = Math.min(total, finiteCount(target?.passed));
      const upper = Number.isFinite(target?.passedUpperBound)
        ? Math.max(lower, Math.min(total, target.passedUpperBound))
        : lower;
      return sum + upper;
    }, 0);
    const total = entries.reduce((sum, target) => sum + finiteCount(target?.total), 0);
    const failed = entries.some((target) => target?.status === "fail");
    const allPassed = entries.length > 0 && entries.every((target) => target?.status === "pass");
    return {
      passed,
      passedUpperBound,
      total,
      unknown: Math.max(0, passedUpperBound - passed),
      knownFailed: Math.max(0, total - passedUpperBound),
      status: failed ? "fail" : allPassed ? "pass" : "running",
    };
  }

  function expandedProgressTargetTotal({
    targetTotal,
    baselineTotal,
    observedTotal,
    priorStageTotal = 0,
    hasSubset = false,
  }) {
    const target = finiteCount(targetTotal);
    const configured = finiteCount(baselineTotal, target);
    const baseline = configured > 0 ? Math.min(configured, target) : target;
    const observed = finiteCount(observedTotal);
    const prior = finiteCount(priorStageTotal);
    if (!target || !observed) return null;
    if (observed === target) return target;
    if (hasSubset || observed < target) return null;

    // A stage can legitimately gain tests during a turn, but a large jump is
    // more likely to be a through-run summary accidentally attributed to the
    // active stage. Permit modest growth and reject totals that can contain the
    // already-known prior-stage corpus.
    const maximumIncrease = Math.max(8, Math.ceil(baseline * 0.25));
    if (observed - baseline > maximumIncrease) return null;
    if (prior > 0 && observed >= baseline + prior) return null;
    return observed;
  }

  root.RALPH_TEST_PROGRESS_EVIDENCE = {
    aggregateTargetEvidence,
    expandedProgressTargetTotal,
    targetEvidence,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
