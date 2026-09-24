import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("live provider usage includes an active turn and resets at the next turn", async (t) => {
  const originalCwd = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-provider-live-usage-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  });
  const runName = "fixture-gpt-6-luna-max";
  const threadId = "strands-fixture";
  const eventsDir = path.join(root, ".ralph", runName, "events");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(path.join(root, "fixture.config.json"), JSON.stringify({
    name: "fixture", provider: "strands", model: "gpt-6-luna",
    reasoningEffort: "max", workdir: path.join(root, "work"),
  }));
  const usage = (input, output) => ({
    input_tokens: input, cached_input_tokens: 0, output_tokens: output,
    reasoning_output_tokens: 0, total_tokens: input + output,
  });
  const event = (turnNumber, second, eventType, data = {}) => ({
    recordedAt: `2026-09-23T01:00:${String(second).padStart(2, "0")}.000Z`,
    threadId, turnNumber, eventType,
    event: { type: eventType, ...data },
  });
  const records = [
    event(1, 0, "ralph.phase-status", { action: "turn-start",
      phaseStatus: { stage: "pa1", phase: "implement" },
      agentProfile: { provider: "strands", model: "gpt-6-luna" } }),
    event(1, 1, "codex.session.token_count", { counter_scope: "turn",
      counter_id: "first-attempt", usage: usage(100, 20) }),
    event(1, 2, "turn.completed", { usage: usage(100, 20) }),
    event(2, 3, "ralph.phase-status", { action: "turn-start",
      phaseStatus: { stage: "pa1", phase: "audit" },
      agentProfile: { provider: "strands", model: "gpt-6-luna" } }),
    event(2, 4, "codex.session.token_count", { counter_scope: "turn",
      counter_id: "second-attempt", usage: usage(150, 50) }),
    event(2, 5, "codex.session.token_count", { counter_scope: "turn",
      counter_id: "second-attempt", usage: usage(200, 50) }),
    event(2, 6, "codex.session.token_count", { counter_scope: "turn",
      counter_id: "resumed-attempt", usage: usage(30, 0) }),
  ];
  await fs.writeFile(path.join(eventsDir, "run.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`);

  process.chdir(root);
  const serverUrl = pathToFileURL(path.join(originalCwd, "ralph-viz", "server.js"));
  serverUrl.searchParams.set("provider-live-usage-test", String(Date.now()));
  const { requestHandler } = await import(serverUrl.href);
  const response = { status: null, rawBody: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.rawBody = String(body); } };
  await requestHandler({ method: "GET",
    url: `/api/run/${runName}/run?usage=fast`, headers: { host: "localhost" } }, response);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.rawBody);
  const byTurn = body.shapeUsage.runs[0].turnUsages;
  assert.equal(byTurn.find((entry) => entry.turnNumber === 1).usage.total_tokens, 120);
  assert.equal(byTurn.find((entry) => entry.turnNumber === 2).usage.total_tokens, 280);
  assert.equal(body.shapeUsage.usage.total_tokens, 400);

  const comparison = JSON.parse(execFileSync(process.execPath, [
    path.join(originalCwd, "scripts", "compare-pa-costs.js"),
    "--format", "json", "--through", "pa1",
    "--ralph-dir", path.join(root, ".ralph"), runName,
  ], { cwd: root, encoding: "utf8" }));
  const comparedTurns = comparison.runs[0].turnUsages;
  assert.equal(comparedTurns.find((entry) => entry.turnNumber === 1).usage.total_tokens, 120);
  assert.equal(comparedTurns.find((entry) => entry.turnNumber === 2).usage.total_tokens, 280);
});
