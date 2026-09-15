import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
const run = { id: "v4codex-gpt-6-astra-xhigh/run" };
const oldStart = "2026-09-07T18:45:00.000Z";
const newStart = "2026-09-09T12:12:00.907Z";

function browserFixture(storage = new Map()) {
  const browser = vm.createContext({
    state: { progressBestCache: new Map() },
    PROGRESS_BEST_STORAGE_KEY: "ralphProgressBest:v2",
    PROGRESS_BEST_CACHE_LIMIT: 600,
    cleanText: (value) => String(value ?? "").trim(),
    window: { localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    } },
  });
  for (const name of ["applyProgressBestCache", "mergeProgressBestCache", "progressBestRunKey",
    "progressBestCacheKey", "progressBestCandidate", "isBetterProgressBest",
    "loadProgressBestCache", "saveProgressBestCache", "pruneProgressBestCache",
    "finitePositiveNumber"]) {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const tail = app.slice(start);
    const end = tail.slice(1).search(/\n(?:async )?function /);
    vm.runInContext(end < 0 ? tail : tail.slice(0, end + 1), browser);
  }
  browser.state.progressBestCache = browser.loadProgressBestCache();
  return browser;
}

function progress(startedAt, passed, total = 121) {
  return {
    turn: 19, stage: "pa10", recordedAt: startedAt,
    start: startedAt ? { passed: 0, total, recordedAt: startedAt } : null,
    current: { passed, total },
    best: { passed, total, recordedAt: startedAt },
  };
}

function apply(browser, observation) {
  return browser.applyProgressBestCache({
    latest: observation, byTurn: new Map([[observation.turn, observation]]),
  }, run);
}

test("rollback with reused run, turn, stage and total does not inherit discarded progress", () => {
  const storage = new Map();
  const before = browserFixture(storage);
  apply(before, progress(oldStart, 121));

  const after = browserFixture(storage);
  const result = apply(after, progress(newStart, 0));
  assert.equal(result.latest.current.passed, 0);
  assert.equal(result.latest.best.passed, 0);
  assert.equal(result.byTurn.get(19).best.passed, 0);
  assert.equal(after.state.progressBestCache.size, 2);
});

test("reload retains the best result from the same turn despite a later regression", () => {
  const storage = new Map();
  apply(browserFixture(storage), progress(newStart, 45));
  const result = apply(browserFixture(storage), progress(newStart, 10));
  assert.equal(result.latest.current.passed, 10);
  assert.equal(result.latest.best.passed, 45);
  assert.equal(result.byTurn.get(19).best.passed, 45);
});

test("legacy browser cache entries without a turn identity are not reused", () => {
  const storage = new Map([["ralphProgressBest:v2", JSON.stringify({
    version: 1,
    entries: [[`${run.id}\0${19}\0pa10\0${121}`, {
      passed: 121, total: 121, recordedAt: oldStart,
    }]],
  })]]);
  assert.equal(apply(browserFixture(storage), progress(newStart, 0)).latest.best.passed, 0);
});

test("unidentified turn baselines are not persisted, and changed totals remain separate", () => {
  const browser = browserFixture();
  apply(browser, progress(null, 121));
  assert.equal(browser.state.progressBestCache.size, 0);
  apply(browser, progress(newStart, 45));
  const result = apply(browser, progress(newStart, 10, 122));
  assert.equal(result.latest.best.passed, 10);
  assert.equal(result.latest.best.total, 122);
});
