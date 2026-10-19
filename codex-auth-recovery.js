// Classify provider failures, never tool output or compiler diagnostics.
export function isCodexAuthenticationError(error) {
  const info = error?.codexErrorInfo;
  if (info === "unauthorized" || info === "Unauthorized") return true;
  const message = typeof error === "string" ? error : error?.message ?? "";
  return /your access token could not be refreshed|refresh token (?:was revoked|has expired|was already used)|not authenticated|authentication (?:failed|required)|\b401\s+unauthorized\b/i.test(message);
}

export function interruptedCodexAuthentication(state) {
  const turn = state?.activeTurn;
  if (turn?.status !== "failed" || turn.agent?.provider !== "codex" ||
      !state.threadId || !Number.isFinite(Date.parse(turn.endedAt)) ||
      !isCodexAuthenticationError(turn.error)) return null;
  return { threadId: state.threadId, failedAt: turn.endedAt, error: turn.error };
}

export function isAuthenticationBlockedGoal(goal, failure) {
  if (goal?.status !== "blocked" || !failure || goal.threadId !== failure.threadId ||
      !isCodexAuthenticationError(failure.error)) return false;
  const failedAt = Date.parse(failure.failedAt);
  const updatedAt = typeof goal.updatedAt === "number"
    ? goal.updatedAt * (goal.updatedAt < 1e12 ? 1000 : 1)
    : Date.parse(goal.updatedAt);
  // A stopped goal from an earlier model decision is not an auth interruption.
  // Native goal timestamps have second precision; the attempt receipt has ms.
  return Number.isFinite(failedAt) && Number.isFinite(updatedAt) &&
    Math.abs(updatedAt - failedAt) <= 5000;
}
