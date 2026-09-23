import assert from "node:assert/strict";
import test from "node:test";

import { UnrealAgentEventConverter } from "../unreal-agent-events.js";

test("Unreal session responses become Ralph messages and aggregate usage", () => {
  const converter = new UnrealAgentEventConverter();
  const first = converter.convert({
    Sequence: 3,
    Kind: "model_response",
    Data: { Response: {
      Output: [
        { ProviderID: "msg-1", Type: "message", Data: { Role: "assistant", Text: "Working", Phase: "commentary" } },
        { ProviderID: "call-1", Type: "tool_call", Data: { CallID: "call-1", Name: "Bash", Arguments: '{"command":"make test"}' } },
      ],
      Usage: { InputTokens: 100, CachedInputTokens: 40, CacheWriteInputTokens: 10, OutputTokens: 20, ReasoningTokens: 5 },
    } },
  });
  assert.deepEqual(first.map((event) => event.type), ["item.completed", "item.started"]);
  assert.equal(first[0].item.text, "Working");
  assert.equal(first[1].item.command, "make test");

  const second = converter.convert({
    type: "item", data: { Item: { Sequence: 5, Kind: "model_response", Data: { Response: {
      Output: [{ ProviderID: "msg-2", Type: "message", Data: { Role: "assistant", Text: "Done" } }],
      Usage: { InputTokens: 80, CachedInputTokens: 20, OutputTokens: 15, ReasoningTokens: 3 },
    } } } },
  });
  assert.equal(second[0].item.text, "Done");
  assert.equal(converter.responses, 2);
  assert.deepEqual(converter.usage, {
    input_tokens: 180,
    cached_input_tokens: 60,
    output_tokens: 35,
    reasoning_output_tokens: 8,
    total_tokens: 215,
  });
  // Unreal already includes cache writes in InputTokens.
  assert.equal(converter.usage.input_tokens, 180);
  const [completed] = converter.completePendingCommands();
  assert.equal(completed.type, "item.completed");
  assert.equal(completed.item.id, "call-1");
  assert.equal(completed.item.status, "completed");
  assert.deepEqual(converter.completePendingCommands(), []);
});

test("Unreal runner errors and failed tool calls remain visible", () => {
  const converter = new UnrealAgentEventConverter();
  converter.convert({ Kind: "model_response", Data: { Response: {
    Output: [{ ProviderID: "call", Type: "tool_call", Data: { CallID: "call", Name: "Bash", Arguments: '{"command":"false"}' } }],
  } } });
  const [failed] = converter.convert({ Kind: "tool_call_status", Data: { CallID: "call", Status: { Error: "command failed" } } });
  assert.equal(failed.type, "item.completed");
  assert.equal(failed.item.status, "failed");
  assert.deepEqual(converter.completePendingCommands(), []);
  converter.convert({ type: "error", message: "credentials rejected" });
  assert.equal(converter.error, "credentials rejected");
});

test("persisted Unreal operations complete display commands with output and exit status", () => {
  const converter = new UnrealAgentEventConverter();
  converter.convert({ Kind: "model_response", Data: { Response: {
    Output: [{ ProviderID: "call", Type: "tool_call", Data: {
      CallID: "call", Name: "Bash", Arguments: '{"command":"printf result"}',
    } }],
  } } });
  const status = (operationStatus, exitCode) => ({
    type: "item", data: {
      Item: { Kind: "tool_call_status", Data: { CallID: "call", Status: { WaitingFor: ["op"] } } },
      Operations: [{ ID: "op", Status: operationStatus, State: {
        Result: { Out: "result", Err: "warning", ExitCode: exitCode },
      } }],
    },
  });
  assert.deepEqual(converter.completeFromSessionRecord(status("ready", 0)), []);
  const [completed] = converter.completeFromSessionRecord(status("completed", 0));
  assert.equal(completed.item.status, "completed");
  assert.equal(completed.item.aggregated_output, "result\nwarning");
  assert.equal(completed.item.exit_code, 0);
  assert.deepEqual(converter.completePendingCommands(), []);
});
