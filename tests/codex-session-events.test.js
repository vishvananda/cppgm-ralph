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

function functionCall(converter, callId, name, args) {
  return converter.convert({
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
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

test("infers terminal make results when code mode emitted only result.output", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "start",
    'const r = await tools.exec_command({cmd:"make test-report-through-pa30"}); text(JSON.stringify(r));',
  );
  const started = toolOutput(converter, "start", JSON.stringify({
    session_id: 60179,
    output: "LINK cppgm++\n",
  })).item;
  assert.equal(started.exit_code, null);

  toolCall(
    converter,
    "progress",
    'const r = await tools.write_stdin({session_id:60179, chars:""}); text(r.output);',
  );
  const progress = toolOutput(converter, "progress", "===== pa1 =====\n").item;
  assert.equal(progress.session_id, "60179");
  assert.equal(progress.exit_code, null);

  toolCall(
    converter,
    "finish",
    'const r = await tools.write_stdin({session_id:60179, chars:""}); text(r.output);',
  );
  const finish = toolOutput(
    converter,
    "finish",
    "===== pa1 =====\n===== pa30 =====\n" +
      "===== ALL TESTS PASSED SUCCESSFULLY! (4132 / 4132) =====\n",
  ).item;
  assert.equal(finish.command, "make test-report-through-pa30 (continued session 60179)");
  assert.equal(finish.session_id, "60179");
  assert.equal(finish.exit_code, 0);
});

test("infers a completed make build from its terminal directory marker", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "build",
    'const r = await tools.exec_command({cmd:"make -C dev cppgm++"}); text(r.output);',
  );
  const completed = toolOutput(
    converter,
    "build",
    "LINK cppgm++\nmake: Leaving directory '/work/dev'\n",
  ).item;
  assert.equal(completed.exit_code, 0);
});

test("does not treat a nested make directory marker as top-level completion", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "nested-build",
    'const r = await tools.exec_command({cmd:"make all"}); text(r.output);',
  );
  const progress = toolOutput(
    converter,
    "nested-build",
    "make[1]: Leaving directory '/work/dev'\n",
  ).item;
  assert.equal(progress.exit_code, null);
});

test("parses a terminal EXIT 0 marker from an output-only async poll", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "long-start",
    'const r = await tools.exec_command({cmd:"long-tool"}); text(JSON.stringify(r));',
  );
  toolOutput(converter, "long-start", JSON.stringify({
    session_id: 229,
    output: "working\n",
  }));

  toolCall(
    converter,
    "long-finish",
    'const r = await tools.write_stdin({session_id:229, chars:""}); text(r.output);',
  );
  const completed = toolOutput(converter, "long-finish", "done\nEXIT 0\n").item;
  assert.equal(completed.command, "long-tool (continued session 229)");
  assert.equal(completed.session_id, "229");
  assert.equal(completed.exit_code, 0);
});

test("does not parse a non-terminal exit-looking progress line", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "exit-progress",
    'const r = await tools.exec_command({cmd:"long-tool"}); text(r.output);',
  );
  const progress = toolOutput(
    converter,
    "exit-progress",
    "subcommand\nEXIT 0\nstill working\n",
  ).item;
  assert.equal(progress.exit_code, null);
});

test("marks a completed built-in wait as done when the nested exit code was discarded", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "profile-start",
    'const r = await tools.exec_command({cmd:"profile-tool"}); text(r.output);',
  );
  toolOutput(converter, "profile-start", "Script running with cell ID 21\n");

  functionCall(converter, "profile-wait", "wait", {
    cell_id: "21",
    yield_time_ms: 30000,
  });
  const completed = toolOutput(converter, "profile-wait", [
    { type: "input_text", text: "Script completed\nWall time 16.8 seconds\nOutput:\n" },
    { type: "input_text", text: "perf_status=0\nprofile report\n" },
  ]).item;
  assert.equal(completed.command, "profile-tool (continued session 21)");
  assert.equal(completed.session_id, "21");
  assert.equal(completed.exit_code, null);
  assert.equal(completed.async_completed, true);
  assert.equal(completed.aggregated_output, "perf_status=0\nprofile report");
});

test("does not mark a yielded built-in wait as completed", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "profile-start-running",
    'const r = await tools.exec_command({cmd:"profile-tool"}); text(r.output);',
  );
  toolOutput(converter, "profile-start-running", "Script running with cell ID 22\n");

  functionCall(converter, "profile-wait-running", "wait", {
    cell_id: "22",
    yield_time_ms: 30000,
  });
  const running = toolOutput(
    converter,
    "profile-wait-running",
    "Script running with cell ID 22\nWall time 30.0 seconds\nOutput:\nstill working\n",
  ).item;
  assert.notEqual(running.async_completed, true);
  assert.equal(running.session_id, "22");
});

test("recovers a counted-failure shell exit code from its terminal summary", () => {
  const converter = new CodexSessionConverter();
  const command = [
    "status=0",
    "failed=0",
    "for source_path in one two three; do",
    "  if ! compile \"$source_path\"; then",
    "    failed=$((failed + 1))",
    "    status=1",
    "  fi",
    "done",
    "printf 'cases=3 failures=%s audit_dir=/tmp/audit\\n' \"$failed\"",
    "exit \"$status\"",
  ].join("\n");
  toolCall(
    converter,
    "counted-failure",
    `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r.output);`,
  );
  const failed = toolOutput(
    converter,
    "counted-failure",
    "FAIL one\nFAIL two\ncases=3 failures=2 audit_dir=/tmp/audit\n",
  ).item;
  assert.equal(failed.exit_code, 1);

  toolCall(
    converter,
    "counted-success",
    `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r.output);`,
  );
  const passed = toolOutput(
    converter,
    "counted-success",
    "cases=3 failures=0 audit_dir=/tmp/audit\n",
  ).item;
  assert.equal(passed.exit_code, 0);
});

test("does not infer counted-failure status before the terminal summary", () => {
  const converter = new CodexSessionConverter();
  const command = "status=0\nfailed=0\nfailed=$((failed + 1))\nstatus=1\nexit \"$status\"";
  toolCall(
    converter,
    "counted-progress",
    `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r.output);`,
  );
  const progress = toolOutput(
    converter,
    "counted-progress",
    "cases=3 failures=1 audit_dir=/tmp/audit\nstill working\n",
  ).item;
  assert.equal(progress.exit_code, null);
});

test("make failure output wins over a terminal directory marker", () => {
  const converter = new CodexSessionConverter();
  toolCall(
    converter,
    "build-failure",
    'const r = await tools.exec_command({cmd:"make -C dev cppgm++"}); text(r.output);',
  );
  const completed = toolOutput(
    converter,
    "build-failure",
    "src/file.cpp: error: broken\nmake: *** [Makefile:1: file.o] Error 1\n" +
      "make: Leaving directory '/work/dev'\n",
  ).item;
  assert.equal(completed.exit_code, 2);
});
