const COMPLETE_STATUSES = new Set(["complete", "completed"]);

export function requiresCodexGoalCompletion(goal, provider) {
  return provider === "codex" && Boolean(goal) && goal.provider !== "ralph-portable";
}

export function assertCodexGoalComplete(goal, threadId) {
  const wrongThread = goal?.threadId && goal.threadId !== threadId;
  if (!wrongThread && COMPLETE_STATUSES.has(goal?.status)) return;
  const error = new Error(
    wrongThread ? "Codex goal verification returned a different thread; refusing to advance." :
      `Codex task ended while loop goal status was ${goal?.status ?? "missing"}; ` +
      (goal?.status === "active" ? "requesting same-turn continuation." : "refusing to advance the phase."),
  );
  error.threadId = threadId;
  error.codexGoalVerification = true;
  // Blocked, paused, budget-limited, and unknown goals require intervention,
  // not automatic activation or a fabricated completion.
  error.codexIncompleteTask = !wrongThread && goal?.status === "active";
  throw error;
}

export function parseCodexToolGoalStatus(output, threadId) {
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const status = parseCodexToolGoalStatus(output[i]?.text, threadId);
      if (status) return status;
    }
    return null;
  }
  if (typeof output !== "string") return null;
  // Code Mode wraps outputs in text blocks, sometimes with a preamble and
  // several JSON lines. The direct function-call shape is a single JSON string.
  for (const text of [output, ...output.split(/\r?\n/).reverse()]) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    const goal = parsed?.goal;
    if (typeof goal?.status !== "string") continue;
    if (goal.threadId && goal.threadId !== threadId) continue;
    return goal.status;
  }
  return null;
}

export function codexSessionTaskCompletion(records, {
  threadId, startedAtMs, requireGoalCompletion = false, nowMs = Date.now(),
  settleMs = 2000, continuationGraceMs = 60_000,
}) {
  let lifecycle = null;
  let goalEvent = null;
  for (const record of records) {
    const timestampMs = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(timestampMs) || timestampMs < startedAtMs - 5000) continue;
    const payload = record.payload ?? {};
    if (record.type === "event_msg") {
      if (payload.type === "thread_goal_updated") {
        if (payload.goal?.threadId && payload.goal.threadId !== threadId) continue;
        if (!goalEvent || timestampMs >= goalEvent.timestampMs) {
          goalEvent = { status: payload.goal?.status, timestampMs };
        }
      } else if (["task_complete", "task_started", "turn_aborted"].includes(payload.type)) {
        if (!lifecycle || timestampMs >= lifecycle.timestampMs) lifecycle = { ...payload, timestampMs };
      }
    } else if (record.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const status = parseCodexToolGoalStatus(payload.output, threadId);
      if (status && (!goalEvent || timestampMs >= goalEvent.timestampMs)) goalEvent = { status, timestampMs };
    }
  }

  // A new native continuation wins over the preceding task_complete. Never
  // terminate it merely because the previous task emitted a final message.
  if (lifecycle?.type !== "task_complete") return { status: "pending" };
  const ageMs = nowMs - lifecycle.timestampMs;
  if (ageMs < settleMs) return { status: "pending" };
  if (lifecycle.error?.codex_error_info === "usage_limit_exceeded") {
    return { status: "usage_limit", message: lifecycle.error.message ?? "Codex usage limit was reached.",
      codexErrorInfo: lifecycle.error.codex_error_info };
  }
  if (requireGoalCompletion) {
    // A bounded tail may omit the goal installed at invocation start. Its
    // absence is not completion; the known initial goal state is active.
    const status = goalEvent?.status ?? "active";
    if (!COMPLETE_STATUSES.has(status)) {
      if (status === "active" && ageMs < continuationGraceMs) return { status: "pending" };
      return {
        status: status === "active" ? "incomplete" : "goal_stopped",
        reason: `Codex task ended while loop goal status was ${status}; ` +
          (status === "active" ? "requesting same-turn continuation." : "refusing to advance the phase."),
      };
    }
  } else if (!String(lifecycle.last_agent_message ?? "").trim() && !COMPLETE_STATUSES.has(goalEvent?.status)) {
    return { status: "incomplete", reason: "Codex task_complete did not include a final agent message; requesting same-turn continuation." };
  }
  return { status: "complete" };
}
