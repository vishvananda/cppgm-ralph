import assert from "node:assert/strict";
import test from "node:test";
import { readResumableCodexGoal } from "../codex-goal-resume.js";

const threadId = "interrupted-thread";
const original = {
  threadId,
  objective: "Finish the existing phase",
  status: "usageLimited",
  tokenBudget: 1000,
  tokensUsed: 423,
  timeUsedSeconds: 17,
  createdAt: 123,
  updatedAt: 456,
};

test("reactivates a usage-limited goal with a status-only update", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/goal/get") return { goal: original };
      if (method === "thread/goal/set") return {
        goal: { ...original, status: "active", updatedAt: 789 },
      };
      throw new Error(`Unexpected request ${method}`);
    },
  };
  const resumed = await readResumableCodexGoal(client, threadId);
  assert.equal(resumed.reactivated, true);
  assert.equal(resumed.goal.status, "active");
  assert.deepEqual(calls, [
    { method: "thread/goal/get", params: { threadId } },
    { method: "thread/goal/set", params: { threadId, status: "active" } },
  ]);
});

test("rejects a status update that replaces goal accounting", async () => {
  const client = {
    async request(method) {
      return method === "thread/goal/get" ? { goal: original } : {
        goal: { ...original, status: "active", tokensUsed: 0 },
      };
    },
  };
  await assert.rejects(readResumableCodexGoal(client, threadId), /changed the goal or its usage/);
});

for (const status of ["paused", "blocked", "budgetLimited"]) {
  test(`does not reactivate a ${status} goal`, async () => {
    const client = {
      async request(method) {
        assert.equal(method, "thread/goal/get");
        return { goal: { ...original, status } };
      },
    };
    await assert.rejects(readResumableCodexGoal(client, threadId), new RegExp(`goal is ${status}`));
  });
}
