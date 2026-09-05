import assert from "node:assert/strict";
import test from "node:test";

import "../ralph-viz/comparison-run-visibility.js";

const { defaultVisible } = globalThis.RALPH_COMPARISON_RUN_VISIBILITY;

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
