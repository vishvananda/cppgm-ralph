import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import "../ralph-viz/assignment-layouts.js";

const layout = globalThis.RALPH_ASSIGNMENT_LAYOUT;
const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
// Exercise the actual browser helpers without a DOM dependency or a provider.
const names = ["comparisonCellHtml", "comparisonTotalForRows", "comparisonSummaryStarted",
  "comparisonChartTooltipHtml", "comparisonThroughOptions", "comparisonLayoutOptions",
  "defaultRunComparisonThrough", "highlightedComparisonRunIndex", "comparisonCumulativeSeries",
  "comparisonAxisLabel", "comparisonEChartResponsiveLayout"];
const context = vm.createContext({
  ASSIGNMENT_LAYOUT: layout,
  state: { comparisonLayout: "capabilities" },
  escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  fmtInt: String,
  formatHhhMmSs: (value) => `${value}ms`,
  formatUsd: (value) => `$${value}`,
});
for (const name of names) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const tail = app.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(end < 0 ? tail : tail.slice(0, end + 1), context);
}

function fixture() {
  return {
    runs: [{ label: "V3", layout: "v3" }, { label: "V4", layout: "v4", highlighted: true }],
    through: "pa39",
    rows: Array.from({ length: 39 }, (_, i) => ({
      pa: `pa${i + 1}`,
      runs: [0, 1].map((run) => run === 1 && i >= 5 ? null : {
        status: "complete", turns: [i], cost: i + 1, durationMs: i + 1, totalDurationMs: (i + 1) * 2,
      }),
    })),
  };
}

test("local through selector follows displayed milestones, not the original PA row index", () => {
  const comparison = fixture();
  assert.equal(context.defaultRunComparisonThrough(comparison), 7,
    "V4 PA5 is AST, the sixth grouped milestone; show one milestone ahead");
  const nativeV4 = layout.comparisonRows(comparison, "v4");
  assert.equal(context.defaultRunComparisonThrough(comparison, nativeV4), 7);
  const nativeV3 = layout.comparisonRows(comparison, "v3");
  assert.equal(context.defaultRunComparisonThrough(comparison, nativeV3), 11);
  assert.match(context.comparisonThroughOptions(nativeV4, 6), /value="6" selected>PA5 · AST/);
});

test("table totals preserve all spend in V4 view and mark unreached assignments partial", () => {
  const comparison = fixture();
  const rows = layout.comparisonRows(comparison, "v4");
  const oldTotal = context.comparisonTotalForRows(rows, 0);
  const newTotal = context.comparisonTotalForRows(rows, 1);
  assert.equal(oldTotal.cost, 780);
  assert.equal(oldTotal.durationMs, 780);
  assert.equal(oldTotal.totalDurationMs, 1560);
  assert.equal(oldTotal.status, "complete");
  assert.equal(newTotal.cost, 15);
  assert.equal(newTotal.status, "partial");
  const series = context.comparisonCumulativeSeries(rows, [1, 0], [comparison.runs[1], comparison.runs[0]], "cost");
  assert.equal(series[0].points.at(-1).value, 15);
  assert.equal(series[1].points.at(-1).value, 780);
});

test("unrequired/unreached cells are not displayed as zero-cost completed stages", () => {
  const rows = layout.comparisonRows(fixture());
  assert.match(context.comparisonCellHtml(rows[4].runs[1]), /Not separately required/);
  assert.doesNotMatch(context.comparisonCellHtml(rows[4].runs[1]), /\$0|complete/);
  assert.match(context.comparisonCellHtml(rows[6].runs[1]), /Not reached · V4 PA6/);
  const preprocessing = context.comparisonCellHtml(rows[3].runs[0]);
  assert.match(preprocessing, /<details/);
  assert.match(preprocessing, /V3 PA4 \+ V3 PA5/);
  assert.match(preprocessing, /\$9/);
});

test("chart hover explains native contributions, approximate scope, and active versus total time", () => {
  const comparison = fixture();
  const rows = layout.comparisonRows(comparison);
  const params = [
    { seriesName: "V3", seriesId: "comparison-cost-0-active", value: 15, dataIndex: 3, axisValueLabel: "Complete preprocessing" },
  ];
  let html = context.comparisonChartTooltipHtml(params, new Map(), (v) => `$${v}`, null, rows, [0, 1], comparison.runs, "cost");
  assert.match(html, /PA4 \$4 \(complete\) \+ PA5 \$5 \(complete\)/);
  params.push({ ...params[0], seriesId: "comparison-runtime-0-total", value: 30 });
  html = context.comparisonChartTooltipHtml(params, new Map(), (v) => `${v}ms`, "total agent time", rows, [0, 1], comparison.runs, "durationMs");
  assert.match(html, /active 15ms/);
  assert.match(html, /total agent time 30ms/);
  params[0].dataIndex = 8;
  html = context.comparisonChartTooltipHtml([params[0]], new Map(), String, null, rows, [0, 1], comparison.runs);
  assert.match(html, /Approximate match/);
  params[0].seriesName = "<script>";
  html = context.comparisonChartTooltipHtml([params[0]], new Map(), String);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("mobile milestone labels are bounded without shortening tooltip titles", () => {
  const mobile = context.comparisonEChartResponsiveLayout(390);
  const label = context.comparisonAxisLabel("Complete preprocessing", mobile.labelLimit);
  assert.equal(label, "Complete prep…");
  assert.equal(context.comparisonAxisLabel("AST", mobile.labelLimit), "AST");
  assert.ok(mobile.grid.containLabel);
  assert.ok(mobile.grid.bottom <= 20);
});
