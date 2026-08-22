import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_THREAD = "11111111-1111-4111-8111-111111111111";
const CHILD_THREAD = "22222222-2222-4222-8222-222222222222";

test("tail detail keeps child cards in the subagent trajectory while retaining progress", async (t) => {
  const originalCwd = process.cwd();
  const originalCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-parent-feed-"));
  t.after(async () => {
    process.chdir(originalCwd);
    if (originalCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const runDir = path.join(root, ".ralph", "fixture", "events");
  const sessionDir = path.join(root, "codex", "sessions", "2026", "08", "22");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  await writeJsonl(path.join(runDir, "run.jsonl"), [{
    recordedAt: "2026-08-22T14:00:00.000Z",
    threadId: ROOT_THREAD,
    turnNumber: 1,
    eventType: "ralph.prompt",
    event: { type: "ralph.prompt", prompt: "Supervise PA2." },
  }]);
  await writeJsonl(path.join(sessionDir, `rollout-root-${ROOT_THREAD}.jsonl`), [
    record("2026-08-22T14:00:01.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "spawn",
      output: JSON.stringify({ agent_id: CHILD_THREAD, nickname: "Luna worker" }),
    }),
  ]);
  await writeJsonl(path.join(sessionDir, `rollout-child-${CHILD_THREAD}.jsonl`), [
    record("2026-08-22T14:00:00.500Z", "session_meta", {
      id: CHILD_THREAD,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT_THREAD } } },
    }),
    record("2026-08-22T14:00:00.600Z", "turn_context", {
      model: "gpt-5.6-luna",
      effort: "max",
    }),
    record("2026-08-22T14:00:00.700Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Implement and test PA2." }],
    }),
    record("2026-08-22T14:00:02.000Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "child-test",
      arguments: JSON.stringify({ cmd: "make test-pa2" }),
    }),
    record("2026-08-22T14:00:03.000Z", "response_item", {
      type: "function_call_output",
      call_id: "child-test",
      output: "===== pa2 =====\n===== TEST SUMMARY: 61 / 62 TESTS PASSED =====\n",
    }),
    record("2026-08-22T14:00:04.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Child-only checkpoint details." }],
    }),
  ]);

  process.chdir(root);
  process.env.CODEX_HOME = path.join(root, "codex");
  const serverUrl = pathToFileURL(path.join(originalCwd, "ralph-viz", "server.js"));
  serverUrl.searchParams.set("parent-feed-test", String(Date.now()));
  const { requestHandler } = await import(serverUrl.href);
  const response = await requestJson(
    requestHandler,
    "/api/run/fixture%2Frun?codex=tail&tailTurns=2&usage=skip",
  );

  assert.equal(response.status, 200);
  const events = response.body.events;
  assert.ok(events.some((event) => event.event?.item?.type === "subagent"));
  assert.ok(events.some((event) =>
    event.threadId === CHILD_THREAD && event.eventType === "ralph.agent-progress"));
  assert.equal(events.some((event) =>
    event.threadId === CHILD_THREAD && event.event?.item?.type === "command_execution"), false);
  assert.equal(events.some((event) =>
    event.threadId === CHILD_THREAD && event.event?.item?.type === "agent_message"), false);
});

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

async function writeJsonl(filePath, records) {
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
}

async function requestJson(requestHandler, url) {
  const response = {
    status: null,
    headers: null,
    rawBody: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.rawBody = String(body);
    },
  };
  await requestHandler({ method: "GET", url, headers: { host: "localhost" } }, response);
  return { status: response.status, body: JSON.parse(response.rawBody) };
}
