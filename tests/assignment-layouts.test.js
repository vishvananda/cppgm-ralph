import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/assignment-layouts.js";

const layout = globalThis.RALPH_ASSIGNMENT_LAYOUT;

test("V2 and V3 assignment numbers map through the shared semantic order", () => {
  assert.equal(layout.sourcePaForTarget("v2", "v3", 14), 30);
  assert.equal(layout.sourcePaForTarget("v2", "v3", 15), 14);
  assert.equal(layout.sourcePaForTarget("v2", "v3", 30), 29);
  assert.equal(layout.sourcePaForTarget("v2", "v3", 31), 31);

  assert.equal(layout.sourcePaForTarget("v3", "v2", 14), 15);
  assert.equal(layout.sourcePaForTarget("v3", "v2", 29), 30);
  assert.equal(layout.sourcePaForTarget("v3", "v2", 30), 14);
});

test("comparison rows are remapped independently for each run layout", () => {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    pa: `pa${index + 1}`,
    runs: [`v2-${index + 1}`, `v3-${index + 1}`],
  }));
  const comparison = {
    runs: [{ layout: { id: "v2" } }, { layout: { id: "v3" } }],
    rows,
  };

  const v3 = layout.remapComparisonRows(comparison, "v3");
  assert.deepEqual(v3[13].runs, ["v2-30", "v3-14"]);
  assert.deepEqual(v3[14].runs, ["v2-14", "v3-15"]);

  const v2 = layout.remapComparisonRows(comparison, "v2");
  assert.deepEqual(v2[13].runs, ["v2-14", "v3-15"]);
  assert.deepEqual(v2[29].runs, ["v2-30", "v3-14"]);
});

test("legacy current metadata remains V2 while V3 names are a fallback", () => {
  assert.equal(layout.normalizeLayoutId("current"), "v2");
  assert.equal(layout.inferLayoutId("luna-gpt-5.6-luna-ultra"), "v2");
  assert.equal(layout.inferLayoutId("v3opus-claude-opus-5-xhigh"), "v3");
  assert.equal(layout.inferLayoutId("custom", "v3"), "v3");
  assert.equal(layout.inferLayoutId("v4codex-gpt-5.6-sol-xhigh"), "v4");
  assert.equal(layout.inferLayoutId("custom", "v4"), "v4");
});

test("V4 stage mapping aligns inception without duplicating removed stages", () => {
  assert.equal(layout.sourcePaForTarget("v4", "v3", 5), 4);
  assert.equal(layout.sourcePaForTarget("v4", "v3", 10), 5);
  assert.equal(layout.sourcePaForTarget("v4", "v3", 14), 9);
  assert.equal(layout.sourcePaForTarget("v4", "v3", 39), 34);
  assert.equal(layout.sourcePaForTarget("v2", "v4", 9), 30);
  for (const removed of [4, 6, 7, 8, 9]) {
    assert.equal(layout.sourcePaForTarget("v4", "v3", removed), null);
  }
  for (let stage = 1; stage <= 34; stage += 1) {
    assert.equal(layout.nativePaNumber("v4", layout.canonicalPaNumber("v4", stage)), stage);
  }
  assert.equal(layout.canonicalPaNumber("v4", 35), null);
});

test("V4 comparison rows expand to 39 legacy stages and stop at 34 in native order", () => {
  const v4Only = {
    runs: [{ layout: { id: "v4" } }],
    rows: Array.from({ length: 34 }, (_, index) => ({
      pa: `pa${index + 1}`, runs: [`v4-${index + 1}`],
    })),
  };
  const legacy = layout.remapComparisonRows(v4Only, "v3");
  assert.equal(legacy.length, 39);
  assert.deepEqual(legacy[3].runs, [null]);
  assert.deepEqual(legacy[4].runs, ["v4-4"]);
  assert.deepEqual(legacy[38].runs, ["v4-34"]);

  const mixed = {
    runs: [{ layout: { id: "v3" } }, { layout: { id: "v4" } }],
    rows: Array.from({ length: 39 }, (_, index) => ({
      pa: `pa${index + 1}`,
      runs: [`v3-${index + 1}`, index < 34 ? `v4-${index + 1}` : null],
    })),
  };
  const native = layout.remapComparisonRows(mixed, "v4");
  assert.equal(native.length, 34);
  assert.deepEqual(native[8].runs, ["v3-14", "v4-9"]);
  assert.deepEqual(native[33].runs, ["v3-39", "v4-34"]);
});

function mixedComparison() {
  return {
    through: "pa39",
    runs: ["v2", "v3", "v4"].map((id) => ({ layout: { id }, label: id })),
    rows: Array.from({ length: 39 }, (_, index) => ({
      pa: `pa${index + 1}`,
      runs: ["v2", "v3", "v4"].map((id) => id === "v4" && index >= 34 ? null : {
        cost: index + 1,
        durationMs: (index + 1) * 100,
        totalDurationMs: (index + 1) * 300,
        turns: [`${id}-${index + 1}`],
        status: "complete",
      }),
    })),
  };
}

