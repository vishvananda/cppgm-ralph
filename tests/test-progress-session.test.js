import assert from "node:assert/strict";
import test from "node:test";

import {
  progressObservationFromSessionOutput,
  requestHandler,
} from "../ralph-viz/server.js";

test("viewer serves shared browser helpers as JavaScript", async () => {
  for (const [url, marker] of [
    ["/test-progress-evidence.js", /RALPH_TEST_PROGRESS_EVIDENCE/],
    ["/command-status.js", /RALPH_COMMAND_STATUS/],
  ]) {
    const response = {
      status: null,
      headers: null,
      body: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };

    await requestHandler({ url, headers: { host: "localhost" } }, response);

    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "application/javascript; charset=utf-8");
    assert.match(response.body, marker);
  }
});

test("session progress preserves the unknown tail of a fail-fast make test", () => {
  const observation = progressObservationFromSessionOutput(
    "make: Entering directory '/repo/pa35'\n" +
      "pa35 tests: running 45 tests\n" +
      "pa35 tests: FAIL after 10/45 passed\n" +
      "tests/200-case.t: ERROR: checked output does not match reference\n",
    "2026-08-14T12:00:00.000Z",
    "make -C pa35 test",
  );

  assert.deepEqual(observation, {
    recordedAt: "2026-08-14T12:00:00.000Z",
    stage: "pa35",
    passed: 10,
    passedUpperBound: 44,
    total: 45,
    status: "fail",
    hasSubset: false,
  });
});

test("session progress combines completed targets with a fail-fast target", () => {
  const observation = progressObservationFromSessionOutput(
    "===== pa35 =====\n" +
      "pa35 tests/spec: running 30 tests\n" +
      "pa35 tests/spec: PASS (30/30)\n" +
      "pa35 course/pa35: running 45 tests\n" +
      "pa35 course/pa35: FAIL after 10/45 passed\n",
    "2026-08-14T12:00:00.000Z",
    "make test-pa35",
  );

  assert.equal(observation.passed, 40);
  assert.equal(observation.passedUpperBound, 74);
  assert.equal(observation.total, 75);
  assert.equal(observation.status, "fail");
});

test("exhaustive failure progress remains an exact count", () => {
  const observation = progressObservationFromSessionOutput(
    "===== pa35 =====\n" +
      "pa35 tests: FAIL (38/45)\n",
    "2026-08-14T12:00:00.000Z",
    "make test-report ACTIVE_TEST_REPORT_PAS='pa35'",
  );

  assert.equal(observation.passed, 38);
  assert.equal(observation.passedUpperBound, 38);
  assert.equal(observation.total, 45);
});
