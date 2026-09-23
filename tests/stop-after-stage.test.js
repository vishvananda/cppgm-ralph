import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RALPH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("stopAfterStage waits for PA7 audit and leaves PA8 ready to resume", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-stage-stop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, "work");
  const remote = path.join(root, "origin.git");
  const stateBaseDir = path.join(root, "state");
  const marker = path.join(root, "pa7-passed");
  const attemptsFile = path.join(root, "attempts");
  const checkPath = path.join(root, "check.sh");
  const runnerPath = path.join(root, "runner.mjs");
  const configPath = path.join(root, "ralph.config.json");
  await fsp.mkdir(path.join(workdir, "pa7"), { recursive: true });
  await fsp.mkdir(path.join(workdir, "pa8"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workdir });
  await fsp.writeFile(path.join(workdir, "pa7", "README.md"), "PA7\n");
  await fsp.writeFile(path.join(workdir, "pa8", "README.md"), "PA8\n");
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: workdir });
  execFileSync("git", ["push", "-qu", "origin", "HEAD"], { cwd: workdir });

  await fsp.writeFile(checkPath, `#!/bin/sh
if test "$1" = pa7 && test -f ${JSON.stringify(marker)}; then
  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='
  exit 0
fi
echo "$1/tests/incomplete.t: ERROR: incomplete"
exit 1
`, { mode: 0o755 });
  await fsp.writeFile(runnerPath, `import fs from "node:fs";
let attempts = 0;
try { attempts = Number(fs.readFileSync(${JSON.stringify(attemptsFile)}, "utf8")); } catch {}
fs.writeFileSync(${JSON.stringify(attemptsFile)}, String(attempts + 1));
fs.writeFileSync(${JSON.stringify(marker)}, "passed");
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
emit({ type: "driver.started", sessionId: "fixture" });
emit({ type: "model.start" });
emit({ type: "model.content", block: { text: "done" } });
emit({ type: "model.complete" });
emit({ type: "driver.completed", usage: { inputTokens: 1, outputTokens: 1 } });
`);
  const config = {
    provider: "strands", name: "stop-stage", model: "fake-model", reasoningEffort: "high",
    workdir, useExistingWorkdir: true, stateBaseDir, strandsPath: runnerPath,
    testCommand: `${checkPath} {{testStage}}`, initialStage: "pa7", maxTurns: 5,
    loopGoalsEnabled: false, resourceLimits: false, sessionIsolation: false,
    stopAfterStage: "pa7",
    phases: [
      { name: "implement", checks: ["tests"] },
      { name: "audit", runWhenChecksPass: true, checks: ["tests"] },
    ],
  };
  const run = () => {
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(process.execPath, [path.join(RALPH_ROOT, "ralph.js")], {
      cwd: RALPH_ROOT, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, RALPH_CONFIG: configPath, RALPH_RESOURCE_LIMITS: "0" },
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  const attempts = () => Number(fs.readFileSync(attemptsFile, "utf8"));
  const state = () => JSON.parse(fs.readFileSync(path.join(stateBaseDir, "stop-stage-fake-model-high", "state.json"), "utf8"));

  let result = run();
  assert.equal(result.status, 0, result.output);
  assert.equal(attempts(), 2, "PA8 started before stopping");
  assert.match(result.output, /stopAfterStage=pa7 reached after phase audit; exiting before pa8/);
  assert.equal(state().activeStage, "pa8");
  assert.equal(state().activePhase, "implement");

  result = run();
  assert.equal(result.status, 0, result.output);
  assert.equal(attempts(), 2, "restart ignored the configured stage stop");

  delete config.stopAfterStage;
  config.maxTurns = 3;
  result = run();
  assert.equal(attempts(), 3, `removing stopAfterStage did not resume PA8:\n${result.output}`);
});
