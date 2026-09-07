(function installRalphAssignmentLayouts(root) {
  const layouts = Object.freeze({
    v2: Object.freeze({
      id: "v2",
      shortLabel: "V2",
      label: "V2 assignment order",
      description: "abimangle at pa30; the pre-ABI compiler sequence occupies pa14-pa29",
      stageCount: 39,
    }),
    v3: Object.freeze({
      id: "v3",
      shortLabel: "V3",
      label: "V3 assignment order",
      description: "abimangle at pa14; the former pa14-pa29 sequence occupies pa15-pa30",
      stageCount: 39,
    }),
    v4: Object.freeze({
      id: "v4",
      shortLabel: "V4",
      label: "V4 assignment order",
      description: "34 stages; full preprocessing at pa4, AST at pa5, abimangle at pa9, inception at pa34",
      stageCount: 34,
    }),
  });

  function normalizeLayoutId(value, fallback = "v2") {
    const id = typeof value === "object" && value ? value.id : value;
    const normalized = String(id ?? "").trim().toLowerCase();
    if (normalized === "current") {
      return "v2";
    }
    return layouts[normalized] ? normalized : fallback;
  }

  function inferLayoutId(runName, explicitLayout = null) {
    if (explicitLayout != null && String(explicitLayout).trim()) {
      return normalizeLayoutId(explicitLayout);
    }
    return /^v4/i.test(String(runName ?? "")) ? "v4"
      : /^v3/i.test(String(runName ?? "")) ? "v3" : "v2";
  }

  function descriptor(value, fallback = "v2") {
    return layouts[normalizeLayoutId(value, fallback)];
  }

  function canonicalPaNumber(layout, nativePaNumber) {
    const number = Number.parseInt(nativePaNumber, 10);
    if (normalizeLayoutId(layout) === "v4") {
      if (!Number.isInteger(number) || number < 1 || number > 34) return null;
      return number <= 3 ? number : number === 4 ? 5 : number + 5;
    }
    if (!Number.isInteger(number) || normalizeLayoutId(layout) === "v3") {
      return number;
    }
    if (number === 30) {
      return 14;
    }
    if (number >= 14 && number <= 29) {
      return number + 1;
    }
    return number;
  }

  function nativePaNumber(layout, canonicalNumber) {
    const number = Number.parseInt(canonicalNumber, 10);
    if (normalizeLayoutId(layout) === "v4") {
      if (!Number.isInteger(number) || number < 1 || number > 39) return null;
      // V3's standalone macro, recognition, namespace, and CY86 stages
      // have no separate V4 stage. Do not duplicate another stage's cost.
      if (number === 4 || (number >= 6 && number <= 9)) return null;
      return number <= 3 ? number : number === 5 ? 4 : number - 5;
    }
    if (!Number.isInteger(number) || normalizeLayoutId(layout) === "v3") {
      return number;
    }
    if (number === 14) {
      return 30;
    }
    if (number >= 15 && number <= 30) {
      return number - 1;
    }
    return number;
  }

  function sourcePaForTarget(sourceLayout, targetLayout, targetPaNumber) {
    const canonical = canonicalPaNumber(targetLayout, targetPaNumber);
    return canonical == null ? null : nativePaNumber(sourceLayout, canonical);
  }

  function paNumber(value) {
    const match = String(value ?? "").match(/^(?:pa)?(\d+)$/i);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function remapComparisonRows(comparison, targetLayout = "v3") {
    const rows = Array.isArray(comparison?.rows) ? comparison.rows : [];
    const runs = Array.isArray(comparison?.runs) ? comparison.runs : [];
    const rowsByNumber = new Map(
      rows.map((row) => [paNumber(row?.pa), row]).filter(([number]) => Number.isInteger(number)),
    );
    const targetId = normalizeLayoutId(targetLayout, "v3");
    let maxPa = 0;
    for (const run of runs) {
      const sourceLayout = normalizeLayoutId(run?.layout, "v2");
      for (const number of rowsByNumber.keys()) {
        const targetPa = sourcePaForTarget(targetId, sourceLayout, number);
        if (Number.isInteger(targetPa)) maxPa = Math.max(maxPa, targetPa);
      }
    }
    maxPa = Math.min(maxPa, layouts[targetId].stageCount);
    const remapped = [];
    for (let targetPa = 1; targetPa <= maxPa; targetPa += 1) {
      remapped.push({
        pa: `pa${targetPa}`,
        runs: runs.map((run, runIndex) => {
          const sourceLayout = normalizeLayoutId(run?.layout, "v2");
          const sourcePa = sourcePaForTarget(sourceLayout, targetId, targetPa);
          return rowsByNumber.get(sourcePa)?.runs?.[runIndex] ?? null;
        }),
      });
    }
    return remapped;
  }

  root.RALPH_ASSIGNMENT_LAYOUT = Object.freeze({
    layouts,
    normalizeLayoutId,
    inferLayoutId,
    descriptor,
    canonicalPaNumber,
    nativePaNumber,
    sourcePaForTarget,
    remapComparisonRows,
  });
})(globalThis);
