import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("phases can alternate Fable and Luna with sparse checkpoint reviews", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-mixed-provider-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const tracePath = path.join(root, "provider-trace.jsonl");
  const progressPath = path.join(root, "progress-count");
  const stageCheck = path.join(root, "stage-check.sh");
  const fakeClaude = path.join(root, "fake-claude.js");
  const fakeCodex = path.join(root, "fake-codex.js");
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
    stageCheck,
    `#!/bin/sh\n` +
      `count=0\n` +
      `test ! -f ${shellQuote(progressPath)} || count=$(cat ${shellQuote(progressPath)})\n` +
      `passed=$((1 + count))\n` +
      `test "$passed" -le 6 || passed=6\n` +
      `echo '===== pa1 ====='\n` +
      `if test "$passed" -eq 6; then\n` +
      `  echo '===== ALL TESTS PASSED SUCCESSFULLY! (6/6) ====='\n` +
      `  exit 0\n` +
      `fi\n` +
      `echo "pa1/tests/incomplete.t: ERROR: checkpoint fixture ($passed/6)"\n` +
      `echo "===== TEST SUMMARY: $passed / 6 TESTS PASSED ====="\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    fakeClaude,
    fakeClaudeSource({ tracePath }),
    { mode: 0o755 },
  );
  await fsp.writeFile(
    fakeCodex,
    fakeCodexSource({ tracePath, progressPath }),
    { mode: 0o755 },
  );
  await fsp.writeFile(configPath, `${JSON.stringify({
    provider: "claude",
    name: "mixed-provider-test",
    model: "claude-fable-5",
    reasoningEffort: "xhigh",
    workdir,
    useExistingWorkdir: true,
    stateBaseDir,
    claudePath: fakeClaude,
    codexPath: fakeCodex,
    loopGoalsEnabled: false,
    freshThreadPerTurn: false,
    eventLogScope: "run",
    maxTurns: 9,
    initialStage: "pa1",
    resourceLimits: false,
    sessionIsolation: false,
    checks: {
      priorThroughTests: { command: "true", required: true },
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
        name: "plan",
        runWhenChecksPass: true,
        checks: ["priorThroughTests", "stageTests", "fileAudit"],
      },
      {
        name: "implement",
        agent: {
          provider: "codex",
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
        },
        checkpointOnRequiredChecks: true,
        checkpointPhase: "checkpointReview",
        checkpointPhaseEvery: 4,
        checks: ["priorThroughTests", "stageTests", "fileAudit", "stageProgress"],
      },
      {
        name: "checkpointReview",
        checkpointOnly: true,
        runWhenChecksPass: true,
        returnPhaseOnIncompletePrimary: "implement",
        checks: ["priorThroughTests", "stageTests", "fileAudit", "stageProgressPreserved"],
      },
      {
        name: "cleanup",
        runWhenChecksPass: true,
        checks: ["priorThroughTests", "stageTests", "fileAudit"],
      },
    ],
  }, null, 2)}\n`);

  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RALPH_CONFIG: configPath,
      RALPH_RESOURCE_LIMITS: "0",
      RALPH_SESSION_ISOLATION: "0",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `Ralph failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

  const trace = readJsonLines(tracePath);
  assert.deepEqual(
    trace.map((entry) => entry.provider),
    ["claude", "codex", "codex", "codex", "codex", "claude", "codex", "claude"],
  );
  const claudeTurns = trace.filter((entry) => entry.provider === "claude");
  assert.equal(claudeTurns.length, 3);
  for (const turn of claudeTurns) {
    assert.ok(turn.args.includes("claude-fable-5"));
    assert.ok(turn.args.includes("xhigh"));
  }
  const codexTurns = trace.filter((entry) => entry.provider === "codex");
  assert.equal(codexTurns.length, 5);
  for (const turn of codexTurns) {
    assert.ok(turn.args.includes("gpt-5.6-luna"));
    assert.ok(turn.args.includes("model_reasoning_effort=\"max\""));
    assert.equal(turn.args.includes("claude-thread"), false);
  }
  assert.equal(codexTurns[0].args.includes("resume"), false);
  for (const turn of codexTurns.slice(1, 4)) {
    assert.ok(turn.args.includes("resume"));
    assert.ok(turn.args.includes("codex-thread"));
  }
  assert.match(claudeTurns[1].input, /accepted checkpoints since review: 4/i);

  const stateDir = path.join(stateBaseDir, "mixed-provider-test-claude-fable-5-xhigh");
  const state = JSON.parse(await fsp.readFile(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.activePhase, null);
  assert.equal(state.checkpointReview, null);
  assert.equal(state.threadAgent.provider, "claude");
  assert.equal(state.threadAgent.model, "claude-fable-5");

  const codexSessions = path.join(root, "codex-sessions");
  const claudeProjects = path.join(root, "claude-projects");
  await fsp.mkdir(codexSessions, { recursive: true });
  await fsp.mkdir(claudeProjects, { recursive: true });
  const comparisonRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "compare-pa-costs.js"),
    "--format", "json",
    "--through", "pa1",
    "--ralph-dir", stateBaseDir,
    "--codex-dir", codexSessions,
    "--claude-dir", claudeProjects,
    "mixed-provider-test-claude-fable-5-xhigh",
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000 });
  assert.equal(
    comparisonRun.status,
    0,
    `comparison failed\nstdout:\n${comparisonRun.stdout}\nstderr:\n${comparisonRun.stderr}`,
  );
  const comparison = JSON.parse(comparisonRun.stdout);
  assert.equal(comparison.rows[0].runs[0].phases, "plan:1,implement:5,checkpointReview:1,cleanup:1");
  assert.deepEqual(
    comparison.rows[0].runs[0].usage.model_usage.map(({ model }) => model),
    ["claude-fable-5", "gpt-5.6-luna"],
  );
});

function fakeClaudeSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
fs.appendFileSync(paths.tracePath, JSON.stringify({ provider: "claude", args, input }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 };
emit({ type: "system", subtype: "init", session_id: "claude-thread" });
emit({
  type: "assistant",
  session_id: "claude-thread",
  message: {
    id: "message",
    model: "claude-fable-5",
    role: "assistant",
    stop_reason: "end_turn",
    usage,
    content: [{ type: "text", text: "fixture turn complete" }],
  },
});
emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "claude-thread", usage });
`;
}

function fakeCodexSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const previous = fs.existsSync(paths.progressPath)
  ? Number.parseInt(fs.readFileSync(paths.progressPath, "utf8"), 10)
  : 0;
fs.writeFileSync(paths.progressPath, String(previous + 1));
fs.appendFileSync(paths.tracePath, JSON.stringify({ provider: "codex", args, input }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "thread.started", thread_id: "codex-thread" });
emit({ type: "turn.started", thread_id: "codex-thread" });
emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
`;
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
