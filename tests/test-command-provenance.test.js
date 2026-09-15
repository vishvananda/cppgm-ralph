import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/test-command-provenance.js";
import { progressEventsFromRunEvents, progressObservationFromSessionOutput } from "../ralph-viz/server.js";

const { createTracker, outputEvidence, directCommand } = globalThis.RALPH_TEST_COMMAND_PROVENANCE;
const summary = (p = 219, t = 314) => `===== TEST SUMMARY: ${p} / ${t} TESTS PASSED =====\n`;

test("redirected wrapper tests are attributed to subsequent same-turn log reads", () => {
  const tracker = createTracker();
  assert.deepEqual(tracker.sources("make -j6 build > /tmp/build.log 2>&1 && make test-pa14 > /tmp/stage.log 2>&1", "turn27"), []);
  const sources = tracker.sources("tail -3 /tmp/stage.log; tail -2 /tmp/build.log; git diff --check", "turn27");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].info.stage, "pa14");
  assert.equal(outputEvidence(sources, summary())[0].output, summary());
  assert.equal(tracker.sources("tail -3 /tmp/stage.log", "turn28")[0].info, null);
});

test("artifact-directory variables, relative logs, quoted paths and no-space redirects", () => {
  const tracker = createTracker();
  tracker.sources('make test-report-pa13 >"$RALPH_ARTIFACT_DIR/audit/stage.log" 2>&1');
  const source = tracker.sources('cat "${RALPH_ARTIFACT_DIR}/audit/stage.log"')[0];
  assert.equal(source.info.stage, "pa13");
  tracker.sources("make -C pa14 test>./stage.log 2>&1");
  assert.equal(tracker.sources("tail -3 stage.log")[0].info.kind, "stage");
});

test("mixed stage and prior-suite summaries stay paired to the correct commands", () => {
  const tracker = createTracker();
  tracker.sources("make test-pa14 > /tmp/stage.log; make test-report-through-pa13 > /tmp/prior.log");
  const evidence = outputEvidence(tracker.sources("tail -3 /tmp/stage.log; tail -3 /tmp/prior.log"),
    summary(214) + "make: *** Error 2\n===== ALL TESTS PASSED SUCCESSFULLY! (1621 / 1621) =====\n");
  assert.deepEqual(evidence.map(e => e.info.stage), ["pa14", "pa13"]);
  assert.match(evidence[0].output, /214 \/ 314/);
  assert.doesNotMatch(evidence[0].output, /1621/);
  assert.match(evidence[1].output, /1621/);
  assert.deepEqual(outputEvidence(tracker.sources("tail /tmp/stage.log; tail /tmp/prior.log"), summary()), []);
});

test("a silent through-run does not steal the preceding stage log summary", () => {
  const tracker = createTracker();
  tracker.sources("make test-pa14 >/tmp/stage.log 2>&1");
  const sources = tracker.sources("tail -3 /tmp/stage.log; python3 check.py; make test-report-through-pa13 > /tmp/prior.log 2>&1");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].info.stage, "pa14");
});

test("diagnostic searches do not duplicate the summary read of the same log", () => {
  const tracker = createTracker();
  tracker.sources("make test-pa14 >/tmp/stage.log");
  const sources = tracker.sources("tail -3 /tmp/stage.log; rg '100-.*template-operator' /tmp/stage.log");
  assert.equal(sources.length, 1);
  assert.equal(outputEvidence(sources, summary(210)).length, 1);
});

test("shell-script bodies and quoted test text do not establish log provenance", () => {
  const tracker = createTracker();
  tracker.sources("python3 - <<'PY'\ncmd = 'make test-pa14 > /tmp/old.log'\nPY\necho 'make test-pa14 > /tmp/old.log'");
  assert.equal(tracker.sources("cat /tmp/old.log")[0].info, null);
  tracker.sources("python3 - <<'PY'\nprint('unrelated | data')\nPY\nmake test-pa14 >/tmp/live.log");
  assert.equal(tracker.sources("tail /tmp/live.log")[0].info.stage, "pa14");
  assert.equal(directCommand("rg 'make test-pa14' Makefile"), null);
});

