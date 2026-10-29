import './ralph-viz/turn-lifecycle.js';

// These are provider failures, not compiler/tool diagnostics or model blockers.
export function isCodexProviderInterruption(error) {
  const message = typeof error === 'string' ? error : error?.message ?? '';
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  return globalThis.RALPH_TURN_LIFECYCLE.isCodexTransientProviderMessage(message) ||
    error?.codexUsageLimit === true || info === 'usage_limit_exceeded' ||
    /\byou(?:'|’)ve hit your usage limit\b/i.test(message) ||
    (/\busage limit\b/i.test(message) && /\btry again at\b/i.test(message));
}

export function normalizeCodexProviderInterruption(value) {
  if (!value || typeof value.threadId !== 'string' || !value.threadId ||
      !Number.isFinite(Date.parse(value.failedAt)) ||
      !isCodexProviderInterruption(value.error)) return null;
  return { threadId: value.threadId, failedAt: value.failedAt, error: value.error };
}

export function isProviderBlockedGoal(goal, failure) {
  const receipt = normalizeCodexProviderInterruption(failure);
  if (!receipt || goal?.status !== 'blocked' || goal.threadId !== receipt.threadId) return false;
  const updatedAt = typeof goal.updatedAt === 'number'
    ? goal.updatedAt * (goal.updatedAt < 1e12 ? 1000 : 1) : Date.parse(goal.updatedAt);
  // An earlier model decision must never be reactivated by a later outage.
  return Number.isFinite(updatedAt) && Math.abs(updatedAt - Date.parse(receipt.failedAt)) <= 5000;
}
