import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { CodexSessionConverter, codexCommandCompletionEvent } from "../codex-session-events.js";
import { mergeEventStreams } from "../ralph-viz/server.js";

function loadFunctions(file, context) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  // Execute actual conversion/display helpers without starting a server or DOM.
  for (const match of source.matchAll(/^(?:export )?(?:async )?function [\s\S]*?^\}/gm)) {
    vm.runInContext(match[0].replace(/^export /, ""), context);
  }
}

function browserHelpers() {
  const context = vm.createContext({ hideNoiseToggle: { checked: true } });
  for (const file of ["entry-dedupe.js", "turn-lifecycle.js"]) {
    vm.runInContext(readFileSync(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), context);
  }
  vm.runInContext("const ENTRY_DEDUPE=RALPH_ENTRY_DEDUPE; const TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE;", context);
  loadFunctions("../ralph-viz/app.js", context);
  return context;
}

function fixture(serialize) {
  let tick = 0;
  const records = [];
  const call = (call_id, input) => {
    records.push({ type: "response_item", timestamp: new Date(++tick * 1000).toISOString(),
      payload: { type: "custom_tool_call", name: "exec", call_id, input } });
  };
  const output = (call_id, chunks) => {
    records.push({ type: "response_item", timestamp: new Date(++tick * 1000).toISOString(),
      payload: { type: "custom_tool_call_output", call_id, output: serialize(chunks) } });
  };
  call("start", `
text(await tools.exec_command({cmd:"build"}));
text(await tools.exec_command({cmd:"audit"}));
`);
  output("start", [{ output: "building", session_id: 10 }, { output: "auditing", session_id: 20 }]);
  call("poll", `
text(await tools.exec_command({cmd:"read report"}));
for (const id of [10, 20]) text(await tools.write_stdin({session_id:id, chars:""}));
text(await tools.exec_command({cmd:"new background task"}));
`);
  output("poll", [
    { output: "report", exit_code: 0 },
    { output: "built", exit_code: 0 },
    { output: "audit failed", exit_code: 2 },
    { output: "new task started", session_id: 30 },
  ]);
  return records;
}