test("overwriting, appending ambiguous output or copying an old log invalidates provenance", () => {
  for (const overwrite of ["echo stale >/tmp/stage.log", "make test-pa13 >>/tmp/stage.log", "cp old.log /tmp/stage.log", "rm /tmp/stage.log"]) {
    const tracker = createTracker();
    tracker.sources("make test-pa14 >/tmp/stage.log");
    tracker.sources(overwrite);
    assert.ok(!tracker.sources("tail /tmp/stage.log").some(s => s.info));
  }
});

test("supported direct invocations retain subset and fail-fast semantics", () => {
  for (const command of ["set +e; make test-pa14; echo status=$?", "make test-report-pa14 2>&1 | rg 'TEST SUMMARY'", "env X=1 make -C pa14 test"])
    assert.equal(directCommand(command).stage, "pa14");
  assert.equal(directCommand("make -C pa14 check TEST='tests/a.t'").hasSubset, true);
  assert.equal(directCommand("make -C pa14 test").failFast, true);
  assert.equal(directCommand("KEEP_GOING=1 make -C pa14 test").failFast, false);
  assert.equal(directCommand("make test-pa14 | sh unknown.sh"), null);
  assert.equal(directCommand("make test-pa14 >/tmp/stage.log"), null);
});

test("tee reports live progress and also establishes a known log", () => {
  const tracker = createTracker();
  assert.equal(tracker.sources("make test-report-pa14 2>&1 | tee /tmp/stage.log")[0].info.stage, "pa14");
  assert.equal(tracker.sources("tail -3 /tmp/stage.log")[0].info.stage, "pa14");
});

test("serialized tracker state preserves log ownership across incremental scans", () => {
  const before = createTracker();
  before.sources("make test-pa14 >/tmp/stage.log", "thread1/27");
  const after = createTracker(JSON.parse(JSON.stringify(before.entries())));
  assert.equal(after.sources("tail /tmp/stage.log", "thread1/27")[0].info.stage, "pa14");
  assert.equal(after.sources("tail /tmp/stage.log", "thread2/27")[0].info, null);
});

test("run-log replay recovers PA14 progress, but not stale Ralph baseline logs", () => {
  const record = (command, output, turnNumber = 27) => ({
    turnNumber, threadId: "fresh-thread", recordedAt: "2026-09-12T17:29:09.000Z",
    eventType: "item.completed", event: { item: { type: "command_execution", command, aggregated_output: output } },
  });
  const events = [
    record("tail -100 /repo/.ralph/last-test.log", summary(84)),
    record("make -j6 build > /tmp/build.log 2>&1 && make test-pa14 > /tmp/stage.log 2>&1", ""),
    record("tail -3 /tmp/stage.log; make test-report-through-pa13 > /tmp/prior.log 2>&1", summary(218)),
    record("tail -3 /tmp/stage.log", summary(0), 28),
  ];
  const results = progressEventsFromRunEvents(events);
  assert.equal(results.length, 1);
  assert.equal(results[0].event.progress.passed, 218);
  assert.equal(results[0].event.progress.total, 314);
  assert.equal(results[0].event.progress.stage, "pa14");
});

test("direct PA test summary is exact, while a selected check stays a subset", () => {
  const full = progressObservationFromSessionOutput(summary(), "now", "make -C pa14 test");
  assert.equal(full.passed, 219);
  assert.equal(full.hasSubset, false);
  const subset = progressObservationFromSessionOutput(summary(1, 2), "now", "make -C pa14 check TEST='tests/a.t tests/b.t'");
  assert.equal(subset.hasSubset, true);
  assert.equal(subset.total, 2);
});
