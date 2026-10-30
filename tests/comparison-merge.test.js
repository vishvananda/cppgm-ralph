import assert from "node:assert/strict";
import test from "node:test";
import { mergePublishedAndLocalComparison, mergePublishedAndLocalComparisons } from "../ralph-viz/server.js";
import "../ralph-viz/comparison-run-visibility.js";

function summary(cost, status = "complete") {
  return {
    turns: ["turn"],
    durationMs: cost * 1000,
    activeDurationMs: cost * 1000,
    totalDurationMs: cost * 1500,
    cost,
    status,
  };
}

test("all live runs replace their published duplicates and retain aligned stage columns", () => {
  const published = {
    through: "pa1",
    runs: [
      { spec: "baseline", comparisonComplete: true },
      { spec: "v5sol" }, { spec: "v5rust" }, { spec: "v5scratch" },
    ],
    rows: [{ pa: "pa1", runs: [summary(1), summary(2), summary(3), summary(4)] }],
  };
  const before = structuredClone(published);
  const locals = ["v5rust", "v5scratch", "v5sol"].map((shape, index) => ({
    runRef: { shape, filePath: `/work/.ralph/${shape}/events/run.jsonl` },
    localMtime: new Date(`2026-10-12T00:00:0${index}Z`),
    comparison: {
      through: "pa2",
      runs: [{ spec: `${shape}/run`, layout: "v5" }],
      rows: [
        { pa: "pa1", runs: [summary(10 + index)] },
        { pa: "pa2", runs: [index === 0 ? summary(20, "partial") : null] },
      ],
    },
  }));
  const merged = mergePublishedAndLocalComparisons(published, locals);
  assert.deepEqual(merged.runs.map(run => run.label), [
    "baseline", "v5rust (local)", "v5scratch (local)", "v5sol (local)",
  ]);
  assert.deepEqual(merged.rows[0].runs.map(run => run.cost), [1, 10, 11, 12]);
  assert.deepEqual(merged.rows[1].runs.map(run => run.status), [
    "not started", "partial", "not started", "not started",
  ]);
  assert.deepEqual(merged.localRunIndices, [1, 2, 3]);
  assert.deepEqual(merged.runs.map(globalThis.RALPH_COMPARISON_RUN_VISIBILITY.defaultVisible), [true, true, true, true]);
  assert.equal(merged.through, "pa2");
  assert.equal(merged.localUpdatedAt, "2026-10-12T00:00:02.000Z");
  assert.deepEqual(published, before);
});

test("live comparison remains usable when no current runs are active", () => {
  const merged = mergePublishedAndLocalComparisons({
    through: "pa1", runs: [{ spec: "baseline", comparisonComplete: true }],
    rows: [{ pa: "pa1", runs: [summary(3)] }],
  }, []);
  assert.equal(merged.rows[0].runs[0].cost, 3);
  assert.deepEqual(merged.localRunIndices, []);
});

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
  assert.deepEqual(merged.rows[0].runs.map((run) => run.totalDurationMs), [1500, 4500, 30000]);
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

test("live comparison preserves finished-run visibility while hiding unfinished baselines", () => {
  const localPath = "/work/.ralph/v4codex/events/run.jsonl";
  const published = {
    through: "pa39",
    runs: [
      { spec: "trusted", layout: "v2", comparisonComplete: true },
      { spec: "v3codex", layout: "v3", comparisonComplete: true },
      { spec: "v3multi", layout: "v3", comparisonComplete: false },
      { spec: "legacy-without-completion" },
      { spec: "v4codex", layout: "v4", comparisonComplete: false, filePath: localPath },
    ],
    rows: [{ pa: "pa1", runs: [summary(1), summary(2), summary(3), summary(4), summary(5)] }],
  };
  const before = structuredClone(published);
  const local = {
    through: "pa39",
    runs: [{ spec: "v4codex/run", layout: "v4", filePath: localPath }],
    rows: [{ pa: "pa1", runs: [summary(6, "partial")] }],
  };
  const merged = mergePublishedAndLocalComparison(published, local, {
    shape: "v4codex", filePath: localPath,
  }, new Date("2026-09-07T00:00:00Z"));

  assert.deepEqual(merged.runs.map(globalThis.RALPH_COMPARISON_RUN_VISIBILITY.defaultVisible), [
    true, true, false, false, true,
  ]);
  assert.equal(merged.runs[0].comparisonComplete, true);
  assert.equal(merged.runs[2].comparisonComplete, false);
  assert.equal(merged.runs.at(-1).highlighted, true);
  assert.equal(merged.runs.at(-1).layout.id, "v4");
  assert.equal(merged.rows[0].runs.at(-1).cost, 6, "local data replaces its published duplicate");
  assert.deepEqual(published, before, "published metadata is not mutated");
});
