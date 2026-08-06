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

  root.RALPH_TEST_STATUS_SUMMARY = Object.freeze({ summarizePriorStageFailures });
})(globalThis);
