import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { CodexSessionConverter } from "../codex-session-events.js";

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
