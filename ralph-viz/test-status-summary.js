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

  function testReportFailureLinesByStage(output) {
    const text = String(output ?? "");
    const headers = [...text.matchAll(/^===== (pa\d+) =====$/gm)].map((match) => ({
      name: match[1],
      index: match.index ?? 0,
    }));
    return headers.map((header, index) => ({
      name: header.name,
      failureLines: text
        .slice(header.index, headers[index + 1]?.index ?? text.length)
        .split(/\r?\n/)
        .filter((line) =>
          /^(?:(?:pa\d+\/|pa\d+\/\.\.\/).+|(?:tests|course|cppgm\.tests)\/.+): /.test(line) &&
          /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|expected EXIT_|got EXIT_|got 124|does not match|timed out|did not time out as expected|exit status mismatch/i.test(line)),
    }));
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
    const observedBest = Number.isFinite(progress?.best?.passed)
      ? clampProgressCount(progress.best.passed, total)
      : current;
    const best = Math.max(start, current, observedBest);
    const delta = current - start;
    const bestDelta = best - start;
    const regression = best - current;
    const remaining = total - current;
    const remainingBeyondBest = total - best;
    const rows = [
      {
        key: "best",
        label: "best",
        segments: [
          {
            key: hasStart ? "start" : "current",
            label: hasStart ? "start" : "current",
            value: start,
            text: String(start),
          },
          {
            key: "gained",
            label: "gain at best",
            value: bestDelta,
            text: hasStart && bestDelta > 0 ? `+${bestDelta}` : "",
          },
          {
            key: "remaining",
            label: "left beyond best",
            value: remainingBeyondBest,
            text: "",
          },
        ].filter((segment) => segment.value > 0),
      },
    ];
    if (regression > 0) {
      rows.push({
        key: "current",
        label: "current",
        segments: [
          { key: "current", label: "current", value: current, text: "" },
          {
            key: "lost",
            label: "below best",
            value: regression,
            text: regression > 0 ? `-${regression}` : "",
          },
          {
            key: "remaining",
            label: "left beyond best",
            value: remainingBeyondBest,
            text: "",
          },
        ].filter((segment) => segment.value > 0),
      });
    }
    return {
      total,
      current,
      start,
      best,
      hasStart,
      delta,
      bestDelta,
      regression,
      remaining,
      remainingBeyondBest,
      rows,
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
    testReportFailureLinesByStage,
  });
})(globalThis);
