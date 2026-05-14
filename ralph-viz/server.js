#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";

const ROOT_DIR = process.cwd();
const RALPH_DIR = path.join(ROOT_DIR, ".ralph");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const PORT = Number.parseInt(process.env.RALPH_VIZ_PORT ?? "4173", 10);
const HOST = process.env.RALPH_VIZ_HOST ?? "0.0.0.0";
const SPA_DIR = path.dirname(fileURLToPath(import.meta.url));

// Scan .ralph/*/events/*.jsonl
async function listFiles() {
  const results = [];
  try {
    const dirs = await fs.readdir(RALPH_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const eventsDir = path.join(RALPH_DIR, dir.name, "events");
      let files;
      try {
        files = await fs.readdir(eventsDir, { withFileTypes: true });
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        throw e;
      }
      const jsonls = files.filter(f => f.isFile() && f.name.endsWith(".jsonl"));
      for (const f of jsonls) {
        const fileBase = path.basename(f.name, ".jsonl");
        // id encodes both dir name and file for lookup
        const id = `${dir.name}/${fileBase}`;
        // display label: just (name) if single jsonl, else (name uuid4)
        const label = jsonls.length === 1
          ? dir.name
          : `${dir.name} ${fileBase.slice(0, 4)}`;
        results.push({
          id,
          label,
          filePath: path.join(eventsDir, f.name),
        });
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

function safeRunId(id) {
  // id is "dirName/fileBase" — validate both parts
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  if (!parts.every(p => /^[a-zA-Z0-9._-]+$/.test(p))) return null;
  return path.join(RALPH_DIR, parts[0], "events", `${parts[1]}.jsonl`);
}

async function readRunFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed);
      }
    } catch (error) {
      // keep parser resilient to one-off bad lines in a stream log
    }
  }
  return events;
}

async function readRunWithCodexSession(filePath) {
  const events = await readRunFile(filePath);
  await augmentLatestTestStatusFromLog(events, filePath);
  const threadId = inferThreadIdFromRun(filePath, events);
  if (!threadId) {
    return events;
  }

  const sessionEvents = await readCodexSessionEvents(threadId, buildSessionTurnResolver(events));
  if (!sessionEvents.length) {
    return events;
  }

  return mergeEventStreams(events, sessionEvents);
}

