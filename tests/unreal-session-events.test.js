import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addUnrealSessionDisplayEvents, unrealSessionPathsForEvents } from "../unreal-session-events.js";
import { main as exportViz } from "../scripts/export-viz-static.js";

test("an active Unreal turn shows persisted command results and readable reasoning summaries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-unreal-live-display-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ralphDir = path.join(root, ".ralph");
  const runName = "fixture-gpt-6-luna-max";
  const threadId = "unreal-fixture";
  const eventPath = path.join(ralphDir, runName, "events", "run.jsonl");
  const sessionPath = path.join(ralphDir, "unreal-provider", runName, "sessions", `${threadId}.session.jsonl`);
  await fs.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  const start = {
    recordedAt: "2026-09-23T01:00:00Z", threadId, turnNumber: 1,
    eventType: "item.started",
    event: { type: "item.started", item: {
      id: "call-1", type: "command_execution", status: "in_progress", command: "echo checked",
    } },
  };
  await fs.writeFile(eventPath, `${JSON.stringify(start)}\n`);
  const reasoning = { type: "item", data: { Item: {
    Sequence: 2, RecordedAt: "2026-09-23T01:00:01Z", Kind: "model_response",
    Data: { Response: { Output: [
      { ProviderID: "reasoning-1", Type: "reasoning",
        Data: { Summary: ["**Checking files**"], Raw: { encrypted: "private" } } },
      { ProviderID: "tool-1", Type: "tool_call", Data: {
        CallID: "call-1", Name: "Bash", Arguments: '{"command":"echo checked"}',
      } },
    ], Usage: { InputTokens: 100, CachedInputTokens: 80, OutputTokens: 20, ReasoningTokens: 15 } } },
  } } };
  const completed = { type: "item", data: {
    Item: { RecordedAt: "2026-09-23T01:00:02Z", Kind: "tool_call_status",
      Data: { CallID: "call-1", Status: { WaitingFor: ["op-1"] } } },
    Operations: [{ ID: "op-1", Status: "completed", State: {
      Result: { Out: "checked\n", Err: "", ExitCode: 0 },
    } }],
  } };
  await fs.writeFile(sessionPath, `${JSON.stringify(reasoning)}\n${JSON.stringify(completed)}\n`);

  assert.deepEqual(await unrealSessionPathsForEvents([start], { filePath: eventPath }), [sessionPath]);
  const events = await addUnrealSessionDisplayEvents([start], { filePath: eventPath });
  assert.equal(events.length, 4);
  assert.equal(events.find((record) => record.event?.item?.type === "reasoning")?.event.item.text,
    "**Checking files**");
  assert.equal(events.find((record) => record.event?.item?.type === "reasoning")?.event.item.response_step, 1);
  assert.equal(events.find((record) => record.event?.item?.type === "reasoning")?.event.item.response_command_count, 1);
  assert.equal(events.find((record) => record.eventType === "item.started")?.event.item.response_step, 1);
  assert.deepEqual(events.find((record) => record.eventType === "codex.session.token_count")?.event.usage, {
    input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
    reasoning_output_tokens: 15, total_tokens: 120,
  });
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(events.find((record) => record.eventType === "item.completed" &&
    record.event.item.type === "command_execution")?.event.item.aggregated_output, "checked\n");
  assert.equal((await addUnrealSessionDisplayEvents(events, { filePath: eventPath })).length, 4);

  const liveUsage = {
    ...start, recordedAt: "2026-09-23T01:00:01Z",
    eventType: "codex.session.token_count",
    event: { type: "codex.session.token_count", source: "unreal-live",
      counter_scope: "turn", usage: {
        input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
        reasoning_output_tokens: 15, total_tokens: 120,
      } },
  };
  const withLiveUsage = await addUnrealSessionDisplayEvents([start, liveUsage], { filePath: eventPath });
  assert.deepEqual(withLiveUsage.filter((record) => record.eventType === "codex.session.token_count")
    .map((record) => record.event.source), ["unreal-live"]);

  const outDir = path.join(root, "export");
  await exportViz(["--out", outDir, "--run", runName, "--ralph-dir", ralphDir,
    "--work-dir", root, "--no-compare", "--no-published-base"]);
  const summary = JSON.parse(await fs.readFile(path.join(outDir, "data", "runs", runName, "summary.json")));
  const turn = JSON.parse(await fs.readFile(path.join(outDir, "data", summary.turns[0].path)));
  assert.equal(turn.events.filter((record) => record.eventType === "item.completed").length, 2);
});
