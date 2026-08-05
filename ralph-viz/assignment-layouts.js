(function installRalphAssignmentLayouts(root) {
  const layouts = Object.freeze({
    v2: Object.freeze({
      id: "v2",
      shortLabel: "V2",
      label: "V2 assignment order",
      description: "abimangle at pa30; the pre-ABI compiler sequence occupies pa14-pa29",
    }),
    v3: Object.freeze({
      id: "v3",
      shortLabel: "V3",
      label: "V3 assignment order",
      description: "abimangle at pa14; the former pa14-pa29 sequence occupies pa15-pa30",
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
    return /^v3/i.test(String(runName ?? "")) ? "v3" : "v2";
  }

  function descriptor(value, fallback = "v2") {
    return layouts[normalizeLayoutId(value, fallback)];
  }

  function canonicalPaNumber(layout, nativePaNumber) {
    const number = Number.parseInt(nativePaNumber, 10);
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
    return nativePaNumber(sourceLayout, canonicalPaNumber(targetLayout, targetPaNumber));
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
    const maxPa = Math.max(0, ...rowsByNumber.keys());
    const targetId = normalizeLayoutId(targetLayout, "v3");
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
