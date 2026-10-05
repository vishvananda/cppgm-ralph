import assert from "node:assert/strict";
import test from "node:test";
import { isTransientStreamError, streamWithReconnect } from "../prototypes/strands-codex/stream-retry.js";

test("Strands resumes the same agent after a dropped model stream", async () => {
  const prompts = [];
  const notices = [];
  const agent = { async *stream(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) {
      yield { type: "beforeModelCallEvent" };
      throw new TypeError("terminated", { cause: Object.assign(
        new Error("other side closed"), { code: "UND_ERR_SOCKET" },
      ) });
    }
    yield { type: "agentResultEvent", result: { stopReason: "endTurn" } };
  } };
  const events = [];
  for await (const event of streamWithReconnect(agent, "Do PA1", {
    onRetry: (notice) => notices.push(notice), pause: async () => {},
  })) events.push(event);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "Do PA1");
  assert.match(prompts[1], /Continue the assigned work/);
  assert.equal(events.at(-1).type, "agentResultEvent");
  assert.match(notices[0].error, /UND_ERR_SOCKET/);
});

test("Strands does not retry permanent failures or exceed its retry limit", async () => {
  assert.equal(isTransientStreamError(new Error("bad input")), false);
  let calls = 0;
  const agent = { async *stream() {
    calls += 1;
    throw new TypeError("terminated");
  } };
  await assert.rejects(async () => {
    for await (const _event of streamWithReconnect(agent, "Do PA1", {
      maxRetries: 2, pause: async () => {},
    })) { /* drain */ }
  }, /terminated/);
  assert.equal(calls, 3);
});

function serverError(code = "server_error") {
  return Object.assign(new Error("An error occurred while processing your request", {
    cause: Object.assign(new Error("provider response failed"), { code }),
  }), { name: "ModelError" });
}

test("Strands resumes completed tool work after a wrapped provider server error", async () => {
  const prompts = [];
  const notices = [];
  const waits = [];
  const completedTools = [];
  const agent = { async *stream(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) {
      completedTools.push("read source");
      yield { type: "afterToolCallEvent" };
      throw serverError();
    }
    assert.deepEqual(completedTools, ["read source"]);
    yield { type: "agentResultEvent", result: { stopReason: "endTurn" } };
  } };
  const events = [];
  for await (const event of streamWithReconnect(agent, "Do PA5", {
    onRetry: (notice) => notices.push(notice), pause: async (ms) => waits.push(ms),
  })) events.push(event);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Do not repeat completed tool actions/);
  assert.deepEqual(events.map((event) => event.type), ["afterToolCallEvent", "agentResultEvent"]);
  assert.equal(notices[0].reason, "server_error");
  assert.match(notices[0].error, /ModelError:.*caused by Error \[server_error\]/);
  assert.deepEqual(waits, [1000]);
});

test("Strands bounds retries for server errors and HTTP 5xx responses", async () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isTransientStreamError(new Error("wrapped", {
      cause: Object.assign(new Error("HTTP failure"), { status }),
    })), true);
  }
  for (const error of [
    serverError("invalid_request_error"),
    serverError("context_length_exceeded"),
    serverError("rate_limit_exceeded"),
    Object.assign(new Error("bad request"), { status: 400 }),
    Object.assign(new Error("expired login"), { status: 401 }),
    Object.assign(new Error("usage limit"), { status: 429 }),
  ]) {
    assert.equal(isTransientStreamError(error), false);
    let calls = 0;
    const agent = { async *stream() { calls += 1; throw error; } };
    await assert.rejects(async () => {
      for await (const _event of streamWithReconnect(agent, "Do PA5")) { /* drain */ }
    }, (actual) => actual === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const waits = [];
  const error = serverError();
  const agent = { async *stream() { calls += 1; throw error; } };
  await assert.rejects(async () => {
    for await (const _event of streamWithReconnect(agent, "Do PA5", {
      pause: async (ms) => waits.push(ms),
    })) { /* drain */ }
  }, (actual) => actual === error);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("Strands makes one bounded same-session continuation after output-token exhaustion", async () => {
  const prompts = [];
  const notices = [];
  const agent = { async *stream(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) {
      yield { type: "beforeModelCallEvent" };
      throw Object.assign(new Error("Model reached maximum token limit"), { name: "MaxTokensError" });
    }
    yield { type: "agentResultEvent", result: { stopReason: "endTurn" } };
  } };
  const events = [];
  for await (const event of streamWithReconnect(agent, "Do PA4", {
    onRetry: (notice) => notices.push(notice), pause: async () => {},
  })) events.push(event);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /output-token limit/);
  assert.equal(notices[0].reason, "max_tokens");
  assert.equal(events.at(-1).type, "agentResultEvent");

  let calls = 0;
  const alwaysLimited = { async *stream() {
    calls += 1;
    throw Object.assign(new Error("still limited"), { name: "MaxTokensError" });
  } };
  await assert.rejects(async () => {
    for await (const _event of streamWithReconnect(alwaysLimited, "Do PA4")) { /* drain */ }
  }, /still limited/);
  assert.equal(calls, 2);
});
