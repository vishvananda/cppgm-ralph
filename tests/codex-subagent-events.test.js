import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectCodexSubagentEvents } from "../codex-subagent-events.js";

const ROOT_THREAD = "11111111-1111-4111-8111-111111111111";
const CHILD_THREAD = "22222222-2222-4222-8222-222222222222";

test("recognizes Codex child rollouts and attributes model, effort, usage, and cost inputs", async (t) => {
  const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-codex-subagents-"));
  t.after(() => fs.rm(codexDir, { recursive: true, force: true }));
  const sessionDir = path.join(codexDir, "sessions", "2026", "08", "22");
  await fs.mkdir(sessionDir, { recursive: true });

  await writeJsonl(path.join(sessionDir, `rollout-root-${ROOT_THREAD}.jsonl`), [
    record("2026-08-22T14:01:01.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "spawn",
      output: `Script completed\nOutput:\n{"agent_id":"${CHILD_THREAD}","nickname":"Luna worker"}`,
    }),
  ]);

  await writeJsonl(path.join(sessionDir, `rollout-child-${CHILD_THREAD}.jsonl`), [
    record("2026-08-22T14:01:00.000Z", "session_meta", {
      id: CHILD_THREAD,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT_THREAD,
            agent_nickname: "Luna worker",
          },
        },
      },
    }),
    record("2026-08-22T14:01:00.100Z", "turn_context", {
      model: "gpt-5.6-luna",
      effort: "max",
    }),
    record("2026-08-22T14:01:00.150Z", "response_item", {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "<recommended_plugins>injected context</recommended_plugins>\n<environment_context>fixture</environment_context>",
      }],
    }),
    record("2026-08-22T14:01:00.200Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Implement the focused PA1 repair." }],
    }),
    record("2026-08-22T14:01:02.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "edit",
      input: "text(await tools.apply_patch(patch));",
    }),
    record("2026-08-22T14:01:05.000Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 200,
          reasoning_output_tokens: 100,
          total_tokens: 1200,
        },
      },
    }),
    record("2026-08-22T14:01:06.000Z", "event_msg", {
      type: "task_complete",
      duration_ms: 6000,
      last_agent_message: "Implemented, validated, and committed the repair.",
    }),
  ]);

  const events = [{
    recordedAt: "2026-08-22T14:00:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 1,
    eventType: "ralph.prompt",
    event: { type: "ralph.prompt" },
  }];
  const additions = await collectCodexSubagentEvents(events, { codexDir });

  assert.equal(additions.length, 2);
  const started = additions[0];
  const completed = additions[1];
  assert.equal(started.eventType, "item.started");
  assert.equal(started.threadId, ROOT_THREAD);
  assert.equal(started.turnNumber, 1);
  assert.equal(started.event.item.id, CHILD_THREAD);
  assert.equal(started.event.item.parent_thread_id, ROOT_THREAD);
  assert.equal(started.event.item.model, "gpt-5.6-luna");
  assert.equal(started.event.item.reasoning_effort, "max");
  assert.equal(started.event.item.prompt, "Implement the focused PA1 repair.");

  assert.equal(completed.eventType, "item.completed");
  assert.equal(completed.event.item.status, "completed");
  assert.equal(completed.event.item.duration_ms, 6000);
  assert.equal(completed.event.item.tool_uses, 1);
  assert.equal(completed.event.item.subagent_tokens, 1200);
  assert.deepEqual(completed.event.item.usage, {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 200,
    reasoning_output_tokens: 100,
    total_tokens: 1200,
  });
  assert.match(completed.event.item.result, /validated, and committed/);
});

