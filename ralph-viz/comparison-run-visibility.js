(function initComparisonRunVisibility(root) {
  function defaultVisible(run) {
    if (run?.highlighted === true) {
      return true;
    }
    return run?.comparisonComplete === true;
  }

  root.RALPH_COMPARISON_RUN_VISIBILITY = Object.freeze({ defaultVisible });
})(typeof window !== "undefined" ? window : globalThis);
