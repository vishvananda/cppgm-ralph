import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("an incomplete Claude goal compacts at a verified boundary before continuing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-claude-compact-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const tracePath = path.join(root, "claude-invocations.jsonl");
  const passMarker = path.join(root, "checks-pass");
  const checkPath = path.join(root, "check.sh");
  const compactMarker = path.join(root, "compacted");
  const continuedAfterStopMarker = path.join(root, "continued-after-stop");
  const fakeClaudePath = path.join(root, "fake-claude.js");
  const configPath = path.join(root, "ralph.config.json");

  await fsp.mkdir(workdir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "ralph-test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Ralph Test"], { cwd: workdir });
  await fsp.writeFile(path.join(workdir, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: workdir });
  execFileSync("git", ["push", "-qu", "origin", "HEAD"], { cwd: workdir });

  await fsp.writeFile(
    fakeClaudePath,
    fakeClaudeSource({
      tracePath,
      passMarker,
      compactMarker,
      continuedAfterStopMarker,
    }),
    { mode: 0o755 },
  );
  await fsp.writeFile(
    checkPath,
    `#!/bin/sh\nif test -f ${shellQuote(passMarker)}; then\n` +
      `  echo '===== ALL TESTS PASSED SUCCESSFULLY! (1 / 1) ====='\n` +
      `  exit 0\n` +
      `fi\n` +
      `echo 'fixture: ERROR: not complete'\n` +
      `echo '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      provider: "claude",
      name: "compact-test",
      model: "fake-model",
      reasoningEffort: "high",
      workdir,
      useExistingWorkdir: true,
      stateBaseDir,
      testCommand: checkPath,
      claudePath: fakeClaudePath,
      claudeCompactOnIncompleteGoal: true,
      loopGoalsEnabled: true,
      maxTurns: 2,
      resourceLimits: false,
      sessionIsolation: false,
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
  assert.equal(
    run.status,
    0,
    `Ralph failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );

  const invocations = readJsonLines(tracePath);
  assert.deepEqual(
    invocations.slice(0, 4).map((entry) => commandKind(entry.input)),
    ["goal", "goal-clear", "compact", "goal"],
  );
  assert.equal(fs.existsSync(continuedAfterStopMarker), false, "the stopped Claude process kept running");
  assert.equal(fs.existsSync(passMarker), true, "the post-compaction continuation did not finish");

  const eventRecords = readEventRecords(stateBaseDir);
  const compactionStarted = eventRecords.filter(
    (record) => record.eventType === "claude.compaction_started",
  );
  const compactionCompleted = eventRecords.filter(
    (record) => record.eventType === "claude.compaction_completed",
  );
  assert.equal(compactionStarted.length, 1);
  assert.equal(compactionCompleted.length, 1);
  assert.equal(compactionCompleted[0].event.boundary_observed, true);
  assert.equal(compactionCompleted[0].turnNumber, compactionStarted[0].turnNumber);

  const eventTypes = eventRecords.map((record) => record.eventType);
  assert.ok(
    eventTypes.indexOf("claude.compaction_started") <
      eventTypes.indexOf("claude.compaction_completed"),
  );
  const turnCompleted = eventRecords.find((record) => record.eventType === "turn.completed");
  assert.ok(turnCompleted);
  assert.equal(turnCompleted.turnNumber, compactionCompleted[0].turnNumber);
});

