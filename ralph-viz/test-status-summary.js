(function installRalphTestStatusSummary(root) {
  function stageNumber(stageName) {
    const match = String(stageName ?? "").match(/^pa(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function stageFailureCount(stage) {
    if (!stage || stage.status === "unknown") return null;
    if (Number.isFinite(stage.failed) && stage.failed >= 0) {
      return stage.failed;
    }
    if (Number.isFinite(stage.total) && Number.isFinite(stage.passed)) {
      return Math.max(0, stage.total - stage.passed);
    }
    return stage.status === "pass" ? 0 : null;
  }

  // A through-run aggregate can include tests not represented in its stage
  // rows. Do not assign that unexplained residual to a stage whose own row is
  // already a complete passing result.
  function hasAuthoritativePassingTotal(stage) {
    return (
      stage?.status === "pass" &&
      Number.isFinite(stage.passed) &&
      Number.isFinite(stage.total) &&
      stage.total > 0 &&
      stage.passed === stage.total
    );
  }

  function passingPrefixTotal(status) {
    if (!status?.allTestsPassed || status?.targetSubset) return null;
    const stages = Array.isArray(status.stages) ? status.stages : [];
    if (
      stages.length === 0 ||
      !stages.every((stage, index) =>
        stageNumber(stage?.name) === index + 1 && hasAuthoritativePassingTotal(stage))
    ) {
      return null;
    }
    const total = Number.isFinite(status.testsTotal) && status.testsTotal > 0
      ? status.testsTotal
      : null;
    return total ? { stage: stages.at(-1).name, total } : null;
  }

  function inferStageTotal(status, prefixTotals) {
    if (!status || status.targetSubset) return null;
    const stages = Array.isArray(status.stages) ? status.stages : [];
    const testsTotal = Number.isFinite(status.testsTotal) && status.testsTotal > 0
      ? status.testsTotal
      : null;
    if (stages.length === 0 || !testsTotal) return null;

    const targetStage =
      (/^pa\d+$/.test(status.targetStage ?? "") ? status.targetStage : null) ??
      (/^pa\d+$/.test(status.failingStage ?? "") ? status.failingStage : null) ??
      stages.find((stage) => stage?.status === "fail")?.name ??
      stages.at(-1)?.name;
    const targetIndex = stages.findIndex((stage) => stage?.name === targetStage);
    if (targetIndex < 0 || hasAuthoritativePassingTotal(stages[targetIndex])) {
      return null;
    }

    if (stages.length === 1) {
      return {
        stage: targetStage,
        total: Math.max(testsTotal, stages[0]?.total ?? 0),
      };
    }

    const targetNumber = stageNumber(targetStage);
    if (
      !Number.isInteger(targetNumber) ||
      targetIndex !== targetNumber - 1 ||
      !stages.every((stage, index) => stageNumber(stage?.name) === index + 1)
    ) {
      return null;
    }
    const priorStage = `pa${targetNumber - 1}`;
    const priorTotal = prefixTotals instanceof Map
      ? prefixTotals.get(priorStage)
      : prefixTotals?.[priorStage];
    if (!Number.isFinite(priorTotal) || priorTotal < 0 || testsTotal <= priorTotal) {
      return null;
    }
    return {
      stage: targetStage,
      total: Math.max(testsTotal - priorTotal, stages[targetIndex]?.total ?? 0),
    };
  }

  function clampProgressCount(value, total) {
    return Math.max(0, Math.min(total, Number.isFinite(value) ? value : 0));
  }

  function buildTurnProgressModel(progress) {
    const total = Number.isFinite(progress?.current?.total) && progress.current.total > 0
      ? progress.current.total
      : null;
    if (!total) return null;

    const current = clampProgressCount(progress.current.passed, total);
    const hasStart = Number.isFinite(progress?.start?.passed);
    const start = hasStart ? clampProgressCount(progress.start.passed, total) : current;
    const delta = current - start;
    const remaining = total - current;
    let segments;
    if (!hasStart) {
      segments = [
        { key: "current", label: "current", value: current, text: String(current) },
        { key: "remaining", label: "left", value: remaining, text: String(remaining) },
      ];
    } else if (delta >= 0) {
      segments = [
        { key: "start", label: "start", value: start, text: String(start) },
        { key: "gained", label: "this turn", value: delta, text: `+${delta}` },
        { key: "remaining", label: "left", value: remaining, text: String(remaining) },
      ];
    } else {
      segments = [
        { key: "current", label: "current", value: current, text: String(current) },
        { key: "lost", label: "lost this turn", value: -delta, text: String(delta) },
        {
          key: "remaining",
          label: "left beyond start",
          value: Math.max(0, total - start),
          text: String(Math.max(0, total - start)),
        },
      ];
    }
    return {
      total,
      current,
      start,
      hasStart,
      delta,
      remaining,
      segments: segments.filter((segment) => segment.value > 0),
    };
  }

  // Test commands often report only part of a through run. Track the newest
  // explicit result for each prior PA so a partial report cannot erase other
  // known regressions and a later passing rerun can clear an earlier failure.
  function summarizePriorStageFailures(evidence, activeStage) {
    const activeNumber = stageNumber(activeStage);
    if (!Number.isInteger(activeNumber)) {
      return { total: 0, stages: [] };
    }

    const latestByStage = new Map();
    const ordered = (Array.isArray(evidence) ? evidence : [])
      .map((entry, index) => ({
        status: entry?.status ?? entry,
        recordedAt: entry?.recordedAt ?? entry?.status?.recordedAt ?? null,
        index,
      }))
      .sort((a, b) => {
        const aTime = Date.parse(a.recordedAt ?? "");
        const bTime = Date.parse(b.recordedAt ?? "");
        const timeDelta = (Number.isFinite(aTime) ? aTime : 0) -
          (Number.isFinite(bTime) ? bTime : 0);
        return timeDelta || a.index - b.index;
      });

    for (const entry of ordered) {
      for (const stage of entry.status?.stages ?? []) {
        const number = stageNumber(stage?.name);
        if (!Number.isInteger(number) || number >= activeNumber) continue;
        const failed = stageFailureCount(stage);
        if (failed == null) continue;
        latestByStage.set(stage.name, { name: stage.name, number, failed });
      }
    }

    const stages = [...latestByStage.values()]
      .filter((stage) => stage.failed > 0)
      .sort((a, b) => a.number - b.number)
      .map(({ name, failed }) => ({ name, failed }));
    return {
      total: stages.reduce((sum, stage) => sum + stage.failed, 0),
      stages,
    };
  }

  root.RALPH_TEST_STATUS_SUMMARY = Object.freeze({
    hasAuthoritativePassingTotal,
    buildTurnProgressModel,
    inferStageTotal,
    passingPrefixTotal,
    summarizePriorStageFailures,
  });
})(globalThis);
