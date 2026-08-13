import { spawn } from "node:child_process";
import process from "node:process";
import { randomUUID } from "node:crypto";

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export function buildSystemdScopeSpawn(command, args, config, options = {}) {
  const unitName = options.unitName ?? buildSystemdScopeUnitName();
  const cleanupTimeoutSec = positiveNumber(config?.cleanupTimeoutSec, 2);
  const props = [
    `MemoryMax=${config.memoryMax}`,
    `MemorySwapMax=${config.memorySwapMax}`,
    `OOMPolicy=${config.oomGroup ? "stop" : "continue"}`,
    "KillMode=control-group",
    "SendSIGKILL=yes",
    `TimeoutStopSec=${cleanupTimeoutSec}s`,
  ];
  const scopeArgs = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--unit",
    unitName,
  ];
  for (const prop of props) {
    scopeArgs.push("--property", prop);
  }
  scopeArgs.push("--", command, ...args);
  return { command: "systemd-run", args: scopeArgs, unitName };
}

export function buildSystemdScopeUnitName(options = {}) {
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const id = String(options.id ?? randomUUID()).replace(/[^A-Za-z0-9]/g, "");
  return `ralph-turn-${pid}-${id}.scope`;
}

export function stopSystemdScope(unitName, options = {}) {
  if (!unitName) {
    return Promise.resolve({ status: "absent" });
  }
  const systemctlPath = options.systemctlPath ?? "systemctl";
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  const spawnProcess = options.spawnProcess ?? spawn;

  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      systemctlPath,
      ["--user", "stop", "--no-ask-password", unitName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      if (code === 0 && !signal) {
        finish(() => resolve({ status: "stopped" }));
        return;
      }
      if (systemdUnitIsAbsent(output)) {
        finish(() => resolve({ status: "absent" }));
        return;
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      finish(() => reject(new Error(
        `Failed to stop resource scope ${unitName} (${detail})${output ? `: ${output}` : ""}`,
      )));
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      finish(() => reject(new Error(
        `Timed out after ${timeoutMs}ms stopping resource scope ${unitName}`,
      )));
    }, timeoutMs);
    timer.unref?.();
  });
}

function systemdUnitIsAbsent(output) {
  return /\bunit\b.*\b(?:not loaded|not found|could not be found|does not exist)\b/i.test(
    String(output ?? ""),
  );
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
