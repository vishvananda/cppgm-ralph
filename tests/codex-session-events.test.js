import assert from "node:assert/strict";
import test from "node:test";

import { CodexSessionConverter } from "../codex-session-events.js";

function toolCall(converter, callId, input) {
  return converter.convert({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input,
    },
  });
}

function toolOutput(converter, callId, output) {
  return converter.convert({
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output,
    },
  });
}

function labeledJsonChunks(chunks, firstLabel = 0) {
  return chunks
    .map((chunk, index) => `--- ${firstLabel + index} ---\n${JSON.stringify(chunk)}`)
    .join("\n");
}

test("reconstitutes labeled Promise.all transport objects and async command chains", () => {
  const converter = new CodexSessionConverter();
  const start = toolCall(converter, "start", `
const results = await Promise.all([
  tools.exec_command({cmd:"make test-report-through-pa25", workdir:"/work"}),
  tools.exec_command({cmd:"perl scripts/cppgm_file_audit.pl", workdir:"/work"})
]);
results.forEach((r,i)=>text(\`--- \${i} ---\\n\${JSON.stringify(r)}\`));
`);
  assert.equal(
    start.item.command,
    "command 1: make test-report-through-pa25\n" +
      "command 2: perl scripts/cppgm_file_audit.pl",
  );

  const started = toolOutput(converter, "start", [
    { type: "input_text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
    {
      type: "input_text",
      text: labeledJsonChunks([
        { chunk_id: "8d465c", session_id: 83326, output: "make started\n" },
        { chunk_id: "7c0cad", session_id: 28163, output: "audit started\n" },
      ]),
    },
  ]).item;
  assert.equal(started.aggregated_output, "make started\naudit started\n");
  assert.deepEqual(
    started.batch_commands.map(({ command, output, session_id }) => ({
      command,
      output,
      session_id,
    })),
    [
      { command: "make test-report-through-pa25", output: "make started\n", session_id: 83326 },
      { command: "perl scripts/cppgm_file_audit.pl", output: "audit started\n", session_id: 28163 },
    ],
  );

  const pollStart = toolCall(converter, "poll", `
const rs = await Promise.all([
  tools.write_stdin({session_id:83326, chars:"", yield_time_ms:30000}),
  tools.write_stdin({session_id:28163, chars:"", yield_time_ms:30000})
]);
rs.forEach((r,i)=>text(\`--- \${i} ---\\n\${JSON.stringify(r)}\`));
`);
  assert.equal(
    pollStart.item.command,
    "command 1: make test-report-through-pa25 (continued session 83326)\n" +
      "command 2: perl scripts/cppgm_file_audit.pl (continued session 28163)",
  );

  const poll = toolOutput(converter, "poll", labeledJsonChunks([
    { chunk_id: "make-2", session_id: 83326, output: "make progress\n" },
    { chunk_id: "audit-2", exit_code: 0, output: "audit done\n" },
  ])).item;
  assert.equal(poll.batch_commands[0].session_id, 83326);
  assert.equal(poll.batch_commands[0].output, "make progress\n");
  assert.equal(poll.batch_commands[1].exit_code, 0);
  assert.equal(poll.batch_commands[1].output, "audit done\n");

  const finishStart = toolCall(
    converter,
    "finish",
    "const r = await tools.write_stdin({session_id:83326, chars:\"\", yield_time_ms:30000}); text(r.output);",
  );
  assert.equal(
    finishStart.item.command,
    "make test-report-through-pa25 (continued session 83326)",
  );
  const finish = toolOutput(converter, "finish", JSON.stringify({
    chunk_id: "make-3",
    exit_code: 0,
    output: "make done\n",
  })).item;
  assert.equal(finish.command, "make test-report-through-pa25 (continued session 83326)");
  assert.equal(finish.session_id, "83326");
  assert.equal(finish.exit_code, 0);
  assert.equal(finish.aggregated_output, "make done\n");
});

test("pairs labeled plain output with commands from a mapped array", () => {
  const converter = new CodexSessionConverter();
  const commands = [
    "cat pa17/test.diff",
    "sed -n '1,180p' pa17/test.t",
    "sed -n '1,240p' pa17/test.ref",
    "sed -n '1,240p' pa17/test.my",
    "dev/cppgm++ --emit-semantics pa17/test.t",
  ];
  const source = `
const cmds = [
  "cat pa17/test.diff",
  "sed -n '1,180p' pa17/test.t",
  "sed -n '1,240p' pa17/test.ref",
  "sed -n '1,240p' pa17/test.my",
  "dev/cppgm++ --emit-semantics pa17/test.t"
];
const rs = await Promise.all(cmds.map(cmd => tools.exec_command({cmd, workdir:"/work"})));
rs.forEach((r,i)=>text(\`--- \${i+1} ---\\n\${r.output}\`));
`;
  const start = toolCall(converter, "plain", source);
  assert.deepEqual(
    start.item.command.split("\n"),
    commands.map((command, index) => `command ${index + 1}: ${command}`),
  );

  const output = toolOutput(converter, "plain", [
    { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
    {
      type: "input_text",
      text: [
        "--- 1 ---\ndiff output",
        "--- 2 ---\ntest input",
        "--- 3 ---\nreference output",
        "--- 4 ---\nactual output",
        "--- 5 exit=0 ---\nsemantic output",
      ].join("\n"),
    },
  ]).item;

  assert.deepEqual(output.batch_commands.map((part) => part.command), commands);
  assert.deepEqual(
    output.batch_commands.map((part) => part.output),
    ["diff output", "test input", "reference output", "actual output", "semantic output"],
  );
  assert.deepEqual(
    output.batch_commands.map((part) => part.exit_code),
    [null, null, null, null, 0],
  );
});
