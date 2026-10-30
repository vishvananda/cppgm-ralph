import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const browser = vm.createContext({});
for (const [file, binding] of [
  ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
  ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
]) {
  vm.runInContext(readFileSync(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), browser);
  vm.runInContext(`const ${binding};`, browser);
}
const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) {
  vm.runInContext(match[0], browser);
}

function fixture() {
  return {
    stageTotals: new Map([["pa12", 316]]),
    turnTargets: new Map(), stageCurrent: new Map(),
    stageBaseline: new Map(), stageBest: new Map(), latest: null,
  };
}

function observe(tracker, overrides = {}) {
  return browser.applyAgentTestProgressObservation(tracker, {
    stage: "pa12", stageNumber: 12, turn: 51,
    recordedAt: "2026-10-12T21:54:09.385Z",
    total: 316, passed: 287, passedUpperBound: 287,
    hasSubset: false, status: "fail", ...overrides,
  });
}

test("two focused passes preserve 287/316 and use a separate yellow subset marker", () => {
  const tracker = fixture();
  observe(tracker, { isTurnStartBaseline: true });
  const progress = observe(tracker, {
    total: 2, passed: 2, passedUpperBound: 2, hasSubset: true, status: "pass",
  });
  assert.equal(progress.current.passed, 287);
  assert.equal(progress.current.passedUpperBound, 287);
  assert.equal(progress.current.total, 316);
  assert.equal(progress.latestFocused.total, 2);
  assert.equal(progress.best.passed, 287);
  const model = browser.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(progress);
  assert.equal(model.rows.length, 1);
  const html = browser.dockProgressBarHtml(null, progress, model);
  assert.match(html, /last full 287/);
  assert.match(html, /focused 2\/2 pass/);
  assert.match(html, /dock-progress-focused-track/);
  assert.doesNotMatch(html, /unrun|dock-progress-pass|dock-progress-lost/);
});

test("failed focused check stays visible without replacing full-suite evidence", () => {
  const tracker = fixture();
  observe(tracker);
  const progress = observe(tracker, {
    total: 2, passed: 1, passedUpperBound: 1, hasSubset: true, status: "fail",
  });
  assert.equal(progress.current.passed, 287);
  const model = browser.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(progress);
  assert.match(browser.dockFocusedProgressHtml(model, progress), /dock-progress-focused-fail/);
  assert.match(browser.dockFocusedProgressHtml(model, progress), /focused 1\/2 fail/);
  // The next full run, including fail-fast evidence, still replaces the snapshot.
  const full = observe(tracker, { passed: 2, passedUpperBound: 315 });
  assert.equal(full.current.passed, 2);
  assert.equal(full.latestFocused, null);
  assert.equal(browser.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(full).rows.length, 2);
});

test("focused-only evidence cannot become a full-suite result or best score", () => {
  const tracker = fixture();
  for (let index = 0; index < 2; index += 1) {
    const progress = observe(tracker, {
      total: 2, passed: 2, passedUpperBound: 2, hasSubset: true, status: "pass",
    });
    assert.equal(progress.fullStageUnmeasured, true);
    assert.equal(progress.current.passed, 0);
    assert.equal(progress.current.passedUpperBound, 316);
    assert.equal(progress.best.passed, 0);
    assert.equal(tracker.stageCurrent.size, 0);
    assert.equal(tracker.stageBest.size, 0);
    assert.equal(browser.stageProgressLabel(progress), "full suite unmeasured");
  }
});
