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

test("Strands does not retry non-network failures or exceed its retry limit", async () => {
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