const wrap = value => ({ status: "fulfilled", value });
const serializers = {
  "separate settled results": chunks => [
    { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
    ...chunks.map(chunk => ({ type: "input_text", text: JSON.stringify(wrap(chunk)) })),
  ],
  "serialized settled result array": chunks => JSON.stringify(chunks.map(wrap)),
};

for (const [format, serialize] of Object.entries(serializers)) {
  for (const pipeline of ["runner", "server"]) {
    test(`${pipeline} and browser preserve command states for ${format}`, () => {
      const records = fixture(serialize);
      const browser = browserHelpers();
      let events;
      if (pipeline === "runner") {
        const converter = new CodexSessionConverter();
        events = records.map(record => {
          const event = converter.convert(record);
          return { recordedAt: record.timestamp, threadId: "thread", turnNumber: 1, eventType: event.type, event };
        });
      } else {
        const server = vm.createContext({});
        loadFunctions("../ralph-viz/server.js", server);
        const context = {
          threadId: "thread", turnNumber: 1,
          commandsByCallId: new Map(), functionCallsByCallId: new Map(),
          commandsBySessionId: new Map(), sessionIdsByStoreKey: new Map(),
        };
        events = records.map(record => server.convertCodexResponseItem(record.payload,
          { ...context, recordedAt: record.timestamp }));
      }
      const entries = browser.buildDisplayEntries(events).filter(entry => entry.kind === "command");
      assert.equal(entries.length, 4, "new commands in a mixed poll must remain visible with noise hidden");
      const byCommand = new Map(entries.map(entry => [entry.startRecord.event.item.command, entry]));
      assert.equal(browser.commandEntryExitCode(byCommand.get("build")), 0);
      assert.equal(browser.commandEntryExitCode(byCommand.get("audit")), 2);
      assert.equal(browser.commandEntryOutput(byCommand.get("build")), "building\nbuilt");
      assert.equal(browser.commandEntryExitCode(byCommand.get("read report")), 0);
      const background = byCommand.get("new background task");
      assert.equal(background.asyncCellId, "30");
      assert.equal(background.asyncCompletedRecord, undefined);
      assert.equal(browser.commandEntryExitCode(background), null,
        "a completed outer JavaScript call must not complete an unpolled child command");
    });
  }
}

test("browser decodes settled transport wrappers without decoding unrelated program JSON", () => {
  const browser = browserHelpers();
  assert.equal(browser.commandOutputText(JSON.stringify(wrap({ output: "done", exit_code: 0 }))), "done");
  const programJson = JSON.stringify({ status: "fulfilled", value: { message: "application result" } });
  assert.equal(browser.commandOutputText(programJson), programJson);
});

function convertRecords(records, pipeline) {
  if (pipeline === "runner") {
    const converter = new CodexSessionConverter();
    return records.map(record => {
      const event = converter.convert(record);
      return event ? { recordedAt: record.timestamp, threadId: "thread", turnNumber: 1,
        eventType: event.type, event } : null;
    }).filter(Boolean);
  }
  const server = vm.createContext({ codexCommandCompletionEvent });
  loadFunctions("../ralph-viz/server.js", server);
  const context = {
    threadId: "thread", resolveTurnNumber: () => 1,
    commandsByCallId: new Map(), functionCallsByCallId: new Map(),
    commandsBySessionId: new Map(), sessionIdsByStoreKey: new Map(),
  };
  return records.map(record => server.convertCodexSessionRecord(record, context)).filter(Boolean);
}

function nativeCompletion(session, exitCode, timestamp = "2026-10-02T05:05:17.029Z") {
  return {
    type: "event_msg", timestamp,
    payload: { type: "item_completed", item: {
      type: "CommandExecution", id: `exec-${session}`, process_id: String(session),
      command: ["/bin/bash", "-lc", "build"], source: "unified_exec_startup",
      status: exitCode === 0 ? "completed" : "failed", exit_code: exitCode,
      aggregated_output: "", duration: { secs: 3, nanos: 221307856 },
    } },
  };
}

function unpolledCommand() {
  return [
    { type: "response_item", timestamp: "2026-10-02T05:05:13.977Z",
      payload: { type: "custom_tool_call", name: "exec", call_id: "edit-build",
        input: 'text(await tools.exec_command({cmd:"build",yield_time_ms:1000}));' } },
    { type: "response_item", timestamp: "2026-10-02T05:05:14.980Z",
      payload: { type: "custom_tool_call_output", call_id: "edit-build", output: [
        { type: "input_text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
        { type: "input_text", text: JSON.stringify({ session_id: 84017, output: "" }) },
      ] } },
  ];
}

for (const pipeline of ["runner", "server"]) {
  test(`${pipeline} consumes native completion for an unpolled silent command`, () => {
    const browser = browserHelpers();
    const events = convertRecords([...unpolledCommand(), nativeCompletion(84017, 2)], pipeline);
    const entries = browser.buildDisplayEntries(events);
    assert.equal(entries.length, 1, "native status evidence must not create a duplicate card");
    assert.equal(browser.commandEntryExitCode(entries[0]), 2);
    assert.equal(entries[0].asyncCompletedRecord.recordedAt, "2026-10-02T05:05:17.029Z");
  });

  test(`${pipeline} matches a native completion delivered before its asynchronous tool result`, () => {
    const browser = browserHelpers();
    const [start, output] = unpolledCommand();
    const events = convertRecords([start,
      nativeCompletion(84017, 0, "2026-10-02T05:05:14.500Z"), output], pipeline);
    const entries = browser.buildDisplayEntries(events);
    assert.equal(entries.length, 1);
    assert.equal(browser.commandEntryExitCode(entries[0]), 0);
    assert.ok(entries[0].asyncCompletedRecord);
  });

  test(`${pipeline} keeps native completions isolated between concurrent batch commands`, () => {
    const browser = browserHelpers();
    const records = fixture(serializers["separate settled results"]).slice(0, 2);
    records.push(nativeCompletion(10, 2));
    const entries = browser.buildDisplayEntries(convertRecords(records, pipeline));
    assert.equal(entries.length, 2);
    const build = entries.find(entry => entry.startRecord.event.item.command === "build");
    const audit = entries.find(entry => entry.startRecord.event.item.command === "audit");
    assert.equal(browser.commandEntryExitCode(build), 2);
    assert.equal(browser.commandEntryExitCode(audit), null);
    assert.equal(audit.asyncCompletedRecord, undefined);
  });

  test(`${pipeline} attaches later batched polls to commands already completed by native events`, () => {
    const browser = browserHelpers();
    const records = fixture(serializers["separate settled results"]);
    records.splice(2, 0,
      nativeCompletion(10, 0, new Date(2200).toISOString()),
      nativeCompletion(20, 2, new Date(2300).toISOString()));
    const entries = browser.buildDisplayEntries(convertRecords(records, pipeline));
    assert.equal(entries.length, 4, "a delayed poll must not create a second command card");
    const build = entries.find(entry => entry.startRecord.event.item.command === "build");
    assert.equal(browser.commandEntryOutput(build), "building\nbuilt");
    assert.equal(browser.commandEntryExitCode(build), 0);
    assert.equal(build.asyncCompletedRecord.recordedAt, new Date(2200).toISOString(),
      "the recorded process completion time must survive a later poll");
  });
}

test("native completion evidence survives merging with existing command cards and event filtering", () => {
  const browser = browserHelpers();
  browser.eventFilter = { value: "item.completed" };
  browser.NOISE_TYPES = new Set();
  const primary = convertRecords(unpolledCommand(), "runner");
  const completions = convertRecords([nativeCompletion(84017, 2)], "server");
  const merged = mergeEventStreams(primary, completions);
  assert.equal(merged.length, 3, "command-card suppression must not discard status evidence");
  assert.ok(browser.filterRecords(merged).some(record => record.eventType === "codex.command.completed"));
  assert.equal(browser.commandEntryExitCode(browser.buildDisplayEntries(merged)[0]), 2);
});

test("native completion does not close another thread or turn that reused a session ID", () => {
  const browser = browserHelpers();
  const events = convertRecords([...unpolledCommand(), nativeCompletion(84017, 2)], "runner");
  for (const mismatch of [{ threadId: "other-thread" }, { turnNumber: 2 }]) {
    const records = [...events.slice(0, 2), { ...events[2], ...mismatch }];
    const entries = browser.buildDisplayEntries(records);
    assert.equal(browser.commandEntryExitCode(entries[0]), null);
    assert.equal(entries[0].asyncCompletedRecord, undefined);
  }
});

test("native completion without an actual exit code cannot invent a finished process", () => {
  const record = nativeCompletion(84017, null);
  assert.equal(codexCommandCompletionEvent(record.payload), null);
  assert.equal(codexCommandCompletionEvent({ type: "item_completed",
    item: { type: "Reasoning", process_id: "84017", exit_code: 0 } }), null);
});