async function augmentLatestTestStatusFromLog(events, filePath) {
  const statusRecord = [...events]
    .reverse()
    .find((event) => event.eventType === "ralph.test-status" && event.event?.testStatus);
  if (!statusRecord) {
    return;
  }

  const stateDir = path.dirname(path.dirname(filePath));
  const logPath = path.join(stateDir, "last-test.log");
  let output;
  try {
    output = await fs.readFile(logPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const derived = deriveTestStatusFromReportOutput(output, statusRecord.event.testStatus);
  if (!derived) {
    return;
  }
  statusRecord.event.testStatus = {
    ...statusRecord.event.testStatus,
    ...derived,
  };
}

function deriveTestStatusFromReportOutput(output, existingStatus = {}) {
  const summary = parseTestReportSummary(output);
  if (!summary) {
    return null;
  }

  const stageSections = parseStageSections(output);
  const stageNames = stageSections.map((stage) => stage.name);
  if (
    existingStatus.targetStage &&
    stageNames.length > 0 &&
    !stageNames.includes(existingStatus.targetStage)
  ) {
    return null;
  }

  const firstFailureLine = output
    .split(/\r?\n/)
    .find((line) => /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match/.test(line)) ?? null;
  const failingStage =
    firstFailureLine?.match(/^(pa\d+)\//)?.[1] ??
    existingStatus.failingStage ??
    null;
  const failingIndex = failingStage ? stageNames.indexOf(failingStage) : -1;
  const allTestsPassed =
    summary.allTestsPassed ||
    (existingStatus.exitCode === 0 && summary.testsPassed === summary.testsTotal);
  const stagesPassed = allTestsPassed
    ? stageNames.length
    : failingIndex > 0
      ? failingIndex
      : 0;
  const passingThrough = allTestsPassed
    ? stageNames.at(-1) ?? existingStatus.targetStage ?? null
    : failingIndex > 0
      ? stageNames[failingIndex - 1]
      : null;
  const stages = stageSections.map((stage, index) => {
    const failed = countStageFailureLines(stage.body);
    return {
      name: stage.name,
      status: allTestsPassed ? "pass" : failed > 0 ? "fail" : index < failingIndex ? "pass" : "unknown",
      passed: 0,
      total: 0,
      failed,
      targets: [],
    };
  });

  return {
    allTestsPassed,
    testsPassed: summary.testsPassed,
    testsTotal: summary.testsTotal,
    stageCount: stageNames.length || existingStatus.stageCount || 0,
    stagesPassed,
    failingStage: allTestsPassed ? null : failingStage,
    passingThrough,
    firstFailureLine: firstFailureLine ?? existingStatus.firstFailureLine ?? null,
    stages: stages.length ? stages : existingStatus.stages,
  };
}

function parseStageSections(output) {
  const headers = [...output.matchAll(/^===== (pa\d+) =====$/gm)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  return headers.map((header, index) => ({
    name: header.name,
    body: output.slice(header.index, index + 1 < headers.length ? headers[index + 1].index : output.length),
  }));
}

function countStageFailureLines(body) {
  return body
    .split(/\r?\n/)
    .filter((line) =>
      /^(?:pa\d+\/|pa\d+\/\.\.\/).+?: (?:ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match)/.test(line),
    ).length;
}

function parseTestReportSummary(output) {
  const allPassed = output.match(
    /^===== ALL TESTS PASSED SUCCESSFULLY!(?: \((\d+)\s*\/\s*(\d+)\))? =====$/m,
  );
  if (allPassed) {
    const testsPassed = parseOptionalInt(allPassed[1]);
    const testsTotal = parseOptionalInt(allPassed[2]);
    return {
      allTestsPassed: true,
      testsPassed: testsPassed ?? testsTotal ?? 0,
      testsTotal: testsTotal ?? testsPassed ?? 0,
    };
  }

  const summary = output.match(/^===== TEST SUMMARY: (\d+)\s*\/\s*(\d+) TESTS PASSED =====$/m);
  if (!summary) {
    return null;
  }
  return {
    allTestsPassed: false,
    testsPassed: Number.parseInt(summary[1], 10),
    testsTotal: Number.parseInt(summary[2], 10),
  };
}

function parseOptionalInt(value) {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferThreadIdFromRun(filePath, events) {
  const eventThreadId = events.find((event) => typeof event.threadId === "string")?.threadId;
  if (eventThreadId) {
    return eventThreadId;
  }
  const basename = path.basename(filePath, ".jsonl");
  return /^[a-zA-Z0-9._-]+$/.test(basename) ? basename : null;
}

function mergeEventStreams(primary, secondary) {
  const seen = new Set(primary.map(eventKey));
  const merged = [...primary];
  for (const event of secondary) {
    const key = eventKey(event);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
}

function eventKey(record) {
  const event = record.event ?? {};
  const item = event.item ?? {};
  return [
    record.recordedAt ?? "",
    record.threadId ?? "",
    record.turnNumber ?? "",
    record.eventType ?? "",
    event.type ?? "",
    item.id ?? "",
    item.type ?? "",
  ].join("|");
}

function buildSessionTurnResolver(events) {
  const turnStarts = events
    .filter((event) => event.eventType === "ralph.prompt" && Number.isInteger(event.turnNumber))
    .map((event) => ({
      time: Date.parse(event.recordedAt ?? ""),
      turnNumber: event.turnNumber,
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return (recordedAt) => {
    const time = Date.parse(recordedAt ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }

    let turnNumber = null;
    for (const entry of turnStarts) {
      if (entry.time > time) {
        break;
      }
      turnNumber = entry.turnNumber;
    }
    return turnNumber;
  };
}

async function readCodexSessionEvents(threadId, resolveTurnNumber) {
  const files = await findCodexSessionFiles(threadId);
  const events = [];
  const context = { threadId, resolveTurnNumber, commandsByCallId: new Map() };
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const converted = convertCodexSessionRecord(record, context);
      if (converted) {
        events.push(converted);
      }
    }
  }
  return events;
}

async function findCodexSessionFiles(threadId) {
  const sessionsDir = path.join(CODEX_DIR, "sessions");
  const matches = [];
  await walkSessions(sessionsDir, matches, threadId, 0);
  return matches.sort();
}

async function walkSessions(directory, matches, threadId, depth) {
  if (depth > 5) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkSessions(entryPath, matches, threadId, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
      matches.push(entryPath);
    }
  }
}

function convertCodexSessionRecord(record, context) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const recordContext = {
    recordedAt: record.timestamp ?? new Date().toISOString(),
    threadId: context.threadId,
    turnNumber: context.resolveTurnNumber(record.timestamp),
    commandsByCallId: context.commandsByCallId,
  };

  if (record.type === "event_msg") {
    return convertCodexEventMessage(record.payload, recordContext);
  }
  if (record.type === "response_item") {
    return convertCodexResponseItem(record.payload, recordContext);
  }
  return null;
}

function convertCodexEventMessage(payload, context) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  // The same assistant text is also present as a response_item message, which
  // carries the shape the viewer already understands.
  if (payload.type === "token_count" && payload.info?.total_token_usage) {
    return buildVizRecord(context, "codex.session.token_count", {
      type: "codex.session.token_count",
      usage: payload.info.total_token_usage,
      raw: payload,
    });
  }
  return null;
}

function convertCodexResponseItem(payload, context) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.type === "function_call") {
    const command = formatFunctionCall(payload);
    if (payload.call_id) {
      context.commandsByCallId?.set(payload.call_id, command);
    }
    return buildVizRecord(context, "item.started", {
      type: "item.started",
      item: {
        id: payload.call_id,
        type: "command_execution",
        status: "running",
        command,
        raw: payload,
      },
    });
  }
  if (payload.type === "function_call_output") {
    const command = context.commandsByCallId?.get(payload.call_id) ?? "";
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: payload.call_id,
        type: "command_execution",
        status: "completed",
        exit_code: parseFunctionOutputExitCode(payload.output),
        command,
        aggregated_output: payload.output ?? "",
        raw: payload,
      },
    });
  }
  if (payload.type === "message" && payload.role === "assistant") {
    const text = extractAssistantMessageText(payload);
    if (!text) {
      return null;
    }
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: `message-${context.recordedAt}`,
        type: "agent_message",
        text,
      },
    });
  }
  if (payload.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.map((item) => item.text ?? "").filter(Boolean).join("\n")
      : "";
    if (!summary) {
      return null;
    }
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: `reasoning-${context.recordedAt}`,
        type: "reasoning",
        text: summary,
      },
    });
  }
  return null;
}