test("a resumed Claude session replaces its interrupted goal with refreshed criteria", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-claude-goal-resume-test-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const workdir = path.join(root, "worktree");
  const stateBaseDir = path.join(root, "state");
  const stateDir = path.join(stateBaseDir, "resume-goal-test-fake-model-high");
  const stopPath = path.join(stateDir, "stop-after-turn");
  const tracePath = path.join(root, "claude-invocations.jsonl");
  const checkPath = path.join(root, "check.sh");
  const fakeClaudePath = path.join(root, "fake-claude.js");
  const configPath = path.join(root, "ralph.config.json");

  await fsp.mkdir(path.join(workdir, "pa1"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "ralph-test@example.invalid"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "Ralph Test"], { cwd: workdir });
  await fsp.writeFile(path.join(workdir, "pa1", "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workdir });

  await fsp.writeFile(
    checkPath,
    "#!/bin/sh\necho '===== pa1 ====='\n" +
      "echo 'pa1/tests/incomplete.t: ERROR: not complete'\n" +
      "echo '===== TEST SUMMARY: 0 / 1 TESTS PASSED ====='\n" +
      "exit 1\n",
    { mode: 0o755 },
  );
  await fsp.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const tracePath = ${JSON.stringify(tracePath)};
const stopPath = ${JSON.stringify(stopPath)};
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(tracePath, JSON.stringify({ input }) + "\\n");

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 };
if (input.trim() === "/goal clear") {
  emit({ type: "result", subtype: "success", is_error: false, result: "Goal cleared", session_id: "resume-session", usage });
} else if (input.trim() === "/goal") {
  emit({ type: "result", subtype: "success", is_error: false, result: "Goal active", session_id: "resume-session", usage });
} else {
  fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
  fs.writeFileSync(stopPath, "yes\\n");
  emit({ type: "system", subtype: "init", session_id: "resume-session" });
  emit({
    type: "assistant",
    session_id: "resume-session",
    message: {
      id: "resume-message",
      model: "fake-model",
      role: "assistant",
      stop_reason: "end_turn",
      usage,
      content: [{ type: "text", text: "fixture turn complete" }],
    },
  });
  emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "resume-session", usage });
}
`,
    { mode: 0o755 },
  );
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({
      provider: "claude",
      name: "resume-goal-test",
      model: "fake-model",
      reasoningEffort: "high",
      workdir,
      useExistingWorkdir: true,
      stateBaseDir,
      testCommand: checkPath,
      initialStage: "pa1",
      claudePath: fakeClaudePath,
      loopGoalsEnabled: true,
      freshThreadPerTurn: true,
      maxTurns: 3,
      resourceLimits: false,
      sessionIsolation: false,
    }, null, 2)}\n`,
  );

  const env = {
    ...process.env,
    RALPH_CONFIG: configPath,
    RALPH_RESOURCE_LIMITS: "0",
    RALPH_SESSION_ISOLATION: "0",
  };
  const firstRun = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(
    firstRun.status,
    0,
    `Initial Ralph run failed\nstdout:\n${firstRun.stdout}\nstderr:\n${firstRun.stderr}`,
  );
  const resumedRun = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "ralph.js"), "--continue", "--reuse-last-checks"],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(
    resumedRun.status,
    0,
    `Resumed Ralph run failed\nstdout:\n${resumedRun.stdout}\nstderr:\n${resumedRun.stderr}`,
  );

  const invocations = readJsonLines(tracePath).map((entry) => entry.input.trim());
  assert.equal(invocations.length, 3, `unexpected Claude invocations:\n${invocations.join("\n---\n")}`);
  assert.match(invocations[0], /^\/goal Ralph loop 1 /);
  assert.equal(invocations[1], "/goal clear");
  assert.match(invocations[2], /^\/goal Ralph loop 2 /);
});

function fakeClaudeSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
const input = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});
fs.appendFileSync(paths.tracePath, JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");

const sessionId = "claude-compaction-test-session";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 20,
  output_tokens: 3,
};

async function main() {
if (input.trim() === "/goal clear") {
  emit({ type: "result", subtype: "success", is_error: false, result: "Goal cleared", session_id: sessionId, usage });
  process.exit(0);
}

if (input.trim() === "/compact") {
  fs.writeFileSync(paths.compactMarker, "yes\\n");
  emit({ type: "system", subtype: "init", session_id: sessionId });
  emit({
    type: "system",
    subtype: "compact_boundary",
    session_id: sessionId,
    compact_metadata: { trigger: "manual", pre_tokens: 700000 },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Conversation compacted",
    session_id: sessionId,
    usage,
    total_cost_usd: 0.01,
  });
  process.exit(0);
}

emit({ type: "system", subtype: "init", session_id: sessionId });
emit({
  type: "attachment",
  session_id: sessionId,
  attachment: { type: "goal_status", met: false, sentinel: true, reason: "Goal installed" },
});
emit({
  type: "assistant",
  session_id: sessionId,
  request_id: fs.existsSync(paths.compactMarker) ? "request-after" : "request-before",
  message: {
    id: fs.existsSync(paths.compactMarker) ? "message-after" : "message-before",
    model: "fake-model",
    role: "assistant",
    stop_reason: "end_turn",
    usage,
    content: [{ type: "text", text: fs.existsSync(paths.compactMarker) ? "Completed" : "Stopping early" }],
  },
});

if (!fs.existsSync(paths.compactMarker)) {
  emit({
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: "Stop hook feedback:\\n[Fake Ralph goal]: Required checks still fail",
    },
  });
  setTimeout(() => {
    fs.writeFileSync(paths.continuedAfterStopMarker, "bad\\n");
    emit({ type: "assistant", session_id: sessionId, message: { model: "fake-model", usage, content: [] } });
  }, 250);
  return;
}

fs.writeFileSync(paths.passMarker, "yes\\n");
emit({
  type: "attachment",
  session_id: sessionId,
  attachment: { type: "goal_status", met: true, sentinel: true, reason: "Done" },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Completed",
  session_id: sessionId,
  usage,
  total_cost_usd: 0.02,
});
}

await main();
`;
}

function commandKind(input) {
  const command = input.trim();
  if (command === "/goal clear") return "goal-clear";
  if (command === "/compact") return "compact";
  if (command.startsWith("/goal ")) return "goal";
  return command;
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function readEventRecords(stateBaseDir) {
  const files = [];
  collectJsonlFiles(stateBaseDir, files);
  return files.flatMap(readJsonLines);
}

function collectJsonlFiles(directory, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(entryPath, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(entryPath);
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
