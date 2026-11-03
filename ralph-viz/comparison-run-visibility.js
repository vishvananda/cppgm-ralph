(function initComparisonRunVisibility(root) {
  function defaultVisible(run) {
    if (run?.highlighted === true) {
      return true;
    }
    return run?.comparisonReachedPa34 === true || run?.comparisonComplete === true;
  }

  function reachedPa34(comparison, index) {
    const layout = root.RALPH_ASSIGNMENT_LAYOUT;
    if (!layout) return false;
    // Canonical PA39 is self-hosting: native PA34 in V4/V5, PA39 in V2/V3.
    const stage = layout.nativePaNumber(comparison.runs?.[index]?.layout, 39);
    const summary = comparison.rows?.find(row => row.pa === `pa${stage}`)?.runs?.[index];
    return layout.summaryStarted(summary);
  }

  function annotate(comparison) {
    return { ...comparison, runs: (comparison.runs ?? []).map((run, index) => ({
      ...run, comparisonReachedPa34: reachedPa34(comparison, index),
    })) };
  }

  root.RALPH_COMPARISON_RUN_VISIBILITY = Object.freeze({ defaultVisible, reachedPa34, annotate });
})(typeof window !== "undefined" ? window : globalThis);
