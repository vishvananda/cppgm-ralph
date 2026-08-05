import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("a blocked implementation checkpoint enters audit after recovery preserves progress", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-checkpoint-recovery-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const tracePath = path.join(root, "claude-prompts.jsonl");
  const progressMarker = path.join(root, "progress");
  const completeMarker = path.join(root, "complete");
  const regressionMarker = path.join(root, "regression");
  const priorCheck = path.join(root, "prior-check.sh");
  const stageCheck = path.join(root, "stage-check.sh");
  const fakeClaude = path.join(root, "fake-claude.js");
  const configPath = path.join(root, "ralph.config.json");

  await fsp.mkdir(path.join(workdir, "pa1"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "ralph-test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Ralph Test"], { cwd: workdir });
  await fsp.writeFile(path.join(workdir, "pa1", "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: workdir });
  execFileSync("git", ["push", "-qu", "origin", "HEAD"], { cwd: workdir });

  await fsp.writeFile(
    priorCheck,
    `#!/bin/sh\nif test -f ${shellQuote(regressionMarker)}; then\n` +
      `  echo 'prior stage regression'\n` +
      `  exit 1\n` +
      `fi\n` +
      `echo 'prior stages pass'\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    stageCheck,
    `#!/bin/sh\nif test -f ${shellQuote(completeMarker)}; then passed=3; ` +
      `elif test -f ${shellQuote(progressMarker)}; then passed=2; else passed=1; fi\n` +
      `echo '===== pa1 ====='\n` +
      `if test "$passed" -eq 3; then\n` +
      `  echo '===== ALL TESTS PASSED SUCCESSFULLY! (3/3) ====='\n` +
      `  exit 0\n` +
      `fi\n` +
      `echo "pa1/tests/incomplete.t: ERROR: checkpoint fixture ($passed/3)"\n` +
      `echo "===== TEST SUMMARY: $passed / 3 TESTS PASSED ====="\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    fakeClaude,
    fakeClaudeSource({ tracePath, progressMarker, completeMarker, regressionMarker }),
    { mode: 0o755 },
  );
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      provider: "claude",
      name: "checkpoint-recovery-test",
      model: "fake-model",
      workdir,
      useExistingWorkdir: true,
      stateBaseDir,
      claudePath: fakeClaude,
      loopGoalsEnabled: false,
      freshThreadPerTurn: true,
      maxTurns: 4,
      initialStage: "pa1",
      resourceLimits: false,
      sessionIsolation: false,
      checks: {
        priorThroughTests: { command: priorCheck, required: true },
        stageTests: {
          command: stageCheck,
          targetStage: "pa1",
          kind: "test",
          primary: true,
          required: false,
        },
        fileAudit: { command: "true", required: true },
        stageProgress: {
          command: "ralph:current-stage-progress stageTests {{testStage}}",
          required: true,
          dependsOn: ["priorThroughTests"],
        },
        stageProgressPreserved: {
          command: "ralph:current-stage-progress stageTests {{testStage}} mode=preserve",
          required: true,
          dependsOn: ["priorThroughTests"],
        },
      },
      phases: [
        {
          name: "implement",
          checkpointOnRequiredChecks: true,
          checkpointPhase: "checkpointAudit",
          checks: ["priorThroughTests", "stageTests", "fileAudit", "stageProgress"],
        },
        {
          name: "checkpointAudit",
          checkpointOnly: true,
          runWhenChecksPass: true,
          returnPhaseOnIncompletePrimary: "implement",
          checks: ["priorThroughTests", "stageTests", "fileAudit", "stageProgressPreserved"],
        },
      ],
    }, null, 2)}\n`,
  );

  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RALPH_CONFIG: configPath,
      RALPH_RESOURCE_LIMITS: "0",
      RALPH_SESSION_ISOLATION: "0",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 0, `Ralph failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

  const prompts = readJsonLines(tracePath).map((entry) => entry.input);
  assert.equal(prompts.length, 3, `unexpected provider turns:\n${prompts.join("\n---\n")}`);
  assert.match(prompts[1], /pending checkpoint: 2\/3 passing from baseline 1\/3/i);
  assert.match(prompts[2], /Current phase: `checkpointAudit`/);

  const stateDir = path.join(stateBaseDir, "checkpoint-recovery-test-fake-model-high");
  const state = JSON.parse(await fsp.readFile(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.activePhase, null);
  assert.equal(state.pendingCheckpoint, null);
});

function fakeClaudeSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const previous = fs.existsSync(paths.tracePath)
  ? fs.readFileSync(paths.tracePath, "utf8").trim().split("\\n").filter(Boolean).length
  : 0;
fs.appendFileSync(paths.tracePath, JSON.stringify({ input }) + "\\n");
if (previous === 0) {
  fs.writeFileSync(paths.progressMarker, "yes\\n");
  fs.writeFileSync(paths.regressionMarker, "yes\\n");
} else if (previous === 1) {
  fs.rmSync(paths.regressionMarker, { force: true });
} else if (previous === 2) {
  fs.writeFileSync(paths.completeMarker, "yes\\n");
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const sessionId = "checkpoint-recovery-" + previous;
const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 };
emit({ type: "system", subtype: "init", session_id: sessionId });
emit({
  type: "assistant",
  session_id: sessionId,
  message: {
    id: "message-" + previous,
    model: "fake-model",
    role: "assistant",
    stop_reason: "end_turn",
    usage,
    content: [{ type: "text", text: "fixture turn complete" }],
  },
});
emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId, usage });
`;
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