test("every comparison view preserves each native PA, cost and duration exactly once", () => {
  const comparison = mixedComparison();
  const before = structuredClone(comparison);
  for (const view of ["capabilities", "v2", "v3", "v4"]) {
    const rows = layout.comparisonRows(comparison, view);
    for (const [index, count] of [39, 39, 34].entries()) {
      const sources = rows.flatMap((row) => row.runs[index].sources);
      assert.equal(sources.length, count, view);
      assert.equal(new Set(sources.map((source) => source.pa)).size, count, view);
      assert.equal(rows.reduce((sum, row) => sum + row.runs[index].cost, 0), count * (count + 1) / 2, view);
      const cost = layout.cumulativePoints(rows, index, "cost").at(-1);
      const time = layout.cumulativePoints(rows, index, "durationMs", "totalDurationMs").at(-1);
      assert.equal(cost.value, count * (count + 1) / 2, view);
      assert.equal(time.value, cost.value * 100, view);
      assert.equal(time.secondaryValue, cost.value * 300, view);
      assert.equal(cost.status, "complete");
    }
  }
  assert.deepEqual(comparison, before, "archived native rows must not be rewritten");
});

test("capabilities combine preprocessing, preserve legacy work, and label changed LowIR scope", () => {
  const rows = layout.comparisonRows(mixedComparison());
  assert.equal(rows.length, 35);
  const preprocessing = rows.find((row) => row.label === "Complete preprocessing");
  assert.deepEqual(preprocessing.runs[1].sources.map((source) => source.pa), ["pa4", "pa5"]);
  assert.deepEqual(preprocessing.runs[2].sources.map((source) => source.pa), ["pa4"]);
  assert.equal(preprocessing.runs[1].cost, 9);
  assert.equal(preprocessing.runs[2].cost, 4);
  const legacy = rows.find((row) => row.legacy);
  assert.deepEqual(legacy.runs[1].sources.map((source) => source.pa), ["pa6", "pa7", "pa8", "pa9"]);
  assert.equal(legacy.runs[1].cost, 30);
  assert.equal(legacy.runs[2].status, "not required");
  const lowir = rows.find((row) => row.label === "LowIR foundation");
  assert.match(lowir.note, /Approximate/);
  assert.equal(lowir.runs[1].sources[0].title, "LowIR to CY86");
  assert.equal(lowir.runs[2].sources[0].title, "LowIR model, roundtrip and construction");
  const abi = rows.find((row) => row.label === "ABI naming");
  assert.deepEqual(abi.runs.map((summary) => summary.sources[0].pa), ["pa30", "pa14", "pa9"]);
  assert.deepEqual(rows.at(-1).runs.map((summary) => summary.sources[0].pa), ["pa39", "pa39", "pa34"]);
});

test("a consolidated group is partial until every required source assignment is complete", () => {
  const comparison = mixedComparison();
  comparison.rows[4].runs[1] = null;
  comparison.rows[5].runs[1].status = "partial";
  for (let index = 4; index < comparison.rows.length; index++) comparison.rows[index].runs[2] = null;
  const rows = layout.comparisonRows(comparison);
  assert.equal(rows[3].runs[1].status, "partial");
  assert.equal(rows[3].runs[1].cost, 4);
  assert.equal(rows[4].runs[1].status, "partial");
  assert.equal(rows[4].runs[2].status, "not required");
  assert.equal(rows[5].runs[2].status, "not started");
  assert.equal(layout.cumulativePoints(rows, 2, "cost").at(-1).index, 3,
    "an N/A must not extend an unfinished run's line");
});

test("interior not-required milestones bridge spending without claiming completion", () => {
  const rows = layout.comparisonRows(mixedComparison());
  const points = layout.cumulativePoints(rows, 2, "cost");
  const legacy = points.find((point) => point.index === 4);
  assert.equal(legacy.status, "not required");
  assert.equal(legacy.value, points.find((point) => point.index === 3).value);
});

test("through is a canonical cutoff, including a cut inside a merged group", () => {
  const comparison = mixedComparison();
  comparison.through = "pa4";
  let rows = layout.comparisonRows(comparison);
  assert.equal(rows.length, 4);
  assert.equal(rows[3].runs[1].cost, 4);
  assert.equal(rows[3].runs[1].status, "partial");
  assert.equal(rows[3].runs[2].status, "not started");
  comparison.through = "pa14";
  for (const view of ["capabilities", "v2", "v3", "v4"]) {
    rows = layout.comparisonRows(comparison, view);
    assert.equal(rows.reduce((sum, row) => sum + row.runs[0].cost, 0), 121, view);
    assert.equal(rows.reduce((sum, row) => sum + row.runs[1].cost, 0), 105, view);
    assert.equal(rows.reduce((sum, row) => sum + row.runs[2].cost, 0), 45, view);
  }
});

test("old short exports and empty comparisons need no migration", () => {
  assert.deepEqual(layout.comparisonRows({}), []);
  const comparison = mixedComparison();
  comparison.rows = comparison.rows.slice(0, 3);
  delete comparison.through;
  for (const view of ["capabilities", "v2", "v3", "v4"]) {
    const rows = layout.comparisonRows(comparison, view);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.runs[0].cost), [1, 2, 3]);
  }
});
