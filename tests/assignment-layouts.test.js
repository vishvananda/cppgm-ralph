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
});
