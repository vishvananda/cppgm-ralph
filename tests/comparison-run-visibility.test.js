import assert from "node:assert/strict";
import test from "node:test";

import "../ralph-viz/comparison-run-visibility.js";

const { defaultVisible } = globalThis.RALPH_COMPARISON_RUN_VISIBILITY;

test("published Luna and v3opus comparison runs start hidden", () => {
  assert.equal(defaultVisible({ spec: "luna-gpt-5.6-luna-ultra" }), false);
  assert.equal(defaultVisible({ label: "7-v3opus-claude-opus-5-xhigh" }), false);
  assert.equal(defaultVisible({ spec: "v3codex-gpt-5.6-sol-xhigh" }), true);
  assert.equal(defaultVisible({ spec: "v3multi-gpt-5.6-sol-xhigh" }), true);
});

test("the highlighted local replacement is visible regardless of its run family", () => {
  assert.equal(defaultVisible({
    label: "luna-gpt-5.6-luna-ultra (local)",
    spec: "luna-gpt-5.6-luna-ultra",
    highlighted: true,
  }), true);
  assert.equal(defaultVisible({
    label: "v3opus-claude-opus-5-xhigh (local)",
    spec: "v3opus-claude-opus-5-xhigh",
    highlighted: true,
  }), true);
});
