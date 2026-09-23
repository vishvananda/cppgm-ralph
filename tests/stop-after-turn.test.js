import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_NAME = "stop-test-fake-model-high";

// A throwaway run driven by a fake turn runner. `runnerBody` sees `attempts` (1-based), `emit`,
// `stopFile` and `passMarker`; the check passes once passMarker exists.
async function scaffold(t, { runnerBody, config = {} }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-stop-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const stateDir = path.join(stateBaseDir, STATE_NAME);
  const attemptsPath = path.join(root, "attempts");
  const passMarker = path.join(root, "checks-pass");
  const runnerPath = path.join(root, "fake-runner.mjs");
  const checkPath = path.join(root, "check.sh");
  const configPath = path.join(root, "ralph.config.json");

  await fsp.mkdir(workdir, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "T"]]) {
    execFileSync("git", args, { cwd: workdir });
  }
  await fsp.writeFile(path.join(workdir, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: workdir });
  execFileSync("git", ["push", "-qu", "origin", "HEAD"], { cwd: workdir });

  await fsp.writeFile(runnerPath, `#!/usr/bin/env node
import fs from "node:fs";
let attempts = 0;
try { attempts = Number(fs.readFileSync(${JSON.stringify(attemptsPath)}, "utf8")) || 0; } catch {}
attempts += 1;
fs.writeFileSync(${JSON.stringify(attemptsPath)}, String(attempts));
const stopFile = ${JSON.stringify(path.join(stateDir, "stop-after-turn"))};
const passMarker = ${JSON.stringify(passMarker)};
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "driver.started", sessionId: "t" + attempts });
emit({ type: "model.start" });
emit({ type: "model.content", block: { text: "done" } });
emit({ type: "model.complete" });
${runnerBody}
emit({ type: "driver.completed", usage: { inputTokens: 1, outputTokens: 1 } });
`, { mode: 0o755 });
  await fsp.writeFile(checkPath,
    `#!/bin/sh\nif test -f ${JSON.stringify(passMarker)}; then\n` +
    `  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1 / 1) ====='\n  exit 0\nfi\n` +
    `echo 'fixture: ERROR: not complete'\necho '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='\nexit 1\n`,
    { mode: 0o755 });

  const writeConfig = (extra = {}) => fs.writeFileSync(configPath, JSON.stringify({
    provider: "strands", name: "stop-test", model: "fake-model", reasoningEffort: "high",
    workdir, useExistingWorkdir: true, stateBaseDir, testCommand: checkPath,
    strandsPath: runnerPath, initialStage: "pa1",
    maxTurns: 5, resourceLimits: false, sessionIsolation: false, loopGoalsEnabled: false,
    ...config, ...extra,
  }, null, 2));
  writeConfig();

  const run = () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, RALPH_CONFIG: configPath, RALPH_RESOURCE_LIMITS: "0" } });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  const attempts = () => { try { return Number(fs.readFileSync(attemptsPath, "utf8")); } catch { return 0; } };
  const records = () => fs.readdirSync(path.join(stateDir, "events")).flatMap((f) =>
    fs.readFileSync(path.join(stateDir, "events", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const state = () => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const stopFile = path.join(stateDir, "stop-after-turn");
  return { run, attempts, records, state, stopFile, writeConfig, passMarker, checkPath };
}

const phaseActions = (records, turn) => records
  .filter((r) => r.eventType === "ralph.phase-status" && r.turnNumber === turn)
  .map((r) => r.event?.action);

// The case that surfaced this: a stop requested while ralph was not running, then a launch to bring
// the run to a consistent end. It used to exit before running any check at all; now it verifies the
// last turn, records the result against that turn, and still starts no new one.
test("a stop at launch verifies the last turn and starts no new one", async (t) => {
  const f = await scaffold(t, { runnerBody: "" });
  f.writeConfig({ maxTurns: 1 });
  f.run(); // turn 1 runs; its checks fail, so the budget of one turn is spent
  assert.equal(f.attempts(), 1);
  const before = f.records().length;

  f.writeConfig({ maxTurns: 5 });
  fs.mkdirSync(path.dirname(f.stopFile), { recursive: true });
  fs.writeFileSync(f.stopFile, "");
  const { status, output } = f.run();

  assert.equal(status, 0, output);
  assert.equal(f.attempts(), 1, "a new turn was started despite the stop request");
  assert.match(output, /turn 1 verified: .*required checks still incomplete\. Exiting before turn 2/);
  assert.ok(!fs.existsSync(f.stopFile), "the stop request was not consumed");
  const added = f.records().slice(before);
  assert.deepEqual(phaseActions(added, 1), ["stop-checked"], "the verified result was not recorded against turn 1");
  assert.ok(added.some((r) => r.eventType === "ralph.test-status" && r.turnNumber === 1));
  assert.ok(f.state().lastTestStatus?.recordedAt, "state does not carry the verified test status");
  assert.equal(f.state().lastExitCode, 1);
});

// Stopping during a turn whose checks still fail: the turn is verified and recorded, and the run
// ends there instead of handing out turn 2.
test("a stop during a failing turn records that turn's result and exits", async (t) => {
  const f = await scaffold(t, { runnerBody: "if (attempts === 1) fs.writeFileSync(stopFile, '');" });
  const { status, output } = f.run();
  assert.equal(status, 0, output);
  assert.equal(f.attempts(), 1);
  assert.ok(phaseActions(f.records(), 1).includes("stop-checked"), output);
  assert.doesNotMatch(output, /Handing control back to .*turn 2/);
});

test("a stop during the last allowed turn still runs its checks", async (t) => {
  const f = await scaffold(t, {
    runnerBody: "fs.writeFileSync(stopFile, '');",
    config: { maxTurns: 1 },
  });
  const { status, output } = f.run();
  assert.equal(status, 0, output);
  assert.equal(f.attempts(), 1);
  assert.ok(phaseActions(f.records(), 1).includes("stop-checked"), output);
  assert.ok(f.state().lastTestStatus?.recordedAt);
});

// A turn that passes: its "checked" record and the phase advance it earns must both happen before
// the stop, and the stop must not write a second record for the same turn.
test("a stop during a passing turn still advances the phase, with one record", async (t) => {
  const f = await scaffold(t, {
    runnerBody: "if (attempts === 1) { fs.writeFileSync(passMarker, ''); fs.writeFileSync(stopFile, ''); }",
    config: {
      phases: [
        { name: "implement", checks: ["tests"] },
        { name: "audit", runWhenChecksPass: true, checks: ["tests"] },
      ],
    },
  });
  // The check command's path is only known once scaffolded.
  f.writeConfig({ checks: { tests: { command: f.checkPath, primary: true, required: true, kind: "test" } } });

  const { status, output } = f.run();
  assert.equal(status, 0, output);
  assert.equal(f.attempts(), 1, "the audit turn was started despite the stop request");
  const actions = phaseActions(f.records(), 1);
  assert.ok(actions.includes("checked"), `turn 1 was not recorded as checked: ${actions}`);
  assert.ok(!actions.includes("stop-checked"), "the stop wrote a second record for an already-checked turn");
  assert.equal(f.state().activePhase, "audit", "the phase advance earned by turn 1 was lost");
  // The next phase starting incomplete must not read as turn 1 having failed.
  assert.match(output, /turn 1 met its exit criteria and is recorded; next would be audit/);
});
