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
          statePath: path.join(RALPH_DIR, dir.name, "state.json"),
        });
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const withStats = await Promise.all(results.map(async (entry) => {
    const eventStat = await fs.stat(entry.filePath);
    let stateStat = null;
    try {
      stateStat = await fs.stat(entry.statePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const latestMtimeMs = Math.max(eventStat.mtimeMs, stateStat?.mtimeMs ?? 0);
    return {
      id: entry.id,
      label: entry.label,
      filePath: entry.filePath,
      size: eventStat.size,
      mtime: new Date(latestMtimeMs).toISOString(),
      eventMtime: eventStat.mtime.toISOString(),
    };
  }));
  return withStats.sort((a, b) => {
    const byMtime = Date.parse(b.mtime) - Date.parse(a.mtime);
    return byMtime || a.label.localeCompare(b.label);
  });
}

function safeRunRef(id) {
  // id is "dirName/fileBase" — validate both parts
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  if (!parts.every(p => /^[a-zA-Z0-9._-]+$/.test(p))) return null;
  return {
    shape: parts[0],
    threadId: parts[1],
    filePath: path.join(RALPH_DIR, parts[0], "events", `${parts[1]}.jsonl`),
  };
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

async function readShapeUsage(shape, selected = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(shape ?? "")) {
    return null;
  }

  const eventsDir = path.join(RALPH_DIR, shape, "events");
  let files;
  try {
    files = await fs.readdir(eventsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const jsonls = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  const runs = [];
  const seenThreads = new Set();
  let total = emptyUsage();

  for (const fileName of jsonls) {
    const filePath = path.join(eventsDir, fileName);
    const fileBase = path.basename(fileName, ".jsonl");
    const isSelected = selected.filePath === filePath && Array.isArray(selected.events);
    let events = [];
    if (isSelected) {
      events = selected.events;
    } else {
      try {
        events = await readRunFile(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    const threadId = inferThreadIdFromRun(filePath, events);
    const threadAlreadyCounted = threadId ? seenThreads.has(threadId) : false;
    let usage = null;
    if (threadId && !threadAlreadyCounted) {
      seenThreads.add(threadId);
      usage = isSelected ? usageFromVizEvents(events) : null;
      if (!hasTokenUsage(usage)) {
        usage = await readCodexThreadUsage(threadId);
      }
    }
    if (!threadAlreadyCounted && !hasTokenUsage(usage)) {
      usage = usageFromVizEvents(events);
    }

    if (hasTokenUsage(usage)) {
      total = addUsage(total, usage);
    }

    const stat = await fs.stat(filePath);
    runs.push({
      id: `${shape}/${fileBase}`,
      threadId: threadId ?? fileBase,
      mtime: stat.mtime.toISOString(),
      usage: hasTokenUsage(usage) ? usage : null,
    });
  }

  return {
    shape,
    runCount: runs.length,
    threadCount: seenThreads.size,
    usage: hasTokenUsage(total) ? total : null,
    runs,
  };
}

async function readCodexThreadUsage(threadId) {
  const files = await findCodexSessionFiles(threadId);
  let total = emptyUsage();
  let previous = null;

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
      const usage = record?.type === "event_msg" && record.payload?.type === "token_count"
        ? normalizeUsage(record.payload.info?.total_token_usage)
        : null;
      if (!hasTokenUsage(usage)) {
        continue;
      }
      total = addUsage(total, usageDelta(usage, previous));
      previous = usage;
    }
  }

  return hasTokenUsage(total) ? total : null;
}

function usageFromVizEvents(events) {
  const tokenRecords = events
    .filter((event) => event.eventType === "codex.session.token_count" && event.event?.usage)
    .sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
  if (tokenRecords.length) {
    let total = emptyUsage();
    let previous = null;
    for (const record of tokenRecords) {
      const usage = normalizeUsage(record.event.usage);
      if (!hasTokenUsage(usage)) {
        continue;
      }
      total = addUsage(total, usageDelta(usage, previous));
      previous = usage;
    }
    return hasTokenUsage(total) ? total : null;
  }

  let total = emptyUsage();
  for (const event of events) {
    if (event.eventType === "turn.completed" && event.event?.usage) {
      total = addUsage(total, event.event.usage);
    }
    if (event.eventType === "finished" && event.event?.value?.usageMetadata) {
      total = addUsage(total, event.event.value.usageMetadata);
    }
  }
  return hasTokenUsage(total) ? total : null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = usage.input_tokens ?? usage.promptTokenCount ?? 0;
  const cached = usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? 0;
  const output =
    usage.output_tokens ??
    ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0));
  const reasoning =
    usage.reasoning_output_tokens ??
    usage.thinking_output_tokens ??
    usage.thoughtsTokenCount ??
    0;
  const totalTokens = usage.total_tokens ?? usage.totalTokenCount ?? input + output;
  return {
    input_tokens: Math.max(0, input),
    cached_input_tokens: Math.max(0, cached),
    output_tokens: Math.max(0, output),
    reasoning_output_tokens: Math.max(0, reasoning),
    total_tokens: Math.max(0, totalTokens),
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function hasTokenUsage(usage) {
  return Boolean(
    usage &&
      (usage.input_tokens ||
        usage.cached_input_tokens ||
        usage.output_tokens ||
        usage.reasoning_output_tokens ||
        usage.total_tokens),
  );
}

function addUsage(left, right) {
  const a = normalizeUsage(left) ?? emptyUsage();
  const b = normalizeUsage(right) ?? emptyUsage();
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

function subtractUsage(current, previous) {
  const a = normalizeUsage(current) ?? emptyUsage();
  const b = normalizeUsage(previous) ?? emptyUsage();
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    cached_input_tokens: Math.max(0, a.cached_input_tokens - b.cached_input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    reasoning_output_tokens: Math.max(0, a.reasoning_output_tokens - b.reasoning_output_tokens),
    total_tokens: Math.max(0, a.total_tokens - b.total_tokens),
  };
}

function usageDelta(current, previous) {
  if (!previous || usageCounterReset(current, previous)) {
    return normalizeUsage(current);
  }
  return subtractUsage(current, previous);
}

function usageCounterReset(current, previous) {
  const a = normalizeUsage(current);
  const b = normalizeUsage(previous);
  if (!a || !b) {
    return false;
  }
  return (
    a.total_tokens < b.total_tokens ||
    a.input_tokens < b.input_tokens ||
    a.output_tokens < b.output_tokens ||
    a.cached_input_tokens < b.cached_input_tokens ||
    a.reasoning_output_tokens < b.reasoning_output_tokens
  );
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

  const firstFailureLine = findFirstFailureLine(output) ?? null;
  const failingStage =
    inferFailureStage(firstFailureLine, stageSections) ??
    existingStatus.failingStage ??
    null;
  const failingIndex = failingStage ? stageNames.indexOf(failingStage) : -1;
  const allTestsPassed =
    summary.allTestsPassed ||
    (existingStatus.exitCode === 0 && summary.testsPassed === summary.testsTotal);
  const canInferPassingThrough = isContiguousStagePrefix(stageNames);
  const stagesPassed = allTestsPassed
    ? stageNames.length
    : failingIndex > 0
      ? failingIndex
      : 0;
  const passingThrough = canInferPassingThrough && allTestsPassed
    ? stageNames.at(-1) ?? existingStatus.targetStage ?? null
    : canInferPassingThrough && failingIndex > 0
      ? stageNames[failingIndex - 1]
      : null;
  const stages = stageSections.map((stage, index) => {
    const failureLines = extractStageFailureLines(stage.body);
    const failed = failureLines.length;
    return {
      name: stage.name,
      status: allTestsPassed ? "pass" : failed > 0 ? "fail" : index < failingIndex ? "pass" : "unknown",
      passed: 0,
      total: 0,
      failed,
      timeouts: failureLines.filter((line) => classifyFailureLine(line) === "timeout").length,
      timeoutExpectations: failureLines.filter((line) => classifyFailureLine(line) === "timeout_expected").length,
      targets: [],
    };
  });
  const timeoutFailures = stages.length
    ? stages.reduce((sum, stage) => sum + (stage.timeouts ?? 0), 0)
    : (existingStatus.timeoutFailures ?? 0);
  const timeoutExpectationFailures = stages.length
    ? stages.reduce((sum, stage) => sum + (stage.timeoutExpectations ?? 0), 0)
    : (existingStatus.timeoutExpectationFailures ?? 0);

  return {
    allTestsPassed,
    testsPassed: summary.testsPassed,
    testsTotal: summary.testsTotal,
    stageCount: stageNames.length || existingStatus.stageCount || 0,
    stagesPassed,
    failingStage: allTestsPassed ? null : failingStage,
    passingThrough,
    firstFailureLine: firstFailureLine ?? existingStatus.firstFailureLine ?? null,
    firstFailureKind: classifyFailureLine(firstFailureLine ?? existingStatus.firstFailureLine),
    timeoutFailures,
    timeoutExpectationFailures,
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
  return extractStageFailureLines(body).length;
}

function extractStageFailureLines(body) {
  return body.split(/\r?\n/).filter(isTestFailureLine);
}

function findFirstFailureLine(output) {
  return output.split(/\r?\n/).find(isFailureLine);
}

function isFailureLine(line) {
  return /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|expected EXIT_|got EXIT_|got 124|does not match|timed out|did not time out as expected|exit status mismatch/i.test(line);
}

function isTestFailureLine(line) {
  return /^(?:(?:pa\d+\/|pa\d+\/\.\.\/).+|(?:tests|course|cppgm\.tests)\/.+): /.test(line) &&
    isFailureLine(line);
}

function inferFailureStage(line, stageSections) {
  const explicit = line?.match(/^(pa\d+)\//)?.[1];
  if (explicit) {
    return explicit;
  }
  if (!line) {
    return null;
  }
  return stageSections.find((stage) => stage.body.includes(line))?.name ?? null;
}

function classifyFailureLine(line) {
  const text = String(line ?? "");
  if (!text) {
    return null;
  }
  if (
    /\bdid not time out as expected\b/i.test(text) ||
    (/\bexpected\s+(?:EXIT_TIMEOUT(?:\s*\(124\))?|124)\b/i.test(text) &&
      !/\bgot\s+(?:EXIT_TIMEOUT(?:\s*\(124\))?|124)\b/i.test(text))
  ) {
    return "timeout_expected";
  }
  if (/\btimed out\b/i.test(text) || /\bgot\s+(?:EXIT_TIMEOUT(?:\s*\(124\))?|124)\b/i.test(text)) {
    return "timeout";
  }
  return null;
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

function isContiguousStagePrefix(stageNames) {
  if (!Array.isArray(stageNames) || stageNames.length === 0) {
    return false;
  }
  return stageNames.every((stageName, index) => stageNumber(stageName) === index + 1);
}

function stageNumber(stageName) {
  const match = String(stageName ?? "").match(/^pa(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
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
  const context = {
    threadId,
    resolveTurnNumber,
    commandsByCallId: new Map(),
    functionCallsByCallId: new Map(),
    commandsBySessionId: new Map(),
  };
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
    functionCallsByCallId: context.functionCallsByCallId,
    commandsBySessionId: context.commandsBySessionId,
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
  if (payload.type === "patch_apply_end" && payload.changes) {
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: payload.call_id ?? `patch-${context.recordedAt}`,
        type: "file_change",
        status: payload.status ?? (payload.success ? "completed" : "failed"),
        changes: Object.entries(payload.changes).map(([filePath, change]) => ({
          kind: change?.type ?? "update",
          path: filePath,
          diff: change?.unified_diff ?? "",
          movePath: change?.move_path ?? null,
        })),
        raw: payload,
      },
    });
  }
  return null;
}

function convertCodexResponseItem(payload, context) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.type === "function_call") {
    const args = parseFunctionCallArgs(payload);
    const command = formatFunctionCall(payload, args, context);
    if (payload.call_id) {
      context.commandsByCallId?.set(payload.call_id, command);
      context.functionCallsByCallId?.set(payload.call_id, {
        name: payload.name,
        args,
        command,
      });
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
    const call = context.functionCallsByCallId?.get(payload.call_id) ?? null;
    if (call?.name === "exec_command") {
      const sessionId = parseRunningSessionId(payload.output);
      if (sessionId && call.command) {
        context.commandsBySessionId?.set(sessionId, call.command);
      }
    }
    const command =
      call?.name === "write_stdin"
        ? formatWriteStdinCommand(call.args, context)
        : context.commandsByCallId?.get(payload.call_id) ?? "";
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: payload.call_id,
        type: "command_execution",
        status: "completed",
        exit_code: parseFunctionOutputExitCode(payload.output),
        command,
        session_id: call?.args?.session_id ?? null,
        stdin: call?.name === "write_stdin" ? call.args?.chars ?? "" : null,
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

function parseFunctionCallArgs(payload) {
  try {
    return payload.arguments ? JSON.parse(payload.arguments) : {};
  } catch (_) {
    return null;
  }
}

function formatFunctionCall(payload, args, context) {
  if (!args || typeof args !== "object") {
    return `${payload.name} ${payload.arguments ?? ""}`.trim();
  }

  if (payload.name === "exec_command" && args.cmd) {
    return args.cmd;
  }
  if (payload.name === "write_stdin") {
    return formatWriteStdinCommand(args, context);
  }
  if (payload.name === "apply_patch") {
    return "apply_patch";
  }
  return `${payload.name} ${JSON.stringify(args)}`;
}

function formatWriteStdinCommand(args, context) {
  const sessionId = normalizeSessionId(args?.session_id);
  const originalCommand = sessionId ? context.commandsBySessionId?.get(sessionId) : null;
  const stdin = typeof args?.chars === "string" ? args.chars : "";
  const suffix = sessionId ? `session ${sessionId}` : "unknown session";
  const base = originalCommand
    ? `${originalCommand} (continued ${suffix})`
    : `write_stdin ${suffix}`;
  if (!stdin) {
    return base;
  }
  return `${base} stdin=${JSON.stringify(truncateMiddle(stdin, 160))}`;
}

function parseRunningSessionId(output) {
  const match = String(output ?? "").match(/Process running with session ID (\d+)/);
  return match ? match[1] : null;
}

function normalizeSessionId(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function truncateMiddle(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
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
  const candidates = [];
  try {
    const dirs = await fs.readdir(RALPH_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const statePath = path.join(RALPH_DIR, dir.name, "state.json");
      try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.threadId === "string") {
          const stat = await fs.stat(statePath);
          candidates.push({
            id: `${dir.name}/${parsed.threadId}`,
            mtimeMs: stat.mtimeMs,
          });
        }
      } catch (_) { /* no state file, skip */ }
    }
  } catch (_) {}
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
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
    const runs = fileEntries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      size: entry.size,
      mtime: entry.mtime,
      eventMtime: entry.eventMtime,
    }));
    return sendJson(res, { runs });
  }

  if (pathname.startsWith("/api/run/")) {
    const rawId = decodeURIComponent(pathname.slice("/api/run/".length));
    const runRef = safeRunRef(rawId);
    if (!runRef) {
      return sendJson(res, { error: "Invalid run id" }, 400);
    }
    let events = [];
    let shapeUsage = null;
    try {
      events = await readRunWithCodexSession(runRef.filePath);
      shapeUsage = await readShapeUsage(runRef.shape, {
        filePath: runRef.filePath,
        events,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      throw error;
    }
    if (!events.length) {
      return sendJson(res, { error: "Run not found" }, 404);
    }
    return sendJson(res, { events, shapeUsage });
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
