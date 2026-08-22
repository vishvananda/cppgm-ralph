import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRunsSequentially } from "../scripts/compare-pa-costs.js";

test("comparison summarizes large runs one at a time", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const summaries = await summarizeRunsSequentially(["a", "b", "c"], async (run) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(run);
    active -= 1;
    return `${run}-summary`;
  });

  assert.equal(peak, 1);
  assert.deepEqual(completed, ["a", "b", "c"]);
  assert.deepEqual(summaries, ["a-summary", "b-summary", "c-summary"]);
});
