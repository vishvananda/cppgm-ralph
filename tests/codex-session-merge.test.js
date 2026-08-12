import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeEventStreams,
  sessionItemCardSuppressionKeys,
} from "../ralph-viz/server.js";

function commandRecord(eventType, item, recordedAt) {
  return {
    recordedAt,
    threadId: "thread-1",
    turnNumber: 7,
    eventType,
    event: { type: eventType, item },
  };
}

test("session conversion upgrades raw code-mode command cards already in the run log", () => {
  const rawSource = "exec const rs = await Promise.all([tools.exec_command({cmd:\"one\"}), " +
    "tools.exec_command({cmd:\"two\"})]);";
  const primary = [
    commandRecord("item.started", {
      id: "call-1",
      type: "command_execution",
      status: "running",
      command: rawSource,
    }, "2026-08-12T00:00:00.000Z"),
    commandRecord("item.completed", {
      id: "call-1",
      type: "command_execution",
      status: "completed",
      command: rawSource,
      aggregated_output: "--- 0 ---\n{transport}\n--- 1 ---\n{transport}",
    }, "2026-08-12T00:00:01.000Z"),
  ];
  const converted = [
    commandRecord("item.started", {
      id: "call-1",
      type: "command_execution",
      status: "running",
      command: "command 1: one\ncommand 2: two",
    }, "2026-08-12T00:00:00.000Z"),
    commandRecord("item.completed", {
      id: "call-1",
      type: "command_execution",
      status: "completed",
      command: "command 1: one\ncommand 2: two",
      aggregated_output: "first\nsecond",
      batch_commands: [
        { command: "one", output: "first" },
        { command: "two", output: "second" },
      ],
    }, "2026-08-12T00:00:01.000Z"),
  ];

  assert.equal(sessionItemCardSuppressionKeys(primary).size, 0);
  const merged = mergeEventStreams(primary, converted);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].event.item.command, "command 1: one\ncommand 2: two");
  assert.equal(merged[1].event.item.batch_commands.length, 2);
  assert.equal(merged[1].event.item.aggregated_output, "first\nsecond");
});

test("session conversion upgrades an old single-session view of a parallel poll", () => {
  const primary = [
    commandRecord("item.started", {
      id: "poll-1",
      type: "command_execution",
      status: "running",
      command: "write_stdin session 10",
    }, "2026-08-12T00:01:00.000Z"),
    commandRecord("item.completed", {
      id: "poll-1",
      type: "command_execution",
      status: "completed",
      command: "write_stdin session 10",
      aggregated_output: "--- 0 ---\n{\"output\":\"one\",\"session_id\":10}\n" +
        "--- 1 ---\n{\"output\":\"two\",\"exit_code\":0}",
    }, "2026-08-12T00:01:01.000Z"),
  ];
  const converted = [
    commandRecord("item.started", {
      id: "poll-1",
      type: "command_execution",
      status: "running",
      command: "command 1: build (continued session 10)\n" +
        "command 2: audit (continued session 20)",
    }, "2026-08-12T00:01:00.000Z"),
    commandRecord("item.completed", {
      id: "poll-1",
      type: "command_execution",
      status: "completed",
      command: "command 1: build (continued session 10)\n" +
        "command 2: audit (continued session 20)",
      batch_commands: [
        { command: "build (continued session 10)", output: "one", session_id: 10 },
        { command: "audit (continued session 20)", output: "two", exit_code: 0 },
      ],
    }, "2026-08-12T00:01:01.000Z"),
  ];

  assert.equal(sessionItemCardSuppressionKeys(primary).size, 0);
  const merged = mergeEventStreams(primary, converted);
  assert.equal(merged[0].event.item.command, converted[0].event.item.command);
  assert.equal(merged[1].event.item.batch_commands.length, 2);
});
