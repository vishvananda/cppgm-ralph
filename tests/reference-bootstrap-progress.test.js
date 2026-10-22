import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function browser() {
  const context = vm.createContext({ state: { progressBestCache: new Map() } });
  for (const [file, binding] of [
    ["entry-dedupe.js", "ENTRY_DEDUPE=RALPH_ENTRY_DEDUPE"],
    ["turn-lifecycle.js", "TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
    ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
    ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
    ["test-command-provenance.js", "TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
  ]) {
    vm.runInContext(await fs.readFile(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), context);
    vm.runInContext(`const ${binding};`, context);
  }
  const app = await fs.readFile(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
  for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) vm.runInContext(match[0], context);
  return context;
}
const command = action => `python3 scripts/reference_bootstrap.py ${action} --profile student`;
function phase(action, turn, passed, total = 236) {
  const testStatus = { command: command(action), targetStage: "pa34", exitCode: passed === total ? 0 : 1,
    testsPassed: passed, testsTotal: total, allTestsPassed: passed === total, stages: [] };
  const check = { name: action, command: command(action), primary: true,
    kind: action === "progress" ? "test" : "generic", passed: passed === total,
    exitCode: passed === total ? 0 : 1, testStatus };
  return { eventType: "ralph.phase-status", turnNumber: turn, recordedAt: `2026-10-22T22:${turn}:00Z`,
    event: { phaseStatus: { stage: "pa34", phase: action === "progress" ? "implement" : "audit",
      primaryCheck: check, checks: [check, { name: "prior", command: "make test-report-through-pa33",
        passed: true, testStatus: { testsPassed: 7000, testsTotal: 7000 } }], testStatus } } };
}
function proof(turn, fixed, suites) {
  return { eventType: "item.completed", turnNumber: turn, recordedAt: `2026-10-22T22:${turn}:01Z`,
    event: { item: { type: "command_execution", command: command("final"), exit_code: fixed && suites ? 0 : 1,
      aggregated_output: `reference-bootstrap/fixed-point: ${fixed ? "PASS (1/1)" : "FAIL (0/1)"}\n` +
        `reference-bootstrap/rebuilt-suites: ${suites ? "PASS (1/1)" : "FAIL (0/1)"}\n` } } };
}

test("complete build inventory leaves two proof checks pending in the standard bar", async () => {
  const b = await browser();
  const progress = b.buildAgentTestProgressState([phase("progress", 1, 236)]).latest;
  assert.equal(progress.current.passed, 236);
  assert.equal(progress.current.total, 238);
  assert.equal(progress.status, "running");
  const model = b.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(progress);
  assert.equal(model.rows.length, 1);
  const html = b.dockProgressBarHtml({}, progress, model);
  for (const text of ["start 236", "current 236", "best 236", "238 total"]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /dock-progress-block dock-progress-pass|bootstrap proof pending/);
});

test("fixed point and rebuilt suites count independently and cannot mask a proof regression", async () => {
  const b = await browser();
  const records = [phase("progress", 1, 236), proof(1, true, false)];
  let progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 237);
  assert.equal(progress.progressNote, "bootstrap proof failed");
  records.push(proof(1, true, true), proof(1, false, false));
  progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 236);
  assert.equal(progress.best.passed, 238);
});

test("the final generic check preserves the build count and adds proof results", async () => {
  const b = await browser();
  const records = [phase("progress", 1, 236), phase("final", 2, 0, 1)];
  let progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 236);
  assert.equal(progress.current.total, 238);
  records.push(phase("final", 2, 1, 1));
  progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 238);
  assert.equal(progress.status, "pass");
});

test("a fresh build invalidates an older compiler's proof and retains granular build failures", async () => {
  const b = await browser();
  const records = [phase("progress", 1, 236), proof(1, true, true), phase("progress", 2, 230)];
  const progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 230);
  assert.equal(progress.current.total, 238);
  assert.equal(progress.progressNote, "bootstrap proof pending");
});

test("quoted scripts and unrelated command output cannot certify bootstrap proof", async () => {
  const b = await browser();
  const fake = proof(1, true, true);
  fake.event.item.command = `echo '${command("final")}'`;
  assert.equal(b.buildAgentTestProgressState([phase("progress", 1, 236), fake]).latest.current.passed, 236);
});

test("later PA35 progress keeps its own total", async () => {
  const b = await browser();
  const record = phase("progress", 2, 4, 17);
  const phaseStatus = record.event.phaseStatus;
  phaseStatus.stage = "pa35";
  const status = phaseStatus.testStatus;
  Object.assign(status, { command: "make test-pa35", targetStage: "pa35",
    stages: [{ name: "pa35", passed: 4, total: 17, status: "fail" }] });
  phaseStatus.primaryCheck.command = status.command;
  const progress = b.buildAgentTestProgressState([phase("progress", 1, 236), record]).latest;
  assert.equal(progress.stage, "pa35");
  assert.equal(progress.current.total, 17);
});

test("a later failed proof cannot reuse a successful earlier proof", async () => {
  const b = await browser();
  const records = [phase("progress", 1, 236), proof(1, true, true), phase("final", 2, 0, 1)];
  const progress = b.buildAgentTestProgressState(records).latest;
  assert.equal(progress.current.passed, 236);
  assert.equal(progress.status, "fail");
  assert.equal(progress.progressNote, "bootstrap proof failed");
});

test("a successful fresh final proof certifies the complete build inventory", async () => {
  const b = await browser();
  const progress = b.buildAgentTestProgressState([phase("progress", 1, 230), proof(1, true, true)]).latest;
  assert.equal(progress.current.passed, 238);
  assert.equal(progress.current.total, 238);
  assert.equal(progress.status, "pass");
});
