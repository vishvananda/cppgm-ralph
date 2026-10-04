import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import "../ralph-viz/test-progress-evidence.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fs.readFile(path.join(ROOT, "ralph.js"), "utf8");
const summary = "===== ALL TESTS PASSED SUCCESSFULLY! (54 / 54) =====\n";

function parser() {
  const context = vm.createContext({
    TEST_PROGRESS_EVIDENCE: globalThis.RALPH_TEST_PROGRESS_EVIDENCE,
    STAGE_COUNT_HINTS: new Map(),
    getPrimaryCheck: () => ({ command: "make test-pa1" }),
  });
  const start = source.indexOf("function analyzeTestProgress(");
  const end = source.indexOf("function buildTestStatusLines(", start);
  vm.runInContext(source.slice(start, end), context);
  for (const name of ["normalizeStageName", "normalizeTestSubset"]) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], context);
  }
  return (output = summary, options = {}) => context.analyzeTestProgress(output, null, {
    command: "make test-pa1", targetStage: "pa1", exitCode: 0, ...options,
  });
}

test("quiet counted success retains the direct command's stage and exact counts", () => {
  const status = parser()();
  assert.equal(status.stageCount, 1);
  assert.equal(status.stages[0].name, "pa1");
  assert.equal(status.stages[0].status, "pass");
  assert.equal(status.stages[0].passed, 54);
  assert.equal(status.stages[0].total, 54);
  assert.equal(status.testsUnknown, 0);
});

test("cumulative, focused and uncounted summaries cannot invent full-stage counts", () => {
  for (const options of [
    { command: "make test-report-through-pa3", targetStage: "pa3" },
    { command: "make test-pa1 GLOB=tests/smoke.t" },
    { command: "make -C pa1 check TEST=tests/smoke.t" },
    { targetSubset: "smoke" },
    { command: "make test-pa2", targetStage: "pa1" },
    { exitCode: 1 },
  ]) {
    assert.equal(parser()(summary, options).stageCount, 0, JSON.stringify(options));
  }
  assert.equal(parser()("===== ALL TESTS PASSED SUCCESSFULLY! =====\n").stageCount, 0);
  assert.equal(parser()("===== ALL TESTS PASSED SUCCESSFULLY! (53 / 54) =====\n").stageCount, 0);
});

test("quiet direct-stage success clears the progress gate and still requires an audit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-quiet-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "work");
  const stateBaseDir = path.join(root, "state");
  const remote = path.join(root, "origin.git");
  const trace = path.join(root, "turns.jsonl");
  const runner = path.join(root, "runner.mjs");
  const configPath = path.join(root, "quiet.config.json");
  await fs.mkdir(path.join(workdir, "pa1"), { recursive: true });
  await fs.mkdir(path.join(workdir, "pa2"));
  await fs.writeFile(path.join(workdir, "pa1", "README.md"), "fixture\n");
  await fs.writeFile(path.join(workdir, "pa2", "README.md"), "fixture\n");
  await fs.writeFile(path.join(workdir, "Makefile"), `test-pa1:
\t@if test -f passed; then echo '${summary.trim()}'; else echo '===== pa1 ====='; echo 'pa1/tests/fixture.t: ERROR: incomplete'; echo '===== TEST SUMMARY: 0 / 54 TESTS PASSED ====='; exit 1; fi
test-report-through-pa1: test-pa1
`);
  const git = (...args) => execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "fixture");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-qu", "origin", "HEAD");
  await fs.writeFile(path.join(root, "quiet.implement.md"), "Implementation fixture\n{{briefState}}\n");
  await fs.writeFile(path.join(root, "quiet.audit.md"), "Audit fixture\n{{briefState}}\n");
  await fs.writeFile(runner, `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const phase = request.prompt.startsWith('Audit fixture') ? 'audit' : 'implement';
fs.appendFileSync(${JSON.stringify(trace)}, phase + '\\n');
if (phase === 'implement') {
  fs.writeFileSync('passed', 'passed\\n');
  execFileSync('git', ['add', 'passed']);
  execFileSync('git', ['commit', '-qm', 'complete fixture']);
}
const emit = record => process.stdout.write(JSON.stringify(record) + '\\n');
emit({ type: 'driver.started', sessionId: request.sessionId });
emit({ type: 'model.start' });
emit({ type: 'model.content', block: { text: 'Done.' } });
emit({ type: 'model.complete' });
emit({ type: 'driver.completed', usage: { inputTokens: 1, outputTokens: 1 } });
`);
  await fs.writeFile(configPath, JSON.stringify({
    provider: "strands", name: "quiet", model: "fake-model", reasoningEffort: "high",
    workdir, useExistingWorkdir: true, stateBaseDir, strandsPath: runner,
    initialStage: "pa1", stopAfterStage: "pa1", maxTurns: 3,
    loopGoalsEnabled: true, resourceLimits: false, sessionIsolation: false,
    checks: {
      stageTests: { command: "make test-{{testStage}}", kind: "test", primary: true, required: false },
      stageProgress: { command: "ralph:current-stage-progress stageTests {{testStage}}", required: true },
    },
    phases: [
      { name: "implement", checks: ["stageTests", "stageProgress"] },
      { name: "audit", runWhenChecksPass: true, checks: ["stageTests", "stageProgress"] },
    ],
  }));
  const result = spawnSync(process.execPath, [path.join(ROOT, "ralph.js")], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    env: { ...process.env, RALPH_CONFIG: configPath, RALPH_RESOURCE_LIMITS: "0" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(trace, "utf8"), "implement\naudit\n");
  const stateDir = path.join(stateBaseDir, "quiet-fake-model-high");
  const state = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.activeStage, "pa2");
  assert.equal(state.activePhase, "implement");
  assert.equal(state.turnsCompleted, 2);
  assert.match(await fs.readFile(path.join(stateDir, "checks", "last-stageProgress.log"), "utf8"), /PASS: pa1 is complete/);
});
