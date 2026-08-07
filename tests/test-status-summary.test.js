import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/test-status-summary.js";

const {
  buildTurnProgressModel,
  hasAuthoritativePassingTotal,
  inferStageTotal,
  passingPrefixTotal,
  summarizePriorStageFailures,
} = globalThis.RALPH_TEST_STATUS_SUMMARY;

test("turn progress splits start, additions, and remaining tests", () => {
  const model = buildTurnProgressModel({
    start: { passed: 222, total: 249 },
    current: { passed: 235, total: 249 },
  });

  assert.deepEqual(model, {
    total: 249,
    current: 235,
    start: 222,
    hasStart: true,
    delta: 13,
    remaining: 14,
    segments: [
      { key: "start", label: "start", value: 222, text: "222" },
      { key: "gained", label: "this turn", value: 13, text: "+13" },
      { key: "remaining", label: "left", value: 14, text: "14" },
    ],
  });
});

test("turn progress represents regressions without changing the total width", () => {
  const model = buildTurnProgressModel({
    start: { passed: 222, total: 249 },
    current: { passed: 210, total: 249 },
  });

  assert.equal(model.delta, -12);
  assert.equal(model.remaining, 39);
  assert.deepEqual(model.segments, [
    { key: "current", label: "current", value: 210, text: "210" },
    { key: "lost", label: "lost this turn", value: 12, text: "-12" },
    { key: "remaining", label: "left beyond start", value: 27, text: "27" },
  ]);
  assert.equal(model.segments.reduce((sum, segment) => sum + segment.value, 0), 249);
});

test("complete passing stage totals outrank unexplained through-run residuals", () => {
  assert.equal(hasAuthoritativePassingTotal({
    name: "pa16",
    status: "pass",
    passed: 291,
    total: 291,
  }), true);
  assert.equal(hasAuthoritativePassingTotal({
    name: "pa16",
    status: "fail",
    passed: 243,
    total: 291,
  }), false);
});

test("stage totals use adjacent through-run aggregates rather than stage-row sums", () => {
  const prior = {
    allTestsPassed: true,
    testsPassed: 1145,
    testsTotal: 1145,
    stages: Array.from({ length: 15 }, (_, index) => ({
      name: `pa${index + 1}`,
      status: "pass",
      passed: index === 14 ? 108 : 1,
      total: index === 14 ? 108 : 1,
    })),
  };
  const prefix = passingPrefixTotal(prior);
  assert.deepEqual(prefix, { stage: "pa15", total: 1145 });

  const current = {
    allTestsPassed: false,
    targetStage: "pa16",
    testsPassed: 1421,
    testsTotal: 1436,
    stages: [
      ...prior.stages,
      { name: "pa16", status: "fail", passed: 276, total: 291 },
    ],
  };
  assert.deepEqual(inferStageTotal(current, new Map([[prefix.stage, prefix.total]])), {
    stage: "pa16",
    total: 291,
  });
});

test("a complete current-stage row is not enlarged by an aggregate discrepancy", () => {
  const status = {
    allTestsPassed: true,
    targetStage: "pa16",
    testsPassed: 1436,
    testsTotal: 1436,
    stages: [
      ...Array.from({ length: 15 }, (_, index) => ({
        name: `pa${index + 1}`,
        status: "pass",
        passed: index === 14 ? 108 : 1,
        total: index === 14 ? 108 : 1,
      })),
      { name: "pa16", status: "pass", passed: 291, total: 291 },
    ],
  };
  assert.equal(inferStageTotal(status, new Map([["pa15", 1145]])), null);
});

test("prior failure summary excludes the active PA", () => {
  const summary = summarizePriorStageFailures([{
    stages: [
      { name: "pa14", status: "fail", passed: 90, total: 100, failed: 10 },
      { name: "pa15", status: "fail", passed: 245, total: 311, failed: 66 },
    ],
  }], "pa15");

  assert.deepEqual(summary, {
    total: 10,
    stages: [{ name: "pa14", failed: 10 }],
  });
});

test("newer stage evidence clears failures without erasing other stages", () => {
  const summary = summarizePriorStageFailures([
    {
      recordedAt: "2026-08-06T10:00:00Z",
      status: {
        stages: [
          { name: "pa12", status: "fail", failed: 20 },
          { name: "pa13", status: "fail", failed: 7 },
        ],
      },
    },
    {
      recordedAt: "2026-08-06T10:05:00Z",
      status: { stages: [{ name: "pa12", status: "pass", failed: 0 }] },
    },
  ], "pa14");

  assert.deepEqual(summary, {
    total: 7,
    stages: [{ name: "pa13", failed: 7 }],
  });
});

test("unknown stages do not clear explicit failures", () => {
  const summary = summarizePriorStageFailures([
    {
      recordedAt: "2026-08-06T10:00:00Z",
      status: { stages: [{ name: "pa10", status: "fail", failed: 3 }] },
    },
    {
      recordedAt: "2026-08-06T10:05:00Z",
      status: { stages: [{ name: "pa10", status: "unknown", failed: 0 }] },
    },
  ], "pa11");

  assert.equal(summary.total, 3);
});
