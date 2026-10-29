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

test("credential-induced blocking resumes with the original objective and accounting", async () => {
  const failure = { threadId, failedAt: "2026-10-19T01:20:43.876Z", error: "Codex authentication failed" };
  const blocked = { ...original, status: "blocked", updatedAt: Date.parse(failure.failedAt) / 1000 };
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    return { goal: method === "thread/goal/get" ? blocked : { ...blocked, status: "active" } };
  } };
  const resumed = await readResumableCodexGoal(client, threadId, { authenticationFailure: failure });
  assert.equal(resumed.reactivated, true);
  assert.deepEqual(resumed.goal, { ...blocked, status: "active" });
  assert.deepEqual(calls[1], { method: "thread/goal/set", params: { threadId, status: "active" } });
  await assert.rejects(readResumableCodexGoal(client, threadId, { authenticationFailure: {
    ...failure, failedAt: "2026-10-18T01:20:43.876Z",
  } }), /goal is blocked/);
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

test('only timestamp-matched provider outages can reactivate a blocked goal', async () => {
  const failedAt = '2026-10-28T17:28:26.013Z';
  const blocked = {...original, status:'blocked', updatedAt:Date.parse(failedAt)/1000};
  for (const error of [
    'Selected model is at capacity. Please try a different model.',
    'Request timed out',
    "You've hit your usage limit. Try again at Oct 29, 2026 1:00 AM",
    {message:'Limit reached',codexErrorInfo:'usage_limit_exceeded'},
  ]) {
    const calls=[];
    const client={async request(method,params) {
      calls.push({method,params});
      return {goal:method==='thread/goal/get'?blocked:{...blocked,status:'active'}};
    }};
    const providerFailure={threadId,failedAt,error};
    const result=await readResumableCodexGoal(client,threadId,{providerFailure});
    assert.equal(result.reactivated,true);
    assert.deepEqual(calls[1],{method:'thread/goal/set',params:{threadId,status:'active'}});
    for (const invalid of [
      {...providerFailure,failedAt:'2026-10-28T18:55:02Z'},
      {...providerFailure,threadId:'another-thread'},
      {...providerFailure,error:'Pending compiler implementation'},
    ]) await assert.rejects(readResumableCodexGoal(client,threadId,{providerFailure:invalid}),/goal is blocked/);
  }
});
