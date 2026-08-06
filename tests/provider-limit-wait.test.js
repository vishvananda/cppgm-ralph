import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearPersistedLimitWait,
  parseCodexUsageLimitResetAt,
  readPersistedLimitWait,
  writePersistedLimitWait,
} from "../provider-limit-wait.js";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Codex reset timestamps accept ordinal dates", () => {
  const parsed = parseCodexUsageLimitResetAt(
    "You've hit your usage limit. Try again at Aug 8th, 2026 3:33 AM.",
  );
  assert.equal(parsed, new Date(2026, 7, 8, 3, 33, 0).getTime());
});

test("persisted waits are cleared only by their owner", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-limit-state-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "limit-wait.json");
  const value = await writePersistedLimitWait(filePath, {
    id: "wait-1",
    provider: "codex",
    reason: "usage_limit",
    threadId: "thread-1",
    turnNumber: 7,
    attempt: 1,
    startedAt: "2026-08-06T00:00:00.000Z",
    resumeAt: "2026-08-08T00:00:00.000Z",
    message: "limited",
  });
  assert.equal(value.turnNumber, 7);
  assert.equal((await readPersistedLimitWait(filePath)).threadId, "thread-1");
  assert.equal(await clearPersistedLimitWait(filePath, "another-wait"), false);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(await clearPersistedLimitWait(filePath, "wait-1"), true);
  assert.equal(fs.existsSync(filePath), false);
});

test("a persisted Codex limit resumes the same turn and reuses its checks", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-codex-limit-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const invocationPath = path.join(root, "codex-invocations");
  const checkTracePath = path.join(root, "check-invocations");
  const passMarker = path.join(root, "checks-pass");
  const checkPath = path.join(root, "check.sh");
  const fakeCodexPath = path.join(root, "fake-codex.js");
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

  await fsp.writeFile(fakeCodexPath, fakeCodexSource({ invocationPath, passMarker }), { mode: 0o755 });
  await fsp.writeFile(
    checkPath,
    `#!/bin/sh\necho check >> ${shellQuote(checkTracePath)}\n` +
      `if test -f ${shellQuote(passMarker)}; then\n` +
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
      provider: "codex",
      name: "codex-limit-test",
      model: "fake-model",
      reasoningEffort: "high",
      workdir,
      useExistingWorkdir: true,
      stateBaseDir,
      testCommand: checkPath,
      codexPath: fakeCodexPath,
      loopGoalsEnabled: false,
      freshThreadPerTurn: true,
      maxTurns: 2,
      resourceLimits: false,
      sessionIsolation: false,
    }, null, 2)}\n`,
  );

  const env = {
    ...process.env,
    RALPH_CONFIG: configPath,
    RALPH_RESOURCE_LIMITS: "0",
    RALPH_SESSION_ISOLATION: "0",
    RALPH_CODEX_LIMIT_FALLBACK_WAIT_MS: "600000",
    RALPH_CODEX_LIMIT_MIN_WAIT_MS: "1",
  };
  const first = spawn(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstOutput = collectOutput(first);
  const stateDir = path.join(stateBaseDir, "codex-limit-test-fake-model-high");
  const waitPath = path.join(stateDir, "limit-wait.json");
  await waitFor(() => fs.existsSync(waitPath), 10_000);
  first.kill("SIGINT");
  const firstResult = await firstOutput;
  assert.equal(firstResult.code, 130, firstResult.output);
  assert.equal((await readPersistedLimitWait(waitPath)).turnNumber, 1);
  assert.equal(readLines(checkTracePath).length, 1);

  const second = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "ralph.js"), "--ignore-limit-wait"],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(second.status, 0, `Ralph failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.equal(fs.existsSync(waitPath), false);
  assert.equal(readLines(checkTracePath).length, 2, "startup prechecks were rerun after the wait");

  const records = readEventRecords(stateDir);
  const limitWait = records.find((record) => record.eventType === "ralph.limit_wait");
  const bypass = records.find((record) => record.eventType === "ralph.limit_wait_bypassed");
  assert.ok(limitWait, "missing persisted limit event");
  assert.ok(bypass, "missing limit bypass event");
  assert.equal(limitWait.turnNumber, 1);
  assert.equal(bypass.turnNumber, 1);
  assert.equal(bypass.event.reason, "operator_override");
  assert.ok(records.some((record) => record.eventType === "turn.completed" && record.turnNumber === 1));
  assert.equal(records.some((record) => record.turnNumber === 2), false);
});

function fakeCodexSource(paths) {
  return `#!/usr/bin/env node
import fs from "node:fs";

const paths = ${JSON.stringify(paths)};
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.on("end", resolve);
});
const invocation = fs.existsSync(paths.invocationPath)
  ? Number(fs.readFileSync(paths.invocationPath, "utf8")) + 1
  : 1;
fs.writeFileSync(paths.invocationPath, String(invocation));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const threadId = "codex-limit-test-thread";
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started", thread_id: threadId });
if (invocation === 1) {
  emit({ type: "error", message: "You've hit your usage limit. Please try again later." });
  process.exit(0);
}
fs.writeFileSync(paths.passMarker, "yes\\n");
emit({
  type: "item.completed",
  item: { id: "message-1", type: "agent_message", text: "Completed the fixture." },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
});
`;
}

function collectOutput(child) {
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function readLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
}

function readEventRecords(stateDir) {
  const eventsDir = path.join(stateDir, "events");
  return fs.readdirSync(eventsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readLines(path.join(eventsDir, name)).map((line) => JSON.parse(line)));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
