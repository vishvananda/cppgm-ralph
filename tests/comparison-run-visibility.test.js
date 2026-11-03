import assert from "node:assert/strict";
import test from "node:test";

import "../ralph-viz/assignment-layouts.js";
import "../ralph-viz/comparison-run-visibility.js";

const { defaultVisible, annotate } = globalThis.RALPH_COMPARISON_RUN_VISIBILITY;

test("finished comparison runs start visible regardless of run family", () => {
  assert.equal(defaultVisible({
    spec: "luna-gpt-5.6-luna-ultra",
    comparisonComplete: true,
  }), true);
  assert.equal(defaultVisible({
    label: "7-v3opus-claude-opus-5-xhigh",
    comparisonComplete: true,
  }), true);
});

test("unfinished and legacy comparison runs start hidden", () => {
  assert.equal(defaultVisible({
    spec: "v3codex-gpt-5.6-sol-xhigh",
    comparisonComplete: false,
  }), false);
  assert.equal(defaultVisible({ spec: "trusted-gpt-5.5-xhigh" }), false);
});

test("reaching self-hosting defaults a run on before PA34 or PA35 is complete", () => {
  const runs = ['v2', 'v3', 'v4', 'v5', 'v5'].map(layout => ({ layout, comparisonComplete: false }));
  const started = { status: 'partial', turns: [42], cost: 1 };
  const comparison = { runs, rows: [
    { pa: 'pa39', runs: [started, started, null, null, null] },
    { pa: 'pa34', runs: [null, null, started, started, { status: 'not started', cost: 0 }] },
    { pa: 'pa35', runs: [null, null, null, started, null] },
  ] };
  assert.deepEqual(annotate(comparison).runs.map(defaultVisible), [true, true, true, true, false]);
  assert.equal(runs[0].comparisonReachedPa34, undefined, 'annotation preserves its input');
});

test("the highlighted local replacement is visible regardless of its run family", () => {
  assert.equal(defaultVisible({
    label: "luna-gpt-5.6-luna-ultra (local)",
    spec: "luna-gpt-5.6-luna-ultra",
    comparisonComplete: false,
    highlighted: true,
  }), true);
  assert.equal(defaultVisible({
    label: "v3opus-claude-opus-5-xhigh (local)",
    spec: "v3opus-claude-opus-5-xhigh",
    comparisonComplete: false,
    highlighted: true,
  }), true);
});
