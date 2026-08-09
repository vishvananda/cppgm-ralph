import assert from "node:assert/strict";
import test from "node:test";
import { mergePublishedAndLocalComparison } from "../ralph-viz/server.js";

function summary(cost, status = "complete") {
  return {
    turns: ["turn"],
    durationMs: cost * 1000,
    cost,
    status,
  };
}

test("live comparison replaces the matching published partial run", () => {
  const currentPath = "/work/.ralph/current-run/events/run.jsonl";
  const published = {
    generatedAt: "2026-08-08T00:00:00.000Z",
    through: "pa1",
    runs: [
      { label: "baseline", spec: "baseline", filePath: "/work/.ralph/baseline/events/run.jsonl" },
      { label: "current-run", spec: "current-run", filePath: currentPath },
      { label: "luna", spec: "luna", filePath: "/work/.ralph/luna/events/run.jsonl" },
    ],
    rows: [{
      pa: "pa1",
      runs: [summary(1), summary(10, "partial"), summary(3)],
    }],
  };
  const local = {
    runs: [{ label: "current-run/run", spec: "current-run/run", filePath: currentPath }],
    rows: [{ pa: "pa1", runs: [summary(20, "partial")] }],
  };

  const merged = mergePublishedAndLocalComparison(
    published,
    local,
    { shape: "current-run", filePath: currentPath },
    new Date("2026-08-09T00:00:00.000Z"),
  );

  assert.deepEqual(merged.runs.map((run) => run.label), [
    "baseline",
    "luna",
    "current-run (local)",
  ]);
  assert.equal(merged.localRunIndex, 2);
  assert.deepEqual(merged.rows[0].runs.map((run) => run.cost), [1, 3, 20]);
  assert.equal(merged.rows[0].runs[2].status, "partial");
});

test("live comparison retains an older published run with a different event file", () => {
  const published = {
    through: "pa1",
    runs: [{
      label: "current-run old",
      spec: "current-run",
      filePath: "/work/.ralph/current-run/events/old.jsonl",
    }],
    rows: [{ pa: "pa1", runs: [summary(4)] }],
  };
  const localPath = "/work/.ralph/current-run/events/new.jsonl";
  const local = {
    runs: [{ spec: "current-run/new", filePath: localPath }],
    rows: [{ pa: "pa1", runs: [summary(5, "partial")] }],
  };

  const merged = mergePublishedAndLocalComparison(
    published,
    local,
    { shape: "current-run", filePath: localPath },
    new Date("2026-08-09T00:00:00.000Z"),
  );

  assert.equal(merged.runs.length, 2);
  assert.deepEqual(merged.rows[0].runs.map((run) => run.cost), [4, 5]);
});