function buildVizRecord(context, eventType, event) {
  return {
    recordedAt: context.recordedAt,
    threadId: context.threadId,
    turnNumber: context.turnNumber,
    eventType,
    event,
  };
}

function formatFunctionCall(payload) {
  let args = {};
  try {
    args = payload.arguments ? JSON.parse(payload.arguments) : {};
  } catch (_) {
    return `${payload.name} ${payload.arguments ?? ""}`.trim();
  }

  if (payload.name === "exec_command" && args.cmd) {
    return args.cmd;
  }
  if (payload.name === "write_stdin") {
    return `write_stdin session=${args.session_id ?? "unknown"}`;
  }
  if (payload.name === "apply_patch") {
    return "apply_patch";
  }
  return `${payload.name} ${JSON.stringify(args)}`;
}

function parseFunctionOutputExitCode(output) {
  const match = String(output ?? "").match(/Process exited with code (-?\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function extractAssistantMessageText(payload) {
  const parts = Array.isArray(payload.content) ? payload.content : [];
  return parts
    .map((part) => part?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function buildSummary(events) {
  const byTurn = new Map();
  const eventTypes = new Map();
  let firstAt = null;
  let lastAt = null;
  for (const event of events) {
    const turn = displayTurnForRecord(event);
    if (Number.isInteger(turn)) {
      byTurn.set(turn, (byTurn.get(turn) ?? 0) + 1);
    }
    eventTypes.set(event.eventType, (eventTypes.get(event.eventType) ?? 0) + 1);
    const recordedAt = event.recordedAt ?? null;
    if (recordedAt && (!firstAt || recordedAt < firstAt)) {
      firstAt = recordedAt;
    }
    if (recordedAt && (!lastAt || recordedAt > lastAt)) {
      lastAt = recordedAt;
    }
  }

  return {
    eventCount: events.length,
    turnCount: byTurn.size,
    maxTurn: byTurn.size > 0 ? Math.max(...Array.from(byTurn.keys())) : null,
    eventTypes: Array.from(eventTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count })),
    firstAt,
    lastAt,
    threadId: events.length > 0 ? events[0].threadId : null,
  };
}

function displayTurnForRecord(record) {
  if (Number.isInteger(record.turnNumber) && record.turnNumber > 0) {
    return record.turnNumber;
  }
  return "setup";
}

async function currentRunId() {
  // Look for state.json in any .ralph/*/state.json and return the matching run id
  try {
    const dirs = await fs.readdir(RALPH_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const statePath = path.join(RALPH_DIR, dir.name, "state.json");
      try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.threadId === "string") {
          return `${dir.name}/${parsed.threadId}`;
        }
      } catch (_) { /* no state file, skip */ }
    }
  } catch (_) {}
  return null;
}

async function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendStaticFile(res, filePath, contentType, fallback = "Not found") {
  return fs
    .readFile(filePath, "utf8")
    .then((content) => {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(fallback);
    });
}

async function requestHandler(req, res) {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/") {
    return sendStaticFile(res, path.join(SPA_DIR, "index.html"), "text/html; charset=utf-8");
  }

  if (pathname === "/app.js") {
    return sendStaticFile(res, path.join(SPA_DIR, "app.js"), "application/javascript; charset=utf-8");
  }

  if (pathname === "/styles.css") {
    return sendStaticFile(res, path.join(SPA_DIR, "styles.css"), "text/css; charset=utf-8");
  }

  if (pathname === "/api/state") {
    const currentThread = await currentRunId();
    return sendJson(res, { currentThread });
  }

  if (pathname === "/api/runs") {
    const fileEntries = await listFiles();
    const runs = [];
    for (const entry of fileEntries) {
      const events = await readRunWithCodexSession(entry.filePath);
      const summary = buildSummary(events);
      const stat = await fs.stat(entry.filePath);
      runs.push({
        id: entry.id,
        label: entry.label,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        events: events.length,
        summary,
      });
    }
    return sendJson(res, { runs });
  }

  if (pathname.startsWith("/api/run/")) {
    const rawId = decodeURIComponent(pathname.slice("/api/run/".length));
    const filePath = safeRunId(rawId);
    if (!filePath) {
      return sendJson(res, { error: "Invalid run id" }, 400);
    }
    let events = [];
    try {
      events = await readRunWithCodexSession(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      throw error;
    }
    if (!events.length) {
      return sendJson(res, { error: "Run not found" }, 404);
    }
    return sendJson(res, { events });
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    await requestHandler(req, res);
  } catch (error) {
    const body = JSON.stringify({ error: error?.message ?? "Server failure" });
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  const runsPath = path.relative(ROOT_DIR, RALPH_DIR);
  console.log(`[ralph-viz] serving from ${runsPath}/*/events`);
  console.log(`[ralph-viz] open http://${HOST}:${PORT}`);
});
