import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_RUNS,
  main as exportViz,
  mergeComparisonUpdates,
} from "../scripts/export-viz-static.js";

test("static export defaults include all three v3 runs", () => {
  assert.ok(DEFAULT_RUNS.includes("v3opus-claude-opus-5-xhigh"));
  assert.ok(DEFAULT_RUNS.includes("v3codex-gpt-5.6-sol-xhigh"));
  assert.ok(DEFAULT_RUNS.includes("v3multi-gpt-5.6-sol-xhigh"));
});

test("incremental comparison replaces only changed run columns", () => {
  const runs = [resolvedRun("old-a"), resolvedRun("old-b"), resolvedRun("active")];
  const previous = comparison([
    comparisonRun("old-a"),
    comparisonRun("old-b"),
    comparisonRun("active"),
  ], [1, 2, 3]);
  const updated = comparison([comparisonRun("active")], [30]);

  const merged = mergeComparisonUpdates(previous, updated, runs);

  assert.deepEqual(merged.runs.map((run) => run.spec), ["old-a", "old-b", "active"]);
  assert.deepEqual(merged.runs.map((run) => run.label), ["old-a", "old-b", "active"]);
  assert.deepEqual(merged.rows[0].runs.map((run) => run.cost), [1, 2, 30]);
  assert.equal(merged.runs[0].total.cost, 1);
  assert.equal(merged.runs[2].total.cost, 30);
});

test("static export reuses unchanged run artifacts and rebuilds changed runs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-static-export-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ralphDir = path.join(root, ".ralph");
  const workDir = path.join(root, "work");
  const outDir = path.join(root, "out");
  const codexDir = path.join(root, "codex", "sessions");
  const claudeDir = path.join(root, "claude");
  const eventsDir = path.join(ralphDir, "fixture", "events");
  const eventPath = path.join(eventsDir, "run.jsonl");
  await Promise.all([
    fs.mkdir(eventsDir, { recursive: true }),
    fs.mkdir(workDir, { recursive: true }),
    fs.mkdir(codexDir, { recursive: true }),
    fs.mkdir(claudeDir, { recursive: true }),
  ]);
  await fs.writeFile(eventPath, `${JSON.stringify(event(1, "ralph.prompt"))}\n`);

  const args = [
    "--out", outDir,
    "--run", "fixture",
    "--ralph-dir", ralphDir,
    "--work-dir", workDir,
    "--codex-dir", codexDir,
    "--claude-dir", claudeDir,
    "--no-compare",
  ];
  await exportViz(args);
  const manifestPath = path.join(outDir, "data", "runs.json");
  const first = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const summaryPath = path.join(outDir, "data", first.runs[0].dataPath);
  const firstSummary = await fs.readFile(summaryPath, "utf8");
  assert.equal(first.source.reusedRuns, 0);
  assert.equal(first.source.exportedRuns, 1);
  assert.equal(first.runs[0].exportSettled, true);

  await exportViz(args);
  const second = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(second.source.reusedRuns, 1);
  assert.equal(second.source.exportedRuns, 0);
  assert.equal(await fs.readFile(summaryPath, "utf8"), firstSummary);

  await fs.appendFile(eventPath, `${JSON.stringify(event(1, "item.completed"))}\n`);
  await exportViz(args);
  const third = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const thirdSummary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  assert.equal(third.source.reusedRuns, 0);
  assert.equal(third.source.exportedRuns, 1);
  assert.equal(thirdSummary.eventCount, 2);
});

test("static export retains an archived run from the published catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-static-archive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, "out");
  const ralphDir = path.join(root, ".ralph");
  const workDir = path.join(root, "work");
  const codexDir = path.join(root, "codex", "sessions");
  const claudeDir = path.join(root, "claude");
  await Promise.all([
    fs.mkdir(ralphDir, { recursive: true }),
    fs.mkdir(workDir, { recursive: true }),
    fs.mkdir(codexDir, { recursive: true }),
    fs.mkdir(claudeDir, { recursive: true }),
  ]);

  const archived = {
    id: "archived/run",
    label: "archived",
    fileBase: "run",
    filePath: "/retired/.ralph/archived/events/run.jsonl",
    dataPath: "runs/archived/summary.json",
    safeId: "archived",
    exportFingerprint: "archived-fingerprint",
    exportSettled: true,
  };
  const publishedManifest = {
    formatVersion: 1,
    runs: [archived],
    comparisons: [{ path: "comparisons/pa-costs.json" }],
    source: {},
  };
  const publishedComparison = comparison([comparisonRun("archived")], [12]);
  publishedComparison.through = "pa39";
  const server = http.createServer((request, response) => {
    if (request.url === "/data/runs.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(publishedManifest));
    } else if (request.url === "/data/comparisons/pa-costs.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(publishedComparison));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  await exportViz([
    "--out", outDir,
    "--run", "archived",
    "--ralph-dir", ralphDir,
    "--work-dir", workDir,
    "--codex-dir", codexDir,
    "--claude-dir", claudeDir,
    "--published-base", `http://127.0.0.1:${address.port}/`,
  ]);

  const exported = JSON.parse(await fs.readFile(
    path.join(outDir, "data", "runs.json"),
    "utf8",
  ));
  assert.equal(exported.runs.length, 1);
  assert.equal(exported.runs[0].id, "archived/run");
  assert.equal(exported.runs[0].exportRetained, true);
  assert.equal(exported.source.retainedRuns, 1);
  const exportedComparison = JSON.parse(await fs.readFile(
    path.join(outDir, "data", "comparisons", "pa-costs.json"),
    "utf8",
  ));
  assert.equal(exportedComparison.runs.length, 1);
  assert.equal(exportedComparison.runs[0].spec, "archived");
});

function event(turnNumber, eventType) {
  return {
    recordedAt: `2026-08-22T00:00:0${turnNumber}.000Z`,
    threadId: "11111111-1111-4111-8111-111111111111",
    turnNumber,
    eventType,
    event: { type: eventType },
  };
}

function resolvedRun(spec) {
  return {
    spec,
    label: spec,
    filePath: `/runs/${spec}/events/run.jsonl`,
  };
}

function comparisonRun(spec) {
  return {
    spec,
    label: `9-${spec}`,
    filePath: `/runs/${spec}/events/run.jsonl`,
    total: { cost: spec === "active" ? 30 : spec === "old-b" ? 2 : 1 },
  };
}

function comparison(runs, costs) {
  return {
    generatedAt: "2026-08-22T00:00:00.000Z",
    through: "pa1",
    nativeThrough: "pa1",
    runs,
    rows: [{
      pa: "pa1",
      runs: costs.map((cost) => ({
        turns: ["1"],
        durationMs: cost * 1000,
        totalDurationMs: cost * 1000,
        cost,
        status: "complete",
      })),
    }],
  };
}
