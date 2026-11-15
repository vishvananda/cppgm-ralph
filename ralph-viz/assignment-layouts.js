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
    v5: Object.freeze({
      id: "v5",
      shortLabel: "V5",
      label: "V5 assignment order",
      description: "V4's 34 stages followed by compiler optimization at pa35",
      stageCount: 35,
    }),
    v9: Object.freeze({
      id: "v9",
      shortLabel: "V9",
      label: "V9 assignment order",
      description: "Integrated assembly at pa29; optimization at pa33/34, inception at pa35, performance at pa36, wasm at pa37; optional C at pa38",
      stageCount: 38,
      requiredStageCount: 37,
      optionalStages: Object.freeze(["pa38"]),
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
    return /^v9(?!\d)/i.test(String(runName ?? "")) ? "v9"
      : /^v[5-8](?!\d)/i.test(String(runName ?? "")) ? "v5"
      : /^v4/i.test(String(runName ?? "")) ? "v4"
      : /^v3/i.test(String(runName ?? "")) ? "v3" : "v2";
  }

  function preferredLayout(runs = []) {
    const ids = runs.map(run => normalizeLayoutId(run.layout ?? run.assignmentLayout));
    return ids.includes("v9") ? "v9" : ids.includes("v5") ? "v5" : "v3";
  }

  function descriptor(value, fallback = "v2") {
    return layouts[normalizeLayoutId(value, fallback)];
  }

  function canonicalPaNumber(layout, nativePaNumber) {
    const number = Number.parseInt(nativePaNumber, 10);
    const id = normalizeLayoutId(layout);
    if (id === "v9") {
      if (!Number.isInteger(number) || number < 1 || number > 38) return null;
      if (number === 29) return 41; // New landmarks append stable canonical IDs.
      if (number === 37) return 42;
      if (number === 38) return 43;
      return canonicalPaNumber("v5", number >= 30 ? number - 1 : number);
    }
    if (id === "v4" || id === "v5") {
      if (!Number.isInteger(number) || number < 1 || number > layouts[id].stageCount) return null;
      return number <= 3 ? number : number === 4 ? 5 : number + 5;
    }
    if (number >= 40) return null;
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
    const id = normalizeLayoutId(layout);
    if (id === "v9") {
      if (!Number.isInteger(number) || number < 1 || number > 43) return null;
      if (number === 41) return 29;
      if (number === 42) return 37;
      if (number === 43) return 38;
      const previous = nativePaNumber("v5", number);
      return previous == null ? null : previous >= 29 ? previous + 1 : previous;
    }
    if (id === "v4" || id === "v5") {
      if (!Number.isInteger(number) || number < 1 || number > (id === "v5" ? 40 : 39)) return null;
      // V3's standalone macro, recognition, namespace, and CY86 stages
      // have no separate V4 stage. Do not duplicate another stage's cost.
      if (number === 4 || (number >= 6 && number <= 9)) return null;
      return number <= 3 ? number : number === 5 ? 4 : number - 5;
    }
    if (number >= 40) return null;
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

  // These are capability landmarks, not claims of identical fixtures or scope.
  // Keep the native rows in the export: grouping is a lossless presentation.
  const titles = [
    "Tokens", "Literals", "Preprocessor expressions", "Macros", "Preprocessing",
    "Recognition", "Namespace declarations", "Namespace initialization", "CY86",
    "AST", "Types and lookup", "Expression semantics", "LowIR foundation", "ABI naming",
    "Procedural lowering", "Classes and layout", "Value semantics", "Virtual dispatch",
    "Basic templates", "Specialization", "Constant evaluation", "Template entities",
    "Deduction and SFINAE", "Template integration", "Core language closure",
    "Advanced language closure", "Multiple inheritance", "Virtual/RTTI model",
    "Native backend", "Compile/link driver", "Exception metadata", "Object interoperability",
    "Host C++ ABI", "Hosted headers", "Heavy hosted headers", "Hosted runtime",
    "LowIR optimization", "Backend optimization", "Inception",
    "Compiler optimization", "Integrated assembly", "WebAssembly", "C frontend (optional course assignment)",
  ];

  function milestone(canonicalStages, label = titles[canonicalStages[0] - 1]) {
    const legacy = canonicalStages[0] === 6 && canonicalStages.length === 4;
    return {
      id: `milestone-${canonicalStages.join("-")}`,
      label,
      canonicalStages,
      legacy,
      note: legacy ? "Older-only standalone recognition, namespace and CY86 work; included in spending."
        : canonicalStages.includes(13)
          ? "Approximate match: V2/V3 translate LowIR to CY86; V4 builds a LowIR model, roundtrip and construction exercises."
          : "",
    };
  }

  function comparisonGroups(view, includeOptimization = false, includeV9 = false) {
    const optimization = includeOptimization ? [milestone([40], "PA35 · Compiler optimization (V5)")] : [];
    if (view === "v2" || view === "v3") {
      return [...Array.from({ length: 39 }, (_, index) => {
        const canonical = canonicalPaNumber(view, index + 1);
        return milestone([canonical], `PA${index + 1} · ${titles[canonical - 1]}`);
      }), ...(includeV9 ? [milestone([41])] : []), ...optimization,
        ...(includeV9 ? [milestone([42]), milestone([43])] : [])];
    }
    const groups = [
      ...[1, 2, 3].map((pa) => milestone([pa])),
      milestone([4, 5], "Complete preprocessing"),
      milestone([6, 7, 8, 9], "Legacy-only work"),
      ...Array.from({ length: 30 }, (_, index) => milestone([index + 10])),
    ];
    if (includeV9) {
      groups.splice(groups.findIndex(group => group.canonicalStages[0] === 34), 0, milestone([41]));
    }
    const additions = [...optimization, ...(includeV9 ? [milestone([42]), milestone([43])] : [])];
    return view === "v4" || view === "v5" || view === "v9" ? [...groups.map((group) => ({
      ...group,
      label: group.legacy ? group.label
        : nativePaNumber(view, group.canonicalStages.at(-1)) == null ? group.label
          : `PA${nativePaNumber(view, group.canonicalStages.at(-1))} · ${group.label}`,
    })), ...additions.map(group => ({ ...group, label: view === "v9"
      ? `PA${nativePaNumber(view, group.canonicalStages[0])} · ${titles[group.canonicalStages[0] - 1]}` : group.label }))]
      : [...groups, ...additions];
  }

  function summaryStarted(summary) {
    if (!summary || summary.status === "not started" || summary.status === "not required") return false;
    return Boolean(summary.turns?.length || summary.cost > 0 || summary.durationMs > 0 ||
      summary.totalDurationMs > 0 || summary.status === "complete" || summary.status === "partial");
  }

  function aggregateSources(sources) {
    const summaries = sources.map((source) => source.summary);
    const started = summaries.some(summaryStarted);
    return {
      sources,
      status: !sources.length ? "not required" : !started ? "not started"
        : summaries.every((summary) => summary?.status === "complete") ? "complete" : "partial",
      turns: summaries.flatMap((summary) => summary?.turns ?? []),
      cost: summaries.reduce((sum, summary) => sum + (Number(summary?.cost) || 0), 0),
      durationMs: summaries.reduce((sum, summary) => sum + (Number(summary?.activeDurationMs ?? summary?.durationMs) || 0), 0),
      totalDurationMs: summaries.reduce((sum, summary) => sum + (Number(summary?.totalDurationMs ?? summary?.activeDurationMs ?? summary?.durationMs) || 0), 0),
    };
  }

  function comparisonRows(comparison, view = "capabilities") {
    const runs = comparison?.runs ?? [];
    const rawRows = comparison?.rows ?? [];
    const byPa = new Map(rawRows.map((row) => [paNumber(row.pa), row]));
    // Export --through is always in canonical V3 numbering, never a count of
    // displayed groups (nor the native V2/V4/V5 assignment number).
    // Canonical PA40 is V5's additional compiler-optimization assignment.
    const hasV9 = runs.some((run) => normalizeLayoutId(run.layout) === "v9");
    const hasV5 = hasV9 || runs.some((run) => normalizeLayoutId(run.layout) === "v5");
    const through = Math.min(43, paNumber(comparison?.through) ?? (hasV9 ? 43 : hasV5 ? 40 : 39));
    const groups = comparisonGroups(view, hasV5, hasV9);
    const included = groups.map((group) => group.canonicalStages.some((canonical) =>
      canonical <= through && runs.some((run) => byPa.has(nativePaNumber(run.layout, canonical)))));
    const lastIndex = included.lastIndexOf(true);
    return groups.slice(0, lastIndex + 1).map((group) => ({
      ...group,
      pa: group.id,
      runs: runs.map((run, runIndex) => {
        const sourceLayout = normalizeLayoutId(run.layout);
        const stages = [...new Set(group.canonicalStages.map((canonical) => nativePaNumber(sourceLayout, canonical))
          .filter((number) => number != null))];
        return aggregateSources(stages.map((number) => {
          const canonical = canonicalPaNumber(sourceLayout, number);
          const modern = sourceLayout === "v4" || sourceLayout === "v5" || sourceLayout === "v9";
          const specialTitle = modern && number === 8 ? "LowIR model, roundtrip and construction"
            : !modern && canonical === 13 ? "LowIR to CY86"
              : titles[canonical - 1];
          return {
            pa: `pa${number}`,
            layout: sourceLayout,
            title: specialTitle,
            summary: canonical <= through ? byPa.get(number)?.runs?.[runIndex] ?? null : null,
          };
        }));
      }),
    }));
  }

  function cumulativePoints(rows, runIndex, field, secondaryField = null) {
    let value = 0;
    let secondaryValue = 0;
    const lastStarted = rows.map((row) => summaryStarted(row.runs?.[runIndex])).lastIndexOf(true);
    let started = false;
    return rows.flatMap((row, index) => {
      const summary = row.runs?.[runIndex];
      // An interior N/A is a flat bridge, not an achieved, free assignment.
      const bridge = summary?.status === "not required" && started && index < lastStarted;
      if (!summaryStarted(summary) && !bridge) return [];
      started = true;
      value += Number(summary?.[field]) || 0;
      secondaryValue += Number(summary?.[secondaryField] ?? summary?.[field]) || 0;
      return [{ pa: row.pa, index, value, secondaryValue, status: summary.status }];
    });
  }

  root.RALPH_ASSIGNMENT_LAYOUT = Object.freeze({
    layouts,
    normalizeLayoutId,
    inferLayoutId,
    descriptor,
    preferredLayout,
    canonicalPaNumber,
    nativePaNumber,
    sourcePaForTarget,
    remapComparisonRows,
    comparisonRows,
    summaryStarted,
    cumulativePoints,
  });
})(globalThis);
