import assert from "node:assert/strict";
import test from "node:test";

import {
  codexSubagentProgressThreadIds,
  progressObservationFromSessionOutput,
  requestHandler,
  scanCodexSessionProgressObservations,
} from "../ralph-viz/server.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

test("direct stage test preserves a failing sub-suite as partial stage evidence", () => {
  const observation = progressObservationFromSessionOutput(
    "tests/object-roundtrip/200-pa35-hosted-ostringstream-unsigned-int.t: " +
      "command failed with exit status 1:\n" +
      "  ../dev/cppgm++ -c -o /tmp/case.o tests/object-roundtrip/case.t\n" +
      "pa37 object-roundtrip: FAIL (3/7)\n",
    "2026-08-15T12:00:00.000Z",
    "make -C pa37 test",
  );

  assert.deepEqual(observation, {
    recordedAt: "2026-08-15T12:00:00.000Z",
    stage: "pa37",
    passed: 3,
    passedUpperBound: 6,
    total: 7,
    status: "fail",
    hasSubset: false,
    partialStage: true,
  });
});

test("focused local check reports child subset progress", () => {
  const observation = progressObservationFromSessionOutput(
    "make: Entering directory '/repo/pa1'\n" +
      "pa1 check: running 8 tests\n" +
      "pa1 check: PASS (8/8)\n" +
      "make: Leaving directory '/repo/pa1'\n",
    "2026-08-22T16:17:07.060Z",
    "make -C pa1 check TEST='tests/a.t tests/b.t'",
  );

  assert.deepEqual(observation, {
    recordedAt: "2026-08-22T16:17:07.060Z",
    stage: "pa1",
    passed: 8,
    passedUpperBound: 8,
    total: 8,
    status: "pass",
    hasSubset: true,
    partialStage: true,
  });
});

test("top-level test-pa wrapper treats completed sub-suites as exhaustive evidence", () => {
  const observation = progressObservationFromSessionOutput(
    "pa37 object-roundtrip: running 7 tests\n" +
      "tests/object-roundtrip/case.t: command failed with exit status 1:\n" +
      "pa37 object-roundtrip: FAIL (3/7)\n" +
      "make: *** [Makefile:481: test-pa37] Error 2\n",
    "2026-08-15T12:00:00.000Z",
    "make test-pa37",
  );

  assert.equal(observation.stage, "pa37");
  assert.equal(observation.passed, 3);
  assert.equal(observation.passedUpperBound, 3);
  assert.equal(observation.total, 7);
  assert.equal(observation.partialStage, true);
});

test("top-level test-pa wrapper prefers its exhaustive aggregate total", () => {
  const observation = progressObservationFromSessionOutput(
    "===== pa37 =====\n" +
      "pa37 object-roundtrip: FAIL (3/7)\n" +
      "===== TEST SUMMARY: 70 / 78 TESTS PASSED =====\n" +
      "make: *** [Makefile:481: test-pa37] Error 2\n",
    "2026-08-15T12:00:00.000Z",
    "make test-pa37",
  );

  assert.deepEqual(observation, {
    recordedAt: "2026-08-15T12:00:00.000Z",
    stage: "pa37",
    passed: 70,
    passedUpperBound: 70,
    total: 78,
    status: "fail",
    hasSubset: false,
  });
});

test("keep-going direct stage test retains exhaustive sub-suite counts", () => {
  const observation = progressObservationFromSessionOutput(
    "pa37 object-roundtrip: FAIL (3/7)\n",
    "2026-08-15T12:00:00.000Z",
    "KEEP_GOING=1 make -C pa37 test",
  );

  assert.equal(observation.passed, 3);
  assert.equal(observation.passedUpperBound, 3);
  assert.equal(observation.partialStage, true);
});

test("single-stage report total outranks an intermediate sub-suite total", () => {
  const observation = progressObservationFromSessionOutput(
    "===== pa37 =====\n" +
      "pa37 object-roundtrip: FAIL (3/7)\n" +
      "===== TEST SUMMARY: 70 / 78 TESTS PASSED =====\n",
    "2026-08-15T12:00:00.000Z",
    "make test-report ACTIVE_TEST_REPORT_PAS='pa37'",
  );

  assert.deepEqual(observation, {
    recordedAt: "2026-08-15T12:00:00.000Z",
    stage: "pa37",
    passed: 70,
    passedUpperBound: 70,
    total: 78,
    status: "fail",
    hasSubset: false,
  });
});

test("reading a stale test log does not create new progress", () => {
  const observation = progressObservationFromSessionOutput(
    "===== pa1 =====\n" +
      "===== TEST SUMMARY: 0 / 53 TESTS PASSED =====\n",
    "2026-08-15T12:00:00.000Z",
    "tail -20 .ralph/run/last-test.log",
  );

  assert.equal(observation, null);
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

test("includes Codex child threads in compact progress scanning", () => {
  assert.deepEqual(codexSubagentProgressThreadIds([
    {
      event: {
        item: {
          type: "subagent",
          provider: "codex",
          agent_thread_id: "child-thread",
        },
      },
    },
  ], ["root-thread"]), ["root-thread", "child-thread"]);
});

test("extracts a dedicated single-PA summary from a Codex child transcript", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-child-progress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "child.jsonl");
  const records = [
    {
      timestamp: "2026-08-22T17:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "test-call",
        arguments: JSON.stringify({ cmd: "make test-pa37" }),
      },
    },
    {
      timestamp: "2026-08-22T17:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "test-call",
        output: "===== pa37 =====\npa37 object-roundtrip: FAIL (3/7)\n" +
          "===== TEST SUMMARY: 70 / 78 TESTS PASSED =====\n",
      },
    },
  ];
  await fs.writeFile(transcript, `${records.map(JSON.stringify).join("\n")}\n`);

  const observations = await scanCodexSessionProgressObservations(transcript);
  assert.deepEqual(observations, [{
    recordedAt: "2026-08-22T17:00:02.000Z",
    stage: "pa37",
    passed: 70,
    passedUpperBound: 70,
    total: 78,
    status: "fail",
    hasSubset: false,
  }]);
});

test("extracts child progress from batched code-mode make commands", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-child-progress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "child-batch.jsonl");
  const input = [
    'const first = await tools.exec_command({cmd:"make test-pa1",workdir:"/repo"});',
    'text(`first\\n${first.output}`);',
    'const second = await tools.exec_command({cmd:"make test-report-through-pa1",workdir:"/repo"});',
    'text(`second\\n${second.output}`);',
  ].join("\n");
  const records = [
    {
      timestamp: "2026-08-22T18:00:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "batch-test-call",
        input,
      },
    },
    {
      timestamp: "2026-08-22T18:00:02.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "batch-test-call",
        output: [{
          type: "input_text",
          text: "Script completed\nOutput:\n",
        }, {
          type: "input_text",
          text: "first\n===== pa1 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (53 / 53) =====\n",
        }, {
          type: "input_text",
          text: "second\n===== pa1 =====\n===== ALL TESTS PASSED SUCCESSFULLY! (53 / 53) =====\n",
        }],
      },
    },
  ];
  await fs.writeFile(transcript, `${records.map(JSON.stringify).join("\n")}\n`);

  const observations = await scanCodexSessionProgressObservations(transcript);
  assert.equal(observations.length, 1);
  assert.ok(observations.every((entry) =>
    entry.stage === "pa1" && entry.passed === 53 && entry.total === 53 && entry.status === "pass"));
});
