// A usage limit stops native goal continuation until the caller explicitly
// reactivates it. A status-only update keeps the persisted objective and usage.
export async function readResumableCodexGoal(client, threadId) {
  const { goal } = await client.request("thread/goal/get", { threadId });
  if (!goal || goal.threadId !== threadId) {
    throw new Error(`Cannot preserve Codex goal for ${threadId}: missing or mismatched goal`);
  }
  if (goal.status === "usageLimited") {
    const response = await client.request("thread/goal/set", { threadId, status: "active" });
    const resumed = response?.goal;
    if (resumed?.threadId !== threadId || resumed.status !== "active" ||
        resumed.objective !== goal.objective || resumed.tokenBudget !== goal.tokenBudget ||
        resumed.tokensUsed !== goal.tokensUsed ||
        resumed.timeUsedSeconds !== goal.timeUsedSeconds ||
        resumed.createdAt !== goal.createdAt) {
      throw new Error(`Cannot resume Codex goal for ${threadId}: status update changed the goal or its usage`);
    }
    return { goal: resumed, reactivated: true };
  }
  if (!["active", "complete", "completed"].includes(goal.status)) {
    throw new Error(`Cannot resume Codex goal for ${threadId}: goal is ${goal.status}`);
  }
  return { goal, reactivated: false };
}
