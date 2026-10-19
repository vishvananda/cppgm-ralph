import assert from "node:assert/strict";
import test from "node:test";
import { interruptedCodexAuthentication, isAuthenticationBlockedGoal,
  isCodexAuthenticationError } from "../codex-auth-recovery.js";

const error = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
const failedAt = "2026-10-19T01:20:43.876Z";
const state = { threadId: "thread", activeTurn: { status: "failed", agent: { provider: "codex" },
  endedAt: failedAt, error } };

test("credential recovery requires a failed Codex attempt, not a task blocker", () => {
  const failure = interruptedCodexAuthentication(state);
  assert.equal(failure.threadId, "thread");
  for (const change of [{ status: "running" }, { error: "goal is blocked" },
    { endedAt: null }, { agent: { provider: "claude" } }]) {
    assert.equal(interruptedCodexAuthentication({ ...state,
      activeTurn: { ...state.activeTurn, ...change } }), null);
  }
  assert.equal(isCodexAuthenticationError({ codexErrorInfo: "unauthorized", message: "Denied" }), true);
  assert.equal(isCodexAuthenticationError(new Error("request timed out")), false);
});

test("only the blocked goal from that credential failure can be reactivated", () => {
  const failure = interruptedCodexAuthentication(state);
  const goal = { threadId: "thread", status: "blocked", updatedAt: Date.parse(failedAt) / 1000 };
  assert.equal(isAuthenticationBlockedGoal(goal, failure), true);
  for (const change of [{ threadId: "other" }, { status: "paused" }, { status: "budgetLimited" },
    { updatedAt: Date.parse(failedAt) / 1000 - 60 }, { updatedAt: null }]) {
    assert.equal(isAuthenticationBlockedGoal({ ...goal, ...change }, failure), false);
  }
  assert.equal(isAuthenticationBlockedGoal(goal, { ...failure, error: "Compiler contract blocker" }), false);
});
