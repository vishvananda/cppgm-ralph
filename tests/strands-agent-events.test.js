import assert from "node:assert/strict";
import test from "node:test";
import { StrandsAgentEventConverter } from "../strands-agent-events.js";

test("Strands groups reasoning with its shell command and counts raw Codex usage", () => {
  const converter = new StrandsAgentEventConverter();
  const toolUse = { toolUseId: "call-1", name: "shell", input: { command: "pwd" } };
  const events = [
    { type: "model.start" },
    { type: "model.content", block: { reasoning: { text: "Checking the working directory." } } },
    { type: "model.content", block: { toolUse } },
    { type: "model.usage", usage: {
      input_tokens: 100, input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 },
    } },
    { type: "model.complete" },
    { type: "tool.start", toolUse },
    { type: "tool.complete", toolUse, result: { toolResult: {
      status: "success", content: [{ json: { output: "/work\n", error: "", exit_code: 0 } }],
    } } },
    { type: "model.start" },
    { type: "model.content", block: { text: "The directory is /work." } },
    { type: "model.usage", usage: {
      input_tokens: 80, input_tokens_details: { cached_tokens: 60 },
      output_tokens: 10, output_tokens_details: { reasoning_tokens: 2 },
    } },
    { type: "model.complete" },
    { type: "driver.completed", usage: { inputTokens: 180, outputTokens: 30 } },
  ].flatMap((record) => converter.convert(record));

  assert.deepEqual(events.map((event) => event.type), [
    "codex.session.token_count", "item.completed", "item.started", "item.completed",
    "codex.session.token_count", "item.completed",
  ]);
  assert.equal(events[0].counter_scope, "turn");
  assert.equal(events[0].usage.total_tokens, 120);
  assert.equal(events[1].item.type, "reasoning");
  assert.equal(events[1].item.response_step, 1);
  assert.equal(events[1].item.response_command_count, 1);
  assert.equal(events[2].item.command, "pwd");
  assert.equal(events[3].item.aggregated_output, "/work\n");
  assert.equal(events[3].item.exit_code, 0);
  assert.equal(events[4].usage.total_tokens, 210);
  assert.equal(events[5].item.response_step, 2);
  assert.deepEqual(converter.usage, {
    input_tokens: 180, cached_input_tokens: 100, output_tokens: 30,
    reasoning_output_tokens: 9, total_tokens: 210,
  });
  assert.equal(converter.completed, true);
});

test("Strands preserves read tool inputs and outputs for viewer cards", () => {
  const converter = new StrandsAgentEventConverter();
  const toolUse = { toolUseId: "read-1", name: "read", input: { path: "spec.md", offset: 10 } };
  const [started] = converter.convert({ type: "tool.start", toolUse });
  const [completed] = converter.convert({ type: "tool.complete", toolUse,
    result: { toolResult: { status: "success", content: [{ text: "the spec" }] } } });
  assert.equal(started.item.type, "tool_call");
  assert.equal(started.item.tool_name, "read");
  assert.deepEqual(JSON.parse(started.item.command), { path: "spec.md", offset: 10 });
  assert.equal(completed.item.output, "the spec");
  assert.equal(completed.item.status, "completed");
});

test("Strands failure closes an active command", () => {
  const converter = new StrandsAgentEventConverter();
  converter.convert({ type: "model.start" });
  converter.convert({ type: "model.content", block: {
    toolUse: { toolUseId: "call-1", name: "shell", input: { command: "sleep 1" } },
  } });
  converter.convert({ type: "model.complete" });
  const events = converter.convert({ type: "driver.failed", message: "limit reached" });
  assert.equal(events[0].item.status, "failed");
  assert.match(events[0].item.aggregated_output, /limit reached/);
});

test("Strands exports a model-stream reconnect notice", () => {
  const converter = new StrandsAgentEventConverter();
  const events = converter.convert({
    type: "driver.retry", retry: 1, maxRetries: 2,
    error: "TypeError: terminated; caused by SocketError [UND_ERR_SOCKET]",
  });
  assert.equal(events[0].item.type, "agent_message");
  assert.match(events[0].item.text, /retrying in the same session \(1\/2\)/);
});

test("Strands labels output-limit continuations without calling them disconnects", () => {
  const converter = new StrandsAgentEventConverter();
  const [event] = converter.convert({ type: "driver.retry", reason: "max_tokens",
    retry: 1, maxRetries: 1, error: "MaxTokensError: limit" });
  assert.match(event.item.text, /output-token limit/);
  assert.doesNotMatch(event.item.text, /disconnected/);
});
