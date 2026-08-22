(function initComparisonRunVisibility(root) {
  function defaultVisible(run) {
    if (run?.highlighted === true) {
      return true;
    }
    return ![run?.label, run?.spec, run?.model, run?.dataPath]
      .some((value) => /(?:^|[^a-z0-9])(?:luna|v3opus)(?:[^a-z0-9]|$)/i.test(String(value ?? "")));
  }

  root.RALPH_COMPARISON_RUN_VISIBILITY = Object.freeze({ defaultVisible });
})(typeof window !== "undefined" ? window : globalThis);
