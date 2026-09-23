import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectSubagentEvents } from "../subagent-events.js";

const ROOT_THREAD = "11111111-1111-4111-8111-111111111111";
const TOOL_USE = "call_00_example";
const AGENT_ID = "a5ca33a42eacfe6bd";

function jsonl(records) {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// A subagent notification carries only a coarse <subagent_tokens> count. The
// real per-request usage lives in the child transcript, linked by toolUseId.
test("Claude subagent usage is recovered from the child transcript", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-claude-subusage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const claudeDir = path.join(root, "projects", "-work-checkout");
  const subagentDir = path.join(claudeDir, ROOT_THREAD, "subagents");
  await fs.mkdir(subagentDir, { recursive: true });

  // Parent transcript: an Agent launch plus its completion notification.
  const parent = [
    {
      type: "assistant",
      timestamp: "2026-09-17T09:12:00.000Z",
      message: {
        id: "msg-start",
        content: [{
          type: "tool_use",
          id: TOOL_USE,
          name: "Agent",
          input: { description: "Fuzz operators", prompt: "Fuzz the operator set." },
        }],
      },
    },
    {
      type: "attachment",
      timestamp: "2026-09-17T09:30:00.000Z",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: [
          "<task-notification>",
          "<tool-use-id>" + TOOL_USE + "</tool-use-id>",
          `<status>completed</status>`,
          "<summary>Agent \"Fuzz operators\" finished</summary>",
          "<result>No divergences.</result>",
          "<usage><subagent_tokens>2287</subagent_tokens><tool_uses>97</tool_uses></usage>",
          "</task-notification>",
        ].join("\n"),
      },
    },
  ];
  await fs.writeFile(path.join(claudeDir, `${ROOT_THREAD}.jsonl`), jsonl(parent));

  // Child transcript: the same assistant message appended twice, with the
  // first copy a streaming snapshot carrying no usable usage.
  const usage = (input, cache, output, cacheCreation = 0) => ({
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cache,
    output_tokens: output,
  });
  const child = [
    {
      type: "assistant",
      timestamp: "2026-09-17T09:12:48.836Z",
      message: { id: "gen-1", model: "deepseek/deepseek-v4.1-flash", content: [], usage: usage(0, null, 0) },
    },
    {
      type: "assistant",
      timestamp: "2026-09-17T09:12:53.959Z",
      message: {
        id: "gen-1",
        model: "deepseek/deepseek-v4.1-flash",
        content: [{ type: "text", text: "No divergences." }],
        usage: usage(2162, 27648, 1718),
      },
    },
    {
      type: "assistant",
      timestamp: "2026-09-17T09:13:10.000Z",
      message: {
        id: "gen-2",
        model: "deepseek/deepseek-v4.1-flash",
        content: [{ type: "text", text: "No divergences." }],
        usage: usage(500, 1000, 200, 350),
      },
    },
  ];
  await fs.writeFile(path.join(subagentDir, `agent-${AGENT_ID}.jsonl`), jsonl(child));
  await fs.writeFile(
    path.join(subagentDir, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ toolUseId: TOOL_USE, description: "Fuzz operators" }),
  );

  const events = [{
    recordedAt: "2026-09-17T09:12:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 1,
    eventType: "ralph.prompt",
    event: { type: "ralph.prompt", prompt: "Implement PA2." },
  }, {
    recordedAt: "2026-09-17T09:31:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 2,
    eventType: "turn.completed",
    event: { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } },
  }];

  const additions = await collectSubagentEvents(events, {
    claudeDir: path.join(root, "projects"),
    resultLimit: 1000,
  });
  const completed = additions.find(
    (a) => a.event?.item?.type === "subagent" && a.event.item.status === "completed",
  );
  assert.ok(completed, "a completed subagent item is synthesized");

  // Duplicate copies are collapsed; only the most complete copy of gen-1 counts.
  assert.deepEqual(completed.event.item.usage, {
    input_tokens: 2162 + 27648 + 500 + 1000 + 350,
    cached_input_tokens: 27648 + 1000,
    output_tokens: 1718 + 200,
    reasoning_output_tokens: 0,
    total_tokens: 2162 + 27648 + 500 + 1000 + 350 + 1718 + 200,
  });
  assert.equal(completed.event.item.model, "deepseek/deepseek-v4.1-flash");
  // The coarse notification count is retained for the stats view.
  assert.equal(completed.event.item.subagent_tokens, 2287);
});

