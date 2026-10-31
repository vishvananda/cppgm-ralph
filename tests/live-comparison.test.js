import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("combined and individual comparisons include PA35 beyond the published range", { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-live-comparison-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shapes = ["v5sol-gpt-6.1-sol-high", "v5rust-gpt-6.1-sol-high"];
  for (const [index, shape] of shapes.entries()) {
    const eventsDir = path.join(root, ".ralph", shape, "events");
    await fs.mkdir(eventsDir, { recursive: true });
    const record = (recordedAt, eventType, event, turnNumber = 1) => ({
      recordedAt, threadId: `fixture-${index}`, turnNumber,
      eventType, event: { type: eventType, ...event },
    });
    const events = [
      record("2026-10-12T00:00:00Z", "ralph.phase-status", {
        action: "turn-start", phaseStatus: { stage: "pa1", phase: "implement", allRequiredPassed: false },
      }),
      record("2026-10-12T00:00:00Z", "ralph.prompt", { prompt: "Implement pa1" }),
      record("2026-10-12T00:10:00Z", "turn.completed", {
        usage: { input_tokens: 1000 * (index + 1), cached_input_tokens: 500, output_tokens: 100 },
      }),
      record("2026-10-12T00:11:00Z", "ralph.phase-status", {
        action: "turn-start", phaseStatus: { stage: "pa35", phase: "implement", allRequiredPassed: false },
      }, 2),
      record("2026-10-12T00:11:00Z", "ralph.prompt", { prompt: "Implement pa35" }, 2),
      record("2026-10-12T00:12:00Z", "turn.completed", {
        usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 200 },
      }, 2),
    ];
    await fs.writeFile(path.join(eventsDir, "run.jsonl"), events.map(JSON.stringify).join("\n") + "\n");
    await fs.writeFile(path.join(root, `${shape.split("-")[0]}.config.json`), JSON.stringify({
      name: shape.split("-")[0], model: "gpt-6.1-sol", reasoningEffort: "high", assignmentLayout: "v5",
    }));
  }
  let publishedRequests = 0;
  const published = http.createServer((_req, res) => {
    publishedRequests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      through: "pa39",
      runs: [{ spec: "baseline", comparisonComplete: true }, { spec: shapes[0] }],
      rows: [{ pa: "pa1", runs: [
        { cost: 7, durationMs: 7000, status: "complete", turns: [1] },
        { cost: 999, durationMs: 999000, status: "partial", turns: [1] },
      ] }],
    }));
  });
  published.listen(0, "127.0.0.1");
  await once(published, "listening");
  t.after(() => new Promise(resolve => published.close(resolve)));
  const serverUrl = new URL("../ralph-viz/server.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import http from 'node:http';
    import {requestHandler} from ${JSON.stringify(serverUrl)};
    const server=http.createServer((req,res)=>requestHandler(req,res).catch(error=>{
      res.writeHead(500);res.end(JSON.stringify({error:error.message}));
    }));
    server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `], {
    cwd: root,
    env: { ...process.env,
      CODEX_HOME: path.join(root, "codex"),
      CLAUDE_PROJECTS_DIR: path.join(root, "claude"),
      RALPH_VIZ_PUBLISHED_COMPARISON_URL: `http://127.0.0.1:${published.address().port}/comparison`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  const [port] = await once(child.stdout, "data");
  const base = `http://127.0.0.1:${String(port).trim()}`;
  const params = new URLSearchParams();
  for (const shape of shapes) params.append("run", `${shape}/run`);
  const response = await fetch(`${base}/api/comparison?${params}`);
  const data = await response.json();
  assert.equal(response.status, 200, `${JSON.stringify(data)} ${stderr}`);
  assert.equal(data.runs.length, 3);
  assert.deepEqual(data.runs.map(run => run.label), [
    "baseline", `${shapes[1]} (local)`, `${shapes[0]} (local)`,
  ]);
  assert.equal(data.runs[1].layout.id, "v5");
  assert.equal(data.runs[2].layout.id, "v5");
  assert.deepEqual(data.localRunIndices, [1, 2]);
  assert.equal(data.rows[0].runs[0].cost, 7);
  assert(data.rows[0].runs[1].cost > data.rows[0].runs[2].cost);
  assert.equal(data.through, "pa40");
  const reversed = new URLSearchParams();
  for (const shape of [...shapes].reverse()) reversed.append("run", `${shape}/run`);
  const cached = await (await fetch(`${base}/api/comparison?${reversed}`)).json();
  assert.equal(cached.generatedAt, data.generatedAt);
  assert.equal(publishedRequests, 1);
  const individualResponse = await fetch(`${base}/api/run-comparison/${encodeURIComponent(`${shapes[0]}/run`)}`);
  const individual = await individualResponse.json();
  assert.equal(individualResponse.status, 200, `${JSON.stringify(individual)} ${stderr}`);
  assert.equal(individual.through, "pa40", "the published cutoff cannot hide local PA35 (canonical PA40)");
  const singlePa35 = individual.rows.find(row => row.pa === "pa35").runs[individual.localRunIndex];
  const combinedPa35 = data.rows.find(row => row.pa === "pa35").runs[2];
  assert(singlePa35.cost > 0, "include optimization work in the individual graph");
  assert.equal(singlePa35.cost, combinedPa35.cost);
  assert.equal(singlePa35.durationMs, combinedPa35.durationMs);
  assert.equal((await fetch(`${base}/api/comparison?run=../invalid`)).status, 400);
});
