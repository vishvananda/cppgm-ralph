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
