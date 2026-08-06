import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/test-status-summary.js";

const { summarizePriorStageFailures } = globalThis.RALPH_TEST_STATUS_SUMMARY;

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
