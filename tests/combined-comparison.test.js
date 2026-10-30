import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
const source = app.match(/^function scheduleCombinedComparisonPanel\([\s\S]*?^\}/m)[0];

function fixture() {
  const pending = [];
  const rendered = [];
  const context = vm.createContext({
    state: { combinedComparison: null },
    RUN_COMPARISON_REFRESH_MS: 60000,
    runComparisonCard: { dataset: {}, hidden: true },
    runComparisonEl: { innerHTML: "" },
    runComparisonMeta: { textContent: "" },
    runComparisonThrough: { disabled: false },
    disposeComparisonCharts() {},
    isCombinedView: () => true,
    loadComparison: () => new Promise(resolve => pending.push(resolve)),
    renderCombinedComparisonPanel: async entry => rendered.push(entry.data),
  });
  vm.runInContext(source, context);
  return { context, pending, rendered };
}

test("combined card refreshes share a pending comparison and reuse fresh results", async () => {
  const { context, pending, rendered } = fixture();
  const runs = [{ id: "v5sol/run" }, { id: "v5rust/run" }];
  context.scheduleCombinedComparisonPanel(runs);
  context.scheduleCombinedComparisonPanel([...runs].reverse());
  assert.equal(pending.length, 1);
  const data = { runs: ["v5rust", "v5sol"] };
  pending[0](data);
  await context.state.combinedComparison.promise;
  context.scheduleCombinedComparisonPanel(runs);
  assert.equal(pending.length, 1, "normal card refresh must not recompute comparison usage");
  assert.equal(context.state.combinedComparison.data, data);
  assert.equal(rendered.at(-1), data);
});

test("a comparison for an older active-run set cannot replace the current graphs", async () => {
  const { context, pending, rendered } = fixture();
  context.scheduleCombinedComparisonPanel([{ id: "v5sol/run" }]);
  const old = context.state.combinedComparison;
  context.scheduleCombinedComparisonPanel([{ id: "v5sol/run" }, { id: "v5scratch/run" }]);
  const current = context.state.combinedComparison;
  assert.equal(pending.length, 2);
  pending[0]({ runs: ["old"] });
  await old.promise;
  assert.equal(context.state.combinedComparison, current);
  assert.equal(current.data, null);
  assert.equal(rendered.length, 0);
  const data = { runs: ["v5sol", "v5scratch"] };
  pending[1](data);
  await current.promise;
  assert.equal(context.state.combinedComparison.data, data);
  assert.deepEqual(rendered, [data]);
});

test("expired combined comparison refreshes and replaces the graph data", async () => {
  const { context, pending, rendered } = fixture();
  const runs = [{ id: 'v5sol/run' }];
  context.scheduleCombinedComparisonPanel(runs);
  const first = context.state.combinedComparison;
  pending[0]({ runs: ['first observation'] });
  await first.promise;
  first.loadedAt = Date.now() - 61000;
  context.scheduleCombinedComparisonPanel(runs);
  const second = context.state.combinedComparison;
  context.scheduleCombinedComparisonPanel(runs);
  assert.equal(pending.length, 2, 'one new request after expiry, even during repeated card refreshes');
  const fresh = { runs: ['new observation'] };
  pending[1](fresh);
  await second.promise;
  assert.equal(context.state.combinedComparison.data, fresh);
  assert.equal(rendered.at(-1), fresh);
});
