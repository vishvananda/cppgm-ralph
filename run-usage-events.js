// Usage/timing calculations need event boundaries and counters, not transcripts.
// Keep the same records and metadata so retry, model and child attribution agree
// with full-detail views without retaining command output or test-report trees.
export function compactRunUsageEvent(record) {
  const event = { ...record.event };
  delete event.raw;
  if (event.item) {
    const item = event.item;
    event.item = item.type === "subagent"
      ? Object.fromEntries(Object.entries(item).filter(([key]) =>
          !["raw", "prompt", "result", "description", "aggregated_output"].includes(key)))
      : { id: item.id, type: item.type, status: item.status };
  }
  if (event.phaseStatus) {
    const status = event.phaseStatus;
    event.phaseStatus = { stage: status.stage, phase: status.phase, subset: status.subset,
      allRequiredPassed: status.allRequiredPassed,
      failedRequiredChecks: status.failedRequiredChecks?.map(() => null) };
  }
  delete event.testStatus;
  delete event.last_agent_message;
  return { ...record, event };
}
