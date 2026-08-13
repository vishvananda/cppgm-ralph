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

test("session conversion upgrades an unresolved wait with completion metadata", () => {
  const primary = [
    commandRecord("item.started", {
      id: "wait-1",
      type: "command_execution",
      status: "running",
      command: 'wait {"cell_id":"21"}',
    }, "2026-08-13T03:31:00.000Z"),
    commandRecord("item.completed", {
      id: "wait-1",
      type: "command_execution",
      status: "completed",
      command: "profile-tool (continued session 21)",
      session_id: "21",
      exit_code: null,
      aggregated_output: "profile report",
    }, "2026-08-13T03:31:17.000Z"),
  ];
  const converted = [
    primary[0],
    commandRecord("item.completed", {
      ...primary[1].event.item,
      async_completed: true,
    }, "2026-08-13T03:31:17.000Z"),
  ];

  assert.equal(sessionItemCardSuppressionKeys(primary).size, 0);
  const merged = mergeEventStreams(primary, converted);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].event.item.exit_code, null);
  assert.equal(merged[1].event.item.async_completed, true);
});

test("session conversion upgrades a truncated transport card with its decoded exit code", () => {
  const transport = "Warning: truncated output (original token count: 12104)\n" +
    "Total output lines: 1\n\n" +
    '{"chunk_id":"a5fc64","exit_code":2,"output":"test failures\\n"}';
  const primary = [
    commandRecord("item.started", {
      id: "truncated-1",
      type: "command_execution",
      status: "running",
      command: "make test-report-through-pa31 (continued session 21452)",
    }, "2026-08-13T04:30:10.000Z"),
    commandRecord("item.completed", {
      id: "truncated-1",
      type: "command_execution",
      status: "completed",
      command: "make test-report-through-pa31 (continued session 21452)",
      session_id: "21452",
      exit_code: null,
      aggregated_output: transport,
    }, "2026-08-13T04:30:10.100Z"),
  ];
  const converted = [
    primary[0],
    commandRecord("item.completed", {
      ...primary[1].event.item,
      exit_code: 2,
      aggregated_output: "test failures\n",
    }, "2026-08-13T04:30:10.100Z"),
  ];

  assert.equal(sessionItemCardSuppressionKeys(primary).size, 0);
  const merged = mergeEventStreams(primary, converted);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].event.item.exit_code, 2);
  assert.equal(merged[1].event.item.aggregated_output, "test failures\n");
});

test("session replay can upgrade a mapped async batch poll", () => {
  const source = "const rs = await Promise.all([59030,57111].map(session_id => " +
    "tools.write_stdin({session_id,chars:\"\"})));";
  const primary = [
    commandRecord("item.started", {
      id: "mapped-poll",
      type: "command_execution",
      status: "running",
      command: "write_stdin unknown session",
      raw: { name: "exec", input: source },
    }, "2026-08-13T21:38:15.000Z"),
    commandRecord("item.completed", {
      id: "mapped-poll",
      type: "command_execution",
      status: "completed",
      command: "write_stdin unknown session",
      exit_code: 0,
      aggregated_output: "LINK cppgm++\naudit passed\n",
      raw: { input: source },
    }, "2026-08-13T21:38:16.000Z"),
  ];
  const converted = [
    commandRecord("item.started", {
      ...primary[0].event.item,
      command: "command 1: make -j2 (continued session 59030)\n" +
        "command 2: perl audit.pl (continued session 57111)",
    }, "2026-08-13T21:38:15.000Z"),
    commandRecord("item.completed", {
      ...primary[1].event.item,
      command: "command 1: make -j2 (continued session 59030)\n" +
        "command 2: perl audit.pl (continued session 57111)",
      batch_commands: [
        { command: "make -j2 (continued session 59030)", output: "LINK cppgm++\n", exit_code: 0 },
        { command: "perl audit.pl (continued session 57111)", output: "audit passed\n", exit_code: 0 },
      ],
    }, "2026-08-13T21:38:16.000Z"),
  ];

  assert.equal(sessionItemCardSuppressionKeys(primary).size, 0);
  const merged = mergeEventStreams(primary, converted);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].event.item.batch_commands.length, 2);
  assert.equal(merged[1].event.item.batch_commands[0].exit_code, 0);
});
