import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("a stage-specific checkpoint phase replaces the default review for that stage", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-stage-checkpoint-phase-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const tracePath = path.join(root, "claude-prompts.jsonl");
  const progressMarker = path.join(root, "progress");
  const completeMarker = path.join(root, "complete");
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
  await fsp.writeFile(fakeClaude, fakeClaudeSource({ tracePath, progressMarker, completeMarker }), { mode: 0o755 });
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      provider: "claude",
      name: "stage-checkpoint-phase-test",
      model: "fake-model",
      workdir,
      useExistingWorkdir: true,
      stateBaseDir,
      claudePath: fakeClaude,
      loopGoalsEnabled: true,
      freshThreadPerTurn: true,
      maxTurns: 4,
      initialStage: "pa1",
      resourceLimits: false,
      sessionIsolation: false,
      checks: {
        priorThroughTests: { command: "echo 'prior stages pass'", required: true },
        stageTests: {
          command: stageCheck,
          targetStage: "pa1",
          kind: "test",
          primary: true,
          required: false,
        },
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
          checkpointPhases: { pa1: "restructure" },
          checks: ["priorThroughTests", "stageTests", "stageProgress"],
        },
        {
          name: "checkpointAudit",
          checkpointOnly: true,
          runWhenChecksPass: true,
          returnPhaseOnIncompletePrimary: "implement",
          checks: ["priorThroughTests", "stageTests", "stageProgressPreserved"],
        },
        {
          name: "restructure",
          checkpointOnly: true,
          runWhenChecksPass: true,
          returnPhaseOnIncompletePrimary: "implement",
          checks: ["priorThroughTests", "stageTests", "stageProgressPreserved"],
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

  const prompts = readJsonLines(tracePath).map((entry) => entry.systemPrompt ?? entry.input);
  assert.equal(prompts.length, 3, `unexpected provider turns:\n${prompts.join("\n---\n")}`);
  assert.match(prompts[0], /Current phase: `implement`/);
  assert.match(prompts[1], /Current phase: `restructure`/);
  assert.match(prompts[2], /Current phase: `implement`/);
  assert.doesNotMatch(prompts.join("\n"), /Current phase: `checkpointAudit`/);
  assert.match(run.stdout, /advancing to checkpoint phase restructure/);
});

test("checkpointPhases must name configured phases for pa stages", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-stage-checkpoint-phase-config-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const configPath = path.join(root, "ralph.config.json");
  const baseConfig = {
    provider: "claude",
    name: "stage-checkpoint-phase-config-test",
    model: "fake-model",
    workdir: root,
    useExistingWorkdir: true,
    stateBaseDir: path.join(root, "state"),
    claudePath: "/bin/false",
    maxTurns: 1,
    resourceLimits: false,
    sessionIsolation: false,
    checks: { stageTests: { command: "true", kind: "test", primary: true } },
  };
  for (const [checkpointPhases, message] of [
    [{ pa35: "missing" }, /checkpointPhases\.pa35 references unknown phase missing/],
    [{ later: "review" }, /checkpointPhases stage must be a pa stage: later/],
  ]) {
    await fsp.writeFile(configPath, `${JSON.stringify({
      ...baseConfig,
      phases: [
        { name: "implement", checkpointOnRequiredChecks: true, checkpointPhases, checks: ["stageTests"] },
        { name: "review", checkpointOnly: true, runWhenChecksPass: true, checks: ["stageTests"] },
      ],
    }, null, 2)}\n`);
    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
      cwd: REPO_ROOT,
      env: { ...process.env, RALPH_CONFIG: configPath, RALPH_RESOURCE_LIMITS: "0", RALPH_SESSION_ISOLATION: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(`${run.stdout}\n${run.stderr}`, message);
  }
});

function fakeClaudeSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const systemPromptIndex = args.indexOf("--append-system-prompt-file");
const systemPromptPath = systemPromptIndex >= 0 ? args[systemPromptIndex + 1] : null;
const systemPromptFd = /^\\/dev\\/fd\\/(\\d+)$/.exec(systemPromptPath ?? "");
const systemPrompt = systemPromptIndex >= 0
  ? fs.readFileSync(systemPromptFd ? Number(systemPromptFd[1]) : systemPromptPath, "utf8")
  : null;
const previous = fs.existsSync(paths.tracePath)
  ? fs.readFileSync(paths.tracePath, "utf8").trim().split("\\n").filter(Boolean).length
  : 0;
fs.appendFileSync(paths.tracePath, JSON.stringify({ input, args, systemPrompt }) + "\\n");
if (previous === 0) {
  fs.writeFileSync(paths.progressMarker, "yes\\n");
} else if (previous === 2) {
  fs.writeFileSync(paths.completeMarker, "yes\\n");
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const sessionId = "stage-checkpoint-phase-" + previous;
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
