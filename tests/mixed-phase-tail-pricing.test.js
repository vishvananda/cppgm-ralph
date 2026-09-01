import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const RUN_NAME = "fixture-claude-fable-5-xhigh";
const LUNA_THREAD = "11111111-1111-4111-8111-111111111111";
const FABLE_THREAD_2 = "22222222-2222-4222-8222-222222222222";
const FABLE_THREAD_3 = "33333333-3333-4333-8333-333333333333";

test("tail detail prices historical root turns with their phase models", async (t) => {
  const originalCwd = process.cwd();
  const originalCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-mixed-tail-price-"));
  t.after(async () => {
    process.chdir(originalCwd);
    if (originalCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(root, "fixture.config.json"), JSON.stringify({
    name: "fixture",
    provider: "claude",
    model: "claude-fable-5",
    reasoningEffort: "xhigh",
    workdir: path.join(root, "work"),
  }));
  const eventsDir = path.join(root, ".ralph", RUN_NAME, "events");
  await fs.mkdir(eventsDir, { recursive: true });
  await writeJsonl(path.join(eventsDir, "run.jsonl"), [
    ...turnEvents(1, LUNA_THREAD, "gpt-5.6-luna", "2026-08-22T14:00:00", null),
    ...turnEvents(2, FABLE_THREAD_2, "claude-fable-5", "2026-08-22T14:01:00", 0.01234),
    ...turnEvents(3, FABLE_THREAD_3, "claude-fable-5", "2026-08-22T14:02:00", 0.01234),
  ]);

  process.chdir(root);
  process.env.CODEX_HOME = path.join(root, "codex");
  const serverUrl = pathToFileURL(path.join(originalCwd, "ralph-viz", "server.js"));
  serverUrl.searchParams.set("mixed-tail-price-test", String(Date.now()));
  const { requestHandler } = await import(serverUrl.href);
  const response = await requestJson(
    requestHandler,
    `/api/run/${encodeURIComponent(`${RUN_NAME}/run`)}?codex=tail&tailTurns=2&usage=fast`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.events.some((event) => event.turnNumber === 1), false);
  const firstTurn = response.body.shapeUsage.runs[0].turnUsages
    .find((entry) => entry.turnNumber === 1);
  assert.equal(firstTurn.usage.model_usage[0].model, "gpt-5.6-luna");
  assert.ok(Math.abs(firstTurn.usage.cost_usd - 0.00023) < 1e-12);
  assert.deepEqual(
    response.body.shapeUsage.usage.model_usage.map((entry) => entry.model),
    ["claude-fable-5", "gpt-5.6-luna"],
  );
});

function turnEvents(turnNumber, threadId, model, minutePrefix, totalCostUsd) {
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
    reasoning_output_tokens: 0,
    total_tokens: 1100,
    ...(totalCostUsd == null ? {} : { total_cost_usd: totalCostUsd }),
  };
  return [
    {
      recordedAt: `${minutePrefix}:00.000Z`,
      threadId,
      turnNumber,
      eventType: "ralph.phase-status",
      event: {
        type: "ralph.phase-status",
        action: "turn-start",
        agentProfile: { provider: model.startsWith("gpt-") ? "codex" : "claude", model },
      },
    },
    {
      recordedAt: `${minutePrefix}:01.000Z`,
      threadId,
      turnNumber,
      eventType: "codex.session.token_count",
      event: { type: "codex.session.token_count", thread_id: threadId, usage },
    },
    {
      recordedAt: `${minutePrefix}:02.000Z`,
      threadId,
      turnNumber,
      eventType: "turn.completed",
      event: { type: "turn.completed", thread_id: threadId, usage },
    },
  ];
}

async function writeJsonl(filePath, records) {
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
}

async function requestJson(requestHandler, url) {
  const response = {
    status: null,
    rawBody: "",
    writeHead(status) {
      this.status = status;
    },
    end(body = "") {
      this.rawBody = String(body);
    },
  };
  await requestHandler({ method: "GET", url, headers: { host: "localhost" } }, response);
  return { status: response.status, body: JSON.parse(response.rawBody) };
}
