import assert from "node:assert/strict";
import test from "node:test";
import { ReasoningReplay } from "../prototypes/strands-codex/reasoning-replay.js";

test("encrypted reasoning stays with its tool call in later stateless requests", () => {
  const replay = new ReasoningReplay();
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted" };
  replay.remember([reasoning, { type: "function_call", call_id: "call_1" }]);
  const input = [
    { role: "user", content: "run a command" },
    { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ];
  assert.deepEqual(replay.apply(input), [input[0], reasoning, input[1], input[2]]);
  assert.deepEqual(replay.apply(input), [input[0], reasoning, input[1], input[2]]);
});
