import assert from "node:assert/strict";
import test from "node:test";
import { runCodexGoalHost } from "../codex-goal-host.js";

const threadId = "host-thread";
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
class Client {
  calls = [];
  goal = { threadId, status: "active" };
  status = "idle";
  turns = 0;
  async initialize() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: threadId } };
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/read") return { thread: { id: threadId, status: { type: this.status } } };
    if (method === "turn/start") {
      this.begin(`turn-${++this.turns}`);
      return { turn: { id: this.turnId, status: "inProgress" } };
    }
    throw new Error(`Unexpected RPC ${method}`);
  }
  notify(method, params) { this.onNotification?.({ method, params: { threadId, ...params } }); }
  begin(id) {
    this.turnId = id;
    this.status = "active";
    this.notify("turn/started", { turn: { id, status: "inProgress" } });
  }
  end(status = "completed", error = null) {
    this.status = "idle";
    this.notify("turn/completed", { turn: { id: this.turnId, status, error } });
  }
}
async function start(client = new Client(), overrides = {}) {
  const events = [];
  const done = runCodexGoalHost({ client, threadId, resumeParams: { model: "fixture" },
    input: [{ type: "text", text: "audit" }], onEvent: event => events.push(event),
    continuationPrompt: "continue", settleMs: 2, continuationGraceMs: 30,
    continuationMax: 2, ...overrides });
  done.catch(() => {});
  await delay(0);
  return { client, events, done };
}

test("native continuation retains the host and waits for the final active turn", async () => {
  const { client, events, done } = await start();
  client.end();
  await delay(8);
  client.begin("native-next");
  client.goal.status = "complete";
  client.notify("thread/goal/updated", { goal: client.goal });
  let resolved = false;
  done.then(() => { resolved = true; });
  await delay(45);
  assert.equal(resolved, false, "goal completion is not permission to terminate an in-flight turn");
  client.end();
  assert.equal((await done).status, "complete");
  assert.equal(client.turns, 1, "native continuation needs no extra turn/start");
  assert.ok(events.some(e => e.type === "codex.goal_continuation"));
});

test("a new native turn supersedes an in-flight goal verification", async () => {
  const client = new Client();
  const request = client.request.bind(client);
  let release;
  let queried;
  const query = new Promise(resolve => { queried = resolve; });
  client.request = async (method, params) => {
    if (method === "thread/goal/get" && !release) {
      queried();
      return new Promise(resolve => { release = resolve; });
    }
    return request(method, params);
  };
  const { done } = await start(client);
  client.end();
  await query;
  client.begin("native-race");
  release({ goal: { threadId, status: "complete" } });
  let resolved = false;
  done.then(() => { resolved = true; });
  await delay(12);
  assert.equal(resolved, false);
  client.goal.status = "complete";
  client.end();
  await done;
});

test("a stalled active goal is nudged in the same host only after verifying idle", async () => {
  const { client, events, done } = await start();
  client.end();
  await delay(50);
  assert.equal(client.turns, 2);
  assert.ok(client.calls.some(c => c.method === "thread/read" && c.params.includeTurns === false));
  assert.equal(client.calls.filter(c => c.method === "thread/resume").length, 1);
  assert.deepEqual(client.calls.filter(c => c.method === "turn/start")[1].params.input,
    [{ type: "text", text: "continue" }]);
  assert.ok(events.some(e => e.type === "codex.goal_continuation" && e.attempt === 1));
  client.goal.status = "complete";
  client.end();
  await done;
});

test("a live host is never nudged because notification observation expired", async () => {
  const { client, done } = await start();
  client.end();
  client.status = "active";
  await delay(50);
  assert.equal(client.turns, 1);
  client.begin("observed-native");
  client.goal.status = "complete";
  client.end();
  await done;
});

test("idle nudges are bounded without resetting or completing the goal", async () => {
  const { client, done } = await start(new Client(), { continuationMax: 0 });
  client.end();
  await assert.rejects(done, /after 0 in-host continuations/);
  assert.equal(client.turns, 1);
  assert.equal(client.goal.status, "active");
});

for (const status of ["blocked", "paused", "budgetLimited", "usageLimited", null, "wrong-thread"]) {
  test(`goal state ${status} stops without advancing or resetting`, async () => {
    const { client, done } = await start();
    client.goal = status == null ? null : { threadId: status === "wrong-thread" ? "other" : threadId, status };
    client.end();
    await assert.rejects(done, e => e.codexGoalVerification && !e.codexIncompleteTask);
    assert.equal(client.turns, 1);
  });
}

test("child lifecycle notifications cannot finish the parent", async () => {
  const { client, done } = await start();
  client.notify("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "failed" } });
  client.goal.status = "complete";
  client.end();
  await done;
});

test("retrying stream errors keep running, but terminal usage limits retain recovery metadata", async () => {
  const { client, done } = await start();
  client.notify("error", { willRetry: true, error: { message: "Reconnecting" } });
  client.end("failed", { message: "Quota exhausted", codexErrorInfo: "usageLimitExceeded" });
  await assert.rejects(done, e => e.codexUsageLimit && e.threadId === threadId);
});

test("an interrupted turn cannot be mistaken for a completed goal", async () => {
  const { client, done } = await start();
  client.goal.status = "complete";
  client.end("interrupted");
  await assert.rejects(done, /interrupted/);
});

test("unexpected successful host exit requests same-thread recovery", async () => {
  const { client, done } = await start();
  client.onFailure(Object.assign(new Error("host exited"), { exitCode: 0 }));
  await assert.rejects(done, e => e.codexIncompleteTask && e.threadId === threadId);
});
