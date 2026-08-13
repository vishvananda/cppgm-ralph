import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import {
  buildSystemdScopeSpawn,
  buildSystemdScopeUnitName,
  stopSystemdScope,
} from "../systemd-scope.js";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("resource-limited commands use a uniquely addressable killable scope", () => {
  const unitName = buildSystemdScopeUnitName({ pid: 123, id: "fixture-id" });
  assert.equal(unitName, "ralph-turn-123-fixtureid.scope");

  const wrapped = buildSystemdScopeSpawn("agent", ["--turn"], {
    memoryMax: "8G",
    memorySwapMax: "0",
    oomGroup: false,
    cleanupTimeoutSec: 1.5,
  }, { unitName });

  assert.equal(wrapped.command, "systemd-run");
  assert.equal(wrapped.unitName, unitName);
  assert.deepEqual(wrapped.args.slice(0, 7), [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--unit",
    unitName,
    "--property",
  ]);
  assert.ok(wrapped.args.includes("KillMode=control-group"));
  assert.ok(wrapped.args.includes("SendSIGKILL=yes"));
  assert.ok(wrapped.args.includes("TimeoutStopSec=1.5s"));
  assert.deepEqual(wrapped.args.slice(-3), ["--", "agent", "--turn"]);
});

test("scope cleanup accepts an already-collected unit and rejects other failures", async () => {
  const calls = [];
  const absentSpawn = fakeSpawn(calls, {
    code: 5,
    stderr: "Failed to stop unit.scope: Unit unit.scope not loaded.\n",
  });
  assert.deepEqual(
    await stopSystemdScope("unit.scope", { spawnProcess: absentSpawn }),
    { status: "absent" },
  );
  assert.deepEqual(calls[0], {
    command: "systemctl",
    args: ["--user", "stop", "--no-ask-password", "unit.scope"],
  });

  await assert.rejects(
    stopSystemdScope("broken.scope", {
      spawnProcess: fakeSpawn([], { code: 1, stderr: "Access denied\n" }),
    }),
    /Failed to stop resource scope broken\.scope.*Access denied/,
  );
});

const hasUserSystemd = Boolean(
  process.platform !== "win32" &&
  commandOnPath("systemd-run") &&
  commandOnPath("systemctl") &&
  (process.env.DBUS_SESSION_BUS_ADDRESS || (
    process.env.XDG_RUNTIME_DIR &&
    fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR, "bus"))
  )),
);

test("stopping a completed turn scope reaps a detached descendant", {
  skip: !hasUserSystemd,
  timeout: 15_000,
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-scope-test-"));
  const pidPath = path.join(root, "descendant.pid");
  const unitName = buildSystemdScopeUnitName();
  t.after(async () => {
    await stopSystemdScope(unitName).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  const wrapped = buildSystemdScopeSpawn("bash", [
    "-lc",
    `sleep 300 >/dev/null 2>&1 & echo $! > ${shellQuote(pidPath)}; disown; exit 0`,
  ], {
    memoryMax: "1G",
    memorySwapMax: "0",
    oomGroup: false,
    cleanupTimeoutSec: 1,
  }, { unitName });
  const result = await spawnResult(wrapped.command, wrapped.args);
  assert.equal(result.code, 0, result.stderr);
  const descendantPid = Number.parseInt(await fsp.readFile(pidPath, "utf8"), 10);
  assert.equal(processExists(descendantPid), true, "probe descendant exited before cleanup");

  assert.deepEqual(await stopSystemdScope(unitName), { status: "stopped" });
  await waitFor(() => !processExists(descendantPid), 5_000);
});

test("Ralph reaps a detached provider descendant before completing the turn", {
  skip: !hasUserSystemd,
  timeout: 30_000,
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ralph-turn-scope-test-"));
  const workdir = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const stateBaseDir = path.join(root, "state");
  const passMarker = path.join(root, "checks-pass");
  const descendantPidPath = path.join(root, "descendant.pid");
  const checkPath = path.join(root, "check.sh");
  const fakeCodexPath = path.join(root, "fake-codex.js");
  const configPath = path.join(root, "ralph.config.json");
  t.after(async () => {
    if (fs.existsSync(descendantPidPath)) {
      const pid = Number.parseInt(await fsp.readFile(descendantPidPath, "utf8"), 10);
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

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
    fakeCodexPath,
    `#!/usr/bin/env node\n` +
      `import fs from "node:fs";\n` +
      `import { spawn } from "node:child_process";\n` +
      `await new Promise((resolve) => {\n` +
      `  process.stdin.resume();\n` +
      `  process.stdin.on("end", resolve);\n` +
      `});\n` +
      `const descendant = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });\n` +
      `descendant.unref();\n` +
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));\n` +
      `fs.writeFileSync(${JSON.stringify(passMarker)}, "yes\\n");\n` +
      `const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");\n` +
      `emit({ type: "thread.started", thread_id: "scope-test-thread" });\n` +
      `emit({ type: "turn.started", thread_id: "scope-test-thread" });\n` +
      `emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });\n`,
    { mode: 0o755 },
  );
  await fsp.writeFile(configPath, `${JSON.stringify({
    provider: "codex",
    name: "turn-scope-test",
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
    resourceLimits: {
      enabled: true,
      memoryMax: "1G",
      memorySwapMax: "0",
      cleanupTimeoutSec: 1,
    },
    sessionIsolation: false,
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "ralph.js")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RALPH_CONFIG: configPath,
      RALPH_SESSION_ISOLATION: "0",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(
    result.status,
    0,
    `Ralph failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const descendantPid = Number.parseInt(await fsp.readFile(descendantPidPath, "utf8"), 10);
  assert.equal(processExists(descendantPid), false, "provider descendant outlived the Ralph turn");
});

function fakeSpawn(calls, result) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", result.code ?? 0, result.signal ?? null);
    });
    return child;
  };
}

function spawnResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function commandOnPath(name) {
  return String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => fs.existsSync(path.join(directory, name)));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