test("a subagent with no matching transcript still reports its notification", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-claude-subusage-nomatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const claudeDir = path.join(root, "projects", "-work-checkout");
  await fs.mkdir(claudeDir, { recursive: true });
  const parent = [{
    type: "assistant",
    timestamp: "2026-09-17T09:12:00.000Z",
    message: {
      id: "msg-start",
      content: [{ type: "tool_use", id: TOOL_USE, name: "Agent", input: { description: "Fuzz" } }],
    },
  }, {
    type: "attachment",
    timestamp: "2026-09-17T09:30:00.000Z",
    attachment: {
      type: "queued_command",
      commandMode: "task-notification",
      prompt: [
        "<task-notification>",
        "<tool-use-id>" + TOOL_USE + "</tool-use-id>",
        "<status>completed</status>",
        "<summary>Agent \"Fuzz\" finished</summary>",
        "<result>done</result>",
        "<usage><subagent_tokens>1200</subagent_tokens></usage>",
        "</task-notification>",
      ].join("\n"),
    },
  }];
  await fs.writeFile(path.join(claudeDir, `${ROOT_THREAD}.jsonl`), jsonl(parent));

  const additions = await collectSubagentEvents([
    { recordedAt: "2026-09-17T09:12:00.000Z", threadId: ROOT_THREAD, turnNumber: 1,
      eventType: "ralph.prompt", event: { type: "ralph.prompt", prompt: "x" } },
    { recordedAt: "2026-09-17T09:31:00.000Z", threadId: ROOT_THREAD, turnNumber: 2,
      eventType: "turn.completed", event: { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } } },
  ], { claudeDir: path.join(root, "projects"), resultLimit: 1000 });

  const completed = additions.find(
    (a) => a.event?.item?.type === "subagent" && a.event.item.status === "completed",
  );
  assert.ok(completed, "the notification item is still emitted");
  assert.equal(completed.event.item.subagent_tokens, 1200);
  assert.equal(completed.event.item.usage, undefined, "no usage without a transcript");

  // A live run can create the child metadata after an earlier collection.
  const subagentDir = path.join(claudeDir, ROOT_THREAD, "subagents");
  await fs.mkdir(subagentDir, { recursive: true });
  await fs.writeFile(path.join(subagentDir, `agent-${AGENT_ID}.jsonl`), jsonl([{
    type: "assistant",
    timestamp: "2026-09-17T09:29:00.000Z",
    message: {
      id: "gen-late",
      model: "deepseek/deepseek-v4.1-flash",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  }]));
  await fs.writeFile(
    path.join(subagentDir, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ toolUseId: TOOL_USE }),
  );
  const refreshed = await collectSubagentEvents([
    { recordedAt: "2026-09-17T09:12:00.000Z", threadId: ROOT_THREAD, turnNumber: 1,
      eventType: "ralph.prompt", event: { type: "ralph.prompt", prompt: "x" } },
    { recordedAt: "2026-09-17T09:31:00.000Z", threadId: ROOT_THREAD, turnNumber: 2,
      eventType: "turn.completed", event: { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } } },
  ], { claudeDir: path.join(root, "projects"), resultLimit: 1000 });
  const recovered = refreshed.find(
    (a) => a.event?.item?.type === "subagent" && a.event.item.status === "completed",
  );
  assert.equal(recovered.event.item.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(recovered.event.item.usage.total_tokens, 120);
});