test("aggregates supervised turns of one Codex child without double counting the trajectory", async (t) => {
  const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-codex-subagents-"));
  t.after(() => fs.rm(codexDir, { recursive: true, force: true }));
  const sessionDir = path.join(codexDir, "sessions", "2026", "08", "22");
  await fs.mkdir(sessionDir, { recursive: true });

  await writeJsonl(path.join(sessionDir, `rollout-root-${ROOT_THREAD}.jsonl`), [
    record("2026-08-22T15:01:01.000Z", "response_item", {
      type: "custom_tool_call_output",
      output: `{"agent_id":"${CHILD_THREAD}","nickname":"Luna worker"}`,
    }),
  ]);
  await writeJsonl(path.join(sessionDir, `rollout-child-${CHILD_THREAD}.jsonl`), [
    record("2026-08-22T15:01:00.000Z", "session_meta", {
      id: CHILD_THREAD,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT_THREAD } } },
    }),
    record("2026-08-22T15:01:00.100Z", "turn_context", {
      model: "gpt-5.6-luna",
      effort: "max",
    }),
    record("2026-08-22T15:01:00.200Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Create an uncommitted milestone and stop." }],
    }),
    record("2026-08-22T15:01:01.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
    }),
    record("2026-08-22T15:01:03.000Z", "event_msg", {
      type: "task_complete",
      duration_ms: 3000,
      last_agent_message: "Milestone ready for review.",
    }),
    record("2026-08-22T15:02:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Apply the correction, validate, and commit." }],
    }),
    record("2026-08-22T15:02:01.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
    }),
    record("2026-08-22T15:02:04.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 1500, output_tokens: 300, total_tokens: 1800 } },
    }),
    record("2026-08-22T15:02:04.100Z", "event_msg", {
      type: "task_complete",
      duration_ms: 4000,
      last_agent_message: "Correction committed and worktree clean.",
    }),
  ]);

  const events = [{
    recordedAt: "2026-08-22T15:00:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 1,
    eventType: "ralph.prompt",
    event: { type: "ralph.prompt" },
  }];
  const additions = await collectCodexSubagentEvents(events, { codexDir });

  assert.equal(additions.length, 2);
  assert.equal(additions[0].event.item.prompt, "Create an uncommitted milestone and stop.");
  assert.equal(additions[1].event.item.duration_ms, 7000);
  assert.equal(additions[1].event.item.tool_uses, 2);
  assert.equal(additions[1].event.item.subagent_tokens, 1800);
  assert.match(additions[1].event.item.result, /Correction committed/);
});

test("marks a resumed Codex child running until its next milestone completes", async (t) => {
  const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-codex-subagents-"));
  t.after(() => fs.rm(codexDir, { recursive: true, force: true }));
  const sessionDir = path.join(codexDir, "sessions", "2026", "08", "22");
  await fs.mkdir(sessionDir, { recursive: true });

  await writeJsonl(path.join(sessionDir, `rollout-root-${ROOT_THREAD}.jsonl`), [
    record("2026-08-22T16:01:01.000Z", "response_item", {
      type: "custom_tool_call_output",
      output: `{"agent_id":"${CHILD_THREAD}"}`,
    }),
  ]);
  await writeJsonl(path.join(sessionDir, `rollout-child-${CHILD_THREAD}.jsonl`), [
    record("2026-08-22T16:01:00.000Z", "session_meta", {
      id: CHILD_THREAD,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT_THREAD } } },
    }),
    record("2026-08-22T16:01:00.100Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Prepare the milestone." }],
    }),
    record("2026-08-22T16:01:03.000Z", "event_msg", {
      type: "task_complete",
      duration_ms: 3000,
      last_agent_message: "Milestone ready.",
    }),
    record("2026-08-22T16:02:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue with the correction." }],
    }),
  ]);

  const events = [{
    recordedAt: "2026-08-22T16:00:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 1,
    eventType: "ralph.prompt",
    event: { type: "ralph.prompt" },
  }];
  const additions = await collectCodexSubagentEvents(events, { codexDir });

  assert.equal(additions.length, 1);
  assert.equal(additions[0].eventType, "item.started");
  assert.equal(additions[0].event.item.status, "running");
});

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

async function writeJsonl(filePath, records) {
  await fs.writeFile(filePath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
