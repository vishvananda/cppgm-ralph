import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/command-status.js";

const {
  declaredShellTimeoutMs,
  staleAsyncCommandEvidence,
} = globalThis.RALPH_COMMAND_STATUS;

test("parses and sums explicit shell timeout budgets", () => {
  assert.equal(declaredShellTimeoutMs("timeout 60s compile input"), 60_000);
  assert.equal(
    declaredShellTimeoutMs("timeout 1m first; timeout 2.5s second"),
    62_500,
  );
  assert.equal(declaredShellTimeoutMs("make test"), null);
});

test("marks an unpolled timed session as uncollected after its deadline", () => {
  const recordedAt = "2026-08-14T16:20:27.418Z";
  assert.equal(staleAsyncCommandEvidence({
    command: "set +e; timeout 60s compiler input; exit 0",
    sessionId: 59144,
    recordedAt,
    nowMs: Date.parse("2026-08-14T16:21:30.000Z"),
  }), null);

  assert.deepEqual(staleAsyncCommandEvidence({
    command: "set +e; timeout 60s compiler input; exit 0",
    sessionId: 59144,
    recordedAt,
    nowMs: Date.parse("2026-08-14T16:21:34.000Z"),
  }), {
    state: "uncollected",
    sessionId: "59144",
    timeoutMs: 60_000,
    message: "Output unavailable: asynchronous session 59144 was not polled after its 60s command timeout.",
  });
});

test("completed and untimed async commands are not marked uncollected", () => {
  assert.equal(staleAsyncCommandEvidence({
    command: "timeout 1s task",
    sessionId: 10,
    completed: true,
    recordedAt: "2026-08-14T16:20:00.000Z",
    nowMs: Date.parse("2026-08-14T16:30:00.000Z"),
  }), null);
  assert.equal(staleAsyncCommandEvidence({
    command: "long task",
    sessionId: 10,
    recordedAt: "2026-08-14T16:20:00.000Z",
    nowMs: Date.parse("2026-08-14T16:30:00.000Z"),
  }), null);
});
