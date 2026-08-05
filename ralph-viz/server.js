#!/usr/bin/env node

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";
import readline from "node:readline";
import { createHash } from "node:crypto";
import {
  collectClaudeSubagentEvents,
  DEFAULT_CLAUDE_PROJECTS_DIR,
} from "../claude-subagent-events.js";

const ROOT_DIR = process.cwd();
const RALPH_DIR = path.join(ROOT_DIR, ".ralph");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? DEFAULT_CLAUDE_PROJECTS_DIR;
const PORT = Number.parseInt(process.env.RALPH_VIZ_PORT ?? "4173", 10);
const HOST = process.env.RALPH_VIZ_HOST ?? "0.0.0.0";
const SPA_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_EVENT_GAP_MS = 10 * 60 * 1000;
const ACTIVE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCROLL_DEBUG_LOG_PATH = path.join(RALPH_DIR, "viz-scroll-debug.jsonl");
const DEFAULT_CODEX_TAIL_TURNS = 2;
const DEFAULT_CODEX_MAX_EVENTS_PER_TURN = 800;
const CODEX_SESSION_OUTPUT_LIMIT = 12_000;
const CODEX_FAST_USAGE_TAIL_BYTES = 16 * 1024 * 1024;
const CODEX_TAIL_SESSION_CHUNK_BYTES = 1024 * 1024;
const CODEX_TAIL_SESSION_MAX_BYTES = 24 * 1024 * 1024;
const CODEX_SESSION_PROGRESS_OVERLAP_BYTES = 1024 * 1024;
const CODEX_SESSION_INDEX_TTL_MS = 2_000;
const RUN_RESPONSE_TURN_MAX_BYTES = 8 * 1024 * 1024;
const RUN_USAGE_REFRESH_INTERVAL_MS = 15 * 1000;
const RUN_USAGE_CACHE_VERSION = 25;
const COMPARE_PA_COSTS_CACHE_VERSION = 2;
const RUN_USAGE_CACHE_DIR = "usage-cache";
const RUN_STRUCTURE_CACHE_VERSION = 1;
const CODEX_SESSION_WINDOW_CACHE_VERSION = 10;
const CODEX_SESSION_WINDOW_CACHE_DIR = "session-window-cache";
const CODEX_SESSION_PROGRESS_CACHE_VERSION = 10;
const CODEX_SESSION_PROGRESS_CACHE_DIR = "session-progress-cache";
const FILE_CHANGE_DIFF_MERGE_WINDOW_MS = 30 * 1000;
const RALPH_DEFAULT_MODEL = "gpt-5.3-codex";
const RALPH_DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.5-flash";
const RALPH_DEFAULT_REASONING_EFFORT = "high";
const RALPH_DEFAULT_NAME = "cppgm";
const RALPH_DEFAULT_AUTO_TEST_SUBSET_THRESHOLD = 20;
const RALPH_DEFAULT_AUTO_TEST_SUBSET_MAX_FILES = 0;
const RALPH_DEFAULT_AUTO_TEST_SUBSET_TARGET_FILES = 0;
const SLICE_METADATA_CACHE = new Map();
const CODEX_USAGE_FILE_CACHE = new Map();
const OPEN_CODEX_SESSION_CACHES = new Map();
const OPEN_CODEX_SESSION_READS = new Map();
const RUN_TAIL_FILE_CACHES = new Map();
const RUN_TAIL_FILE_READS = new Map();
const RUN_STRUCTURE_FILE_READS = new Map();
let CODEX_SESSION_INDEX_CACHE = null;
let APP_BUILD_ID_CACHE = null;
const RUN_USAGE_REFRESHES = new Map();
const OPEN_CODEX_SESSION_CACHE_LIMIT = 32;
const RUN_TAIL_FILE_CACHE_LIMIT = 16;

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
          fileBase,
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
    let state = null;
    try {
      stateStat = await fs.stat(entry.statePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const latestMtimeMs = Math.max(eventStat.mtimeMs, stateStat?.mtimeMs ?? 0);
    if (stateStat) {
      state = await readRunStateSummary(entry.statePath, entry.fileBase, latestMtimeMs);
    }
    return {
      id: entry.id,
      label: entry.label,
      filePath: entry.filePath,
      size: eventStat.size,
      mtime: new Date(latestMtimeMs).toISOString(),
      eventMtime: eventStat.mtime.toISOString(),
      state,
    };
  }));
  return withStats.sort((a, b) => {
    const byMtime = Date.parse(b.mtime) - Date.parse(a.mtime);
    return byMtime || a.label.localeCompare(b.label);
  });
}

async function readRunStateSummary(statePath, fileBase, latestMtimeMs = null) {
  const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
  const eventLogPath = typeof parsed.eventLogPath === "string" ? parsed.eventLogPath : "";
  const stateFileBase = eventLogPath.endsWith(".jsonl")
    ? path.basename(eventLogPath, ".jsonl")
    : typeof parsed.threadId === "string"
      ? parsed.threadId
      : null;
  const matchesCurrent = !stateFileBase || !fileBase || stateFileBase === fileBase;
  const activeStage = typeof parsed.activeStage === "string" ? parsed.activeStage : null;
  const activeSubset = typeof parsed.activeSubset === "string" ? parsed.activeSubset : null;
  const activePhase = typeof parsed.activePhase === "string" ? parsed.activePhase : null;
  const updatedAtMs = Date.parse(parsed.updatedAt ?? "");
  const ageBasisMs = Number.isFinite(latestMtimeMs) ? latestMtimeMs : updatedAtMs;
  const activeAgeMs = Number.isFinite(ageBasisMs) ? Math.max(0, Date.now() - ageBasisMs) : null;
  const recentlyUpdated = activeAgeMs != null && activeAgeMs <= ACTIVE_RUN_MAX_AGE_MS;
  return {
    matchesCurrent,
    active: matchesCurrent && recentlyUpdated && Boolean(activePhase),
    recentlyUpdated,
    activeAgeMs,
    turnsCompleted: Number.isInteger(parsed.turnsCompleted) ? parsed.turnsCompleted : null,
    activeStage,
    activeSubset,
    activePhase,
    phaseAttempted: parsed.phaseAttempted === true,
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
    eventLogPath: eventLogPath || null,
    lastExitCode: Number.isInteger(parsed.lastExitCode) ? parsed.lastExitCode : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
  };
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
  return readRunEventsFromOffset(filePath, 0);
}

async function readFileSlice(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (!length) {
    return "";
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readRunWithCodexSession(filePath, detailOptions = defaultCodexDetailOptions()) {
  if (detailOptions.mode === "tail") {
    const tailEvents = await readTailRunWithCodexSession(filePath, detailOptions);
    if (tailEvents) {
      return tailEvents;
    }
  }

  const events = await readRunFile(filePath);
  await augmentLatestTestStatusFromLog(events, filePath);
  // Mid-turn progress for providers without session-file scanning (Claude,
  // Antigravity): derive observations from command outputs already present in
  // the run log. Codex runs get richer observations from session files below;
  // overlapping observations are harmless to the best-progress dock logic.
  const runProgressEvents = progressEventsFromRunEvents(events);
  const withRunProgress = runProgressEvents.length
    ? mergeEventStreams(events, runProgressEvents)
    : events;
  const turnWindows = buildTurnWindows(events);
  const selectedWindows = selectTurnWindows(turnWindows, detailOptions);
  const responseBaseEvents = selectRunEventsForResponse(
    withRunProgress,
    detailOptions,
    selectedWindows,
  );
  if (detailOptions.mode === "none") {
    return responseBaseEvents;
  }

  const responseEvents = await appendClaudeSubagentEvents(responseBaseEvents);

  if (detailOptions.mode !== "all" && selectedWindows.length === 0) {
    return responseEvents;
  }

  const threadIds = inferThreadIdsForDetail(filePath, events, selectedWindows, detailOptions);
  if (threadIds.length === 0) {
    return responseEvents;
  }

  const resolveTurnNumber = buildWindowBackedSessionTurnResolver(
    selectedWindows,
    buildSessionTurnResolver(events),
  );
  const readOptions = buildSessionReadOptions(selectedWindows, detailOptions);
  readOptions.suppressedItemCardStreams = primaryItemCardStreamKeys(responseEvents);
  const sessionEventGroups = await Promise.all(
    threadIds.map((threadId) => readCodexSessionEvents(threadId, resolveTurnNumber, readOptions)),
  );
  const sessionEvents = sessionEventGroups.flat();
  const progressEvents = await readCodexSessionProgressEvents(threadIds, resolveTurnNumber, readOptions);
  if (!sessionEvents.length && !progressEvents.length) {
    return responseEvents;
  }

  return mergeEventStreams(mergeEventStreams(responseEvents, sessionEvents), progressEvents);
}

async function readTailRunWithCodexSession(filePath, detailOptions) {
  let events = await readRecentRunTailEvents(filePath, detailOptions);
  if (!events.length) {
    return null;
  }
  events = await appendClaudeSubagentEvents(events);
  await augmentLatestTestStatusFromLog(events, filePath);
  const runProgressEvents = progressEventsFromRunEvents(events);
  const withRunProgress = runProgressEvents.length
    ? mergeEventStreams(events, runProgressEvents)
    : events;
  const selectedWindows = tailTurnWindowsFromEvents(
    withRunProgress,
    detailOptions.tailTurns ?? DEFAULT_CODEX_TAIL_TURNS,
  );
  const responseBaseEvents = selectRunEventsForResponse(
    withRunProgress,
    detailOptions,
    selectedWindows,
  );

  // A resumed Codex run may already have item cards backfilled into the Ralph
  // log. Still scan the bounded session window because patch_apply_end carries
  // unified diffs that streamed file_change summaries omit.
  const suppressedItemCardStreams = primaryItemCardStreamKeys(responseBaseEvents);
  if (suppressedItemCardStreams.size === 0) {
    return appendLatestThreadUsageEvents(responseBaseEvents);
  }

  const threadIds = inferThreadIdsForDetail(filePath, events, selectedWindows, detailOptions);
  const resolveTurnNumber = buildWindowBackedSessionTurnResolver(
    selectedWindows,
    buildSessionTurnResolver(events),
  );
  const readOptions = buildSessionReadOptions(selectedWindows, detailOptions);
  readOptions.suppressedItemCardStreams = suppressedItemCardStreams;
  const sessionEventGroups = await Promise.all(
    threadIds.map((threadId) => readCodexSessionEvents(threadId, resolveTurnNumber, readOptions)),
  );
  const progressEvents = await readCodexSessionProgressEvents(threadIds, resolveTurnNumber, readOptions);
  const merged = mergeEventStreams(
    mergeEventStreams(responseBaseEvents, sessionEventGroups.flat()),
    progressEvents,
  );
  const limited = limitSessionEventsByTurn(merged, readOptions.maxEventsPerTurn);
  return appendLatestThreadUsageEvents(limited);
}

async function appendClaudeSubagentEvents(events) {
  const additions = await collectClaudeSubagentEvents(events, {
    claudeDir: CLAUDE_PROJECTS_DIR,
    resultLimit: CODEX_SESSION_OUTPUT_LIMIT,
  });
  return additions.length ? mergeEventStreams(events, additions) : events;
}

async function appendLatestThreadUsageEvents(events) {
  const additions = [];
  for (const threadId of inferThreadIdsFromRun("", events)) {
    const usage = await readCodexThreadUsageFast(threadId);
    if (!hasTokenUsage(usage)) {
      continue;
    }
    const latest = latestEventForThread(events, threadId);
    if (!latest) {
      continue;
    }
    const latestExisting = latestTokenUsageForThread(events, threadId);
    if (latestExisting && !usageDominates(usage, latestExisting)) {
      continue;
    }
    additions.push({
      recordedAt: new Date(Math.max(Date.parse(latest.recordedAt ?? "") || Date.now(), Date.now())).toISOString(),
      threadId,
      turnNumber: latest.turnNumber,
      eventType: "codex.session.token_count",
      event: {
        type: "codex.session.token_count",
        usage,
        fast: true,
      },
    });
  }
  return additions.length ? mergeEventStreams(events, additions) : events;
}

function latestEventForThread(events, threadId) {
  let latest = null;
  for (const event of events) {
    if (eventThreadId(event) !== threadId) {
      continue;
    }
    if (!latest || String(event.recordedAt ?? "") > String(latest.recordedAt ?? "")) {
      latest = event;
    }
  }
  return latest;
}

function latestTokenUsageForThread(events, threadId) {
  let latest = null;
  for (const event of events) {
    if (
      event.eventType !== "codex.session.token_count" ||
      eventThreadId(event) !== threadId ||
      !event.event?.usage
    ) {
      continue;
    }
    if (!latest || String(event.recordedAt ?? "") > String(latest.recordedAt ?? "")) {
      latest = event;
    }
  }
  return latest?.event?.usage ?? null;
}

function usageDominates(candidate, existing) {
  const current = normalizeUsage(candidate);
  const previous = normalizeUsage(existing);
  if (!current || !previous) {
    return false;
  }
  return current.total_tokens > previous.total_tokens ||
    current.input_tokens > previous.input_tokens ||
    current.output_tokens > previous.output_tokens ||
    current.cached_input_tokens > previous.cached_input_tokens ||
    current.reasoning_output_tokens > previous.reasoning_output_tokens;
}

async function readRecentRunTailEvents(filePath, detailOptions) {
  const [tailEvents, structuralEvents] = await Promise.all([
    readCachedRunTailEvents(filePath),
    readRunStructuralEvents(filePath),
  ]);
  const events = mergeEventStreams(structuralEvents, tailEvents);
  const wantedTurns = latestTurnNumbersFromEvents(
    events,
    detailOptions.tailTurns ?? DEFAULT_CODEX_TAIL_TURNS,
  );
  return events.filter((event) => wantedTurns.has(event.turnNumber));
}

async function readRunStructuralEvents(filePath) {
  const cacheKey = path.resolve(filePath);
  const pending = RUN_STRUCTURE_FILE_READS.get(cacheKey);
  if (pending) {
    return pending;
  }
  const read = refreshRunStructureCache(filePath);
  RUN_STRUCTURE_FILE_READS.set(cacheKey, read);
  try {
    return await read;
  } finally {
    if (RUN_STRUCTURE_FILE_READS.get(cacheKey) === read) {
      RUN_STRUCTURE_FILE_READS.delete(cacheKey);
    }
  }
}

async function refreshRunStructureCache(filePath) {
  const stat = await fs.stat(filePath);
  const cachePath = runStructureCachePath(filePath);
  let cache = null;
  try {
    cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      cache = null;
    }
  }

  if (
    cache?.version !== RUN_STRUCTURE_CACHE_VERSION ||
    !Number.isFinite(cache?.fileSize) ||
    cache.fileSize < 0 ||
    cache.fileSize > stat.size ||
    !Array.isArray(cache?.events)
  ) {
    cache = {
      version: RUN_STRUCTURE_CACHE_VERSION,
      fileSize: 0,
      trailingText: "",
      events: [],
    };
  }

  if (cache.fileSize < stat.size) {
    const delta = await scanRunStructuralEventDelta(
      filePath,
      cache.fileSize,
      stat.size,
      cache.trailingText,
    );
    cache.fileSize = stat.size;
    cache.trailingText = delta.trailingText;
    cache.events.push(...delta.events);
    await writeJsonAtomically(cachePath, cache);
  }
  return cache.events;
}

async function scanRunStructuralEventDelta(filePath, start, end, leadingText = "") {
  const events = [];
  let buffered = String(leadingText ?? "");
  if (end <= start) {
    return { events, trailingText: buffered };
  }
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    start: Math.max(0, start),
    end: Math.max(0, end - 1),
  });
  for await (const chunk of stream) {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (event && typeof event === "object" && isAlwaysKeptSessionEvent(event)) {
          events.push(event);
        }
      } catch (_) {
        // A partial final line is retained and completed by the next refresh.
      }
    }
  }
  return { events, trailingText: buffered };
}

function runStructureCachePath(filePath) {
  const fileBase = path.basename(filePath, ".jsonl");
  const runDir = path.dirname(path.dirname(filePath));
  return path.join(runDir, RUN_USAGE_CACHE_DIR, `${fileBase}.structure.json`);
}

async function writeJsonAtomically(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(value), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch (_) {}
    throw error;
  }
}

async function readCachedRunTailEvents(filePath) {
  const cacheKey = path.resolve(filePath);
  const pending = RUN_TAIL_FILE_READS.get(cacheKey);
  if (pending) {
    return (await pending).records.map((record) => record.event);
  }
  const read = refreshRunTailFileCache(cacheKey, filePath);
  RUN_TAIL_FILE_READS.set(cacheKey, read);
  try {
    return (await read).records.map((record) => record.event);
  } finally {
    if (RUN_TAIL_FILE_READS.get(cacheKey) === read) {
      RUN_TAIL_FILE_READS.delete(cacheKey);
    }
  }
}

async function refreshRunTailFileCache(cacheKey, filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.size) {
    return { fileSize: 0, lastUsedAt: Date.now(), records: [], trailingText: "" };
  }

  let entry = RUN_TAIL_FILE_CACHES.get(cacheKey);
  if (
    !entry ||
    stat.size < entry.fileSize ||
    stat.size - entry.fileSize > RUN_RESPONSE_TURN_MAX_BYTES
  ) {
    const bytesToRead = Math.min(stat.size, RUN_RESPONSE_TURN_MAX_BYTES);
    const start = stat.size - bytesToRead;
    const text = await readFileSlice(filePath, start, stat.size);
    const split = splitCompleteSessionLines(text, start > 0);
    entry = {
      fileSize: stat.size,
      lastUsedAt: Date.now(),
      records: parseRunTailRecords(split.lines),
      trailingText: split.trailingText,
    };
    trimRunTailFileCache(entry);
    RUN_TAIL_FILE_CACHES.set(cacheKey, entry);
    pruneRunTailFileCaches();
    return entry;
  }

  if (stat.size > entry.fileSize) {
    const appended = await readFileSlice(filePath, entry.fileSize, stat.size);
    const split = splitCompleteSessionLines(entry.trailingText + appended);
    entry.records.push(...parseRunTailRecords(split.lines));
    entry.fileSize = stat.size;
    entry.trailingText = split.trailingText;
    trimRunTailFileCache(entry);
  }
  entry.lastUsedAt = Date.now();
  return entry;
}

function parseRunTailRecords(lines) {
  const records = [];
  for (const line of lines ?? []) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push({
        bytes: Buffer.byteLength(line) + 1,
        event: JSON.parse(trimmed),
      });
    } catch (_) {
      // The first line of a tail slice can be partial.
    }
  }
  return records;
}

function trimRunTailFileCache(entry) {
  let totalBytes = entry.records.reduce((sum, record) => sum + record.bytes, 0);
  while (totalBytes > RUN_RESPONSE_TURN_MAX_BYTES && entry.records.length > 1) {
    totalBytes -= entry.records.shift().bytes;
  }
}

function pruneRunTailFileCaches() {
  if (RUN_TAIL_FILE_CACHES.size <= RUN_TAIL_FILE_CACHE_LIMIT) {
    return;
  }
  const oldest = [...RUN_TAIL_FILE_CACHES.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    .slice(0, RUN_TAIL_FILE_CACHES.size - RUN_TAIL_FILE_CACHE_LIMIT);
  for (const [cacheKey] of oldest) {
    RUN_TAIL_FILE_CACHES.delete(cacheKey);
  }
}

function latestTurnNumbersFromEvents(events, count) {
  const ordered = [];
  const seen = new Set();
  for (const event of events) {
    const turn = Number.isInteger(event?.turnNumber) && event.turnNumber > 0
      ? event.turnNumber
      : null;
    if (turn == null || seen.has(turn)) {
      continue;
    }
    seen.add(turn);
    ordered.push(turn);
  }
  return new Set(ordered.slice(-Math.max(1, count)));
}

function tailTurnWindowsFromEvents(events, count) {
  const wantedTurns = latestTurnNumbersFromEvents(events, count);
  const byTurn = new Map();
  for (const event of events) {
    if (!wantedTurns.has(event.turnNumber)) {
      continue;
    }
    const time = Date.parse(event.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    const current = byTurn.get(event.turnNumber) ?? {
      turnNumber: event.turnNumber,
      startTime: time,
      endTime: time + 1,
    };
    current.startTime = Math.min(current.startTime, time);
    current.endTime = Math.max(current.endTime, time + 1);
    byTurn.set(event.turnNumber, current);
  }
  const windows = [...byTurn.values()].sort((a, b) => a.startTime - b.startTime);
  return windows.map((window, index) => ({
    ...window,
    endTime: windows[index + 1]?.startTime ?? Infinity,
  }));
}

function selectRunEventsForResponse(events, detailOptions, selectedWindows) {
  let selected = events;
  if (detailOptions.mode === "none") {
    selected = selected.filter((event) => !isDisplayItemCardEvent(event));
  }
  if (detailOptions.mode !== "all" && detailOptions.mode !== "none") {
    selected = filterEventsToWindows(events, selectedWindows);
  }
  if (detailOptions.mode !== "none") {
    selected = normalizeRunAsyncCommandChains(selected);
  }
  const compacted = selected.map((event) =>
    compactConvertedSessionEvent(event, detailOptions.outputLimit ?? CODEX_SESSION_OUTPUT_LIMIT));
  if (detailOptions.mode === "all") {
    return compacted;
  }
  return limitSessionEventsByTurn(compacted, detailOptions.maxEventsPerTurn);
}

function filterEventsToWindows(events, selectedWindows) {
  if (!selectedWindows?.length) {
    return events;
  }
  const selectedTurns = new Set(selectedWindows.map((window) => window.turnNumber));
  return events.filter((event) => {
    const turn = Number.isInteger(event?.turnNumber) && event.turnNumber > 0
      ? event.turnNumber
      : null;
    if (turn != null && selectedTurns.has(turn)) {
      return true;
    }
    const time = Date.parse(event?.recordedAt ?? "");
    return Number.isFinite(time) &&
      selectedWindows.some((window) => time >= window.startTime && time < window.endTime);
  });
}

function progressEventsFromRunEvents(events) {
  const progressEvents = [];
  const commandsByAsyncCell = new Map();
  const commandsBySessionStoreKey = new Map();
  const commandStartsById = new Map();
  for (const record of events) {
    const item = record?.event?.item;
    if (item?.type !== "command_execution") {
      continue;
    }
    if (record?.eventType === "item.started" && item.id) {
      commandStartsById.set(item.id, item);
      continue;
    }
    if (record?.eventType !== "item.completed") {
      continue;
    }
    if (!Number.isInteger(record.turnNumber) || record.turnNumber <= 0) {
      continue;
    }
    const output = commandOutputText(item.aggregated_output);
    const startItem = item.id ? commandStartsById.get(item.id) ?? null : null;
    if (item.id) {
      commandStartsById.delete(item.id);
    }
    const metadataItem = startItem ?? item;
    const toolSource = commandToolSource(metadataItem);
    const waitCellId = waitCommandCellId(toolSource);
    const outputCellId = commandOutputSessionId(item.aggregated_output);
    const sessionLoadKey = commandSessionLoadKey(startItem ?? item);
    const command = (waitCellId
      ? commandsByAsyncCell.get(asyncRecordMapKey(record, waitCellId))
      : null) ??
      (sessionLoadKey
        ? commandsBySessionStoreKey.get(asyncRecordMapKey(record, sessionLoadKey))
        : null) ??
      normalizedEventCommand(item.command ?? startItem?.command ?? "");
    if (outputCellId) {
      commandsByAsyncCell.set(asyncRecordMapKey(record, outputCellId), command);
    }
    const sessionStoreKey = commandSessionStoreKey(startItem ?? item);
    if (sessionStoreKey) {
      commandsBySessionStoreKey.set(asyncRecordMapKey(record, sessionStoreKey), command);
    }
    if (!output) {
      continue;
    }
    const observation = progressObservationFromSessionOutput(
      output,
      record.recordedAt,
      command,
    );
    if (!observation) {
      continue;
    }
    progressEvents.push({
      recordedAt: observation.recordedAt,
      threadId: record.threadId ?? null,
      turnNumber: record.turnNumber,
      eventType: "ralph.agent-progress",
      event: {
        type: "ralph.agent-progress",
        progress: {
          ...observation,
          commandKind: "run-log",
          commandTarget: "command output summary",
        },
      },
    });
  }
  return compactBestProgressEvents(progressEvents);
}

function normalizeRunAsyncCommandChains(events) {
  const commandsByAsyncCell = new Map();
  const sessionsByStoreKey = new Map();
  const startsById = new Map();
  const normalized = [];

  for (const record of events ?? []) {
    const item = record?.event?.item;
    if (item?.type !== "command_execution" ||
        (record.eventType !== "item.started" && record.eventType !== "item.completed")) {
      normalized.push(record);
      continue;
    }

    const startItem = record.eventType === "item.started"
      ? item
      : item.id
        ? startsById.get(item.id) ?? null
        : null;
    const metadataItem = startItem ?? item;
    const toolSource = commandToolSource(metadataItem);
    const waitCellId = waitCommandCellId(toolSource);
    const loadKey = commandSessionLoadKey(metadataItem);
    const storedSession = loadKey
      ? sessionsByStoreKey.get(asyncRecordMapKey(record, loadKey)) ?? null
      : null;
    const parentId = waitCellId ?? storedSession?.sessionId ?? null;
    const parentCommand = (waitCellId
      ? commandsByAsyncCell.get(asyncRecordMapKey(record, waitCellId))
      : null) ??
      storedSession?.command ??
      null;
    const baseCommand = normalizedEventCommand(
      item.command ?? startItem?.command ?? "",
      toolSource,
    );
    const command = parentCommand
      ? `${parentCommand} (continued session ${parentId})`
      : baseCommand;
    const normalizedItem = command === item.command ? item : { ...item, command };
    const normalizedRecord = normalizedItem === item
      ? record
      : {
          ...record,
          event: { ...record.event, item: normalizedItem },
        };
    normalized.push(normalizedRecord);

    if (record.eventType === "item.started") {
      if (item.id) {
        startsById.set(item.id, item);
      }
      continue;
    }
    if (item.id) {
      startsById.delete(item.id);
    }
    const outputSessionId = commandOutputSessionId(item.aggregated_output);
    if (outputSessionId) {
      commandsByAsyncCell.set(
        asyncRecordMapKey(record, outputSessionId),
        parentCommand ?? command,
      );
    }
    const storeKey = commandSessionStoreKey(metadataItem);
    if (storeKey && outputSessionId) {
      sessionsByStoreKey.set(asyncRecordMapKey(record, storeKey), {
        sessionId: outputSessionId,
        command: parentCommand ?? command,
      });
    }
  }
  return normalized;
}

function normalizedEventCommand(command, toolSource = command) {
  const commands = extractToolExecCommands(toolSource);
  return commands.length === 1 ? commands[0] : String(command ?? "");
}

function asyncRecordMapKey(record, value) {
  return [
    record?.threadId ?? "",
    displayTurnForRecord(record) ?? "",
    String(value ?? ""),
  ].join("\u0000");
}

function commandToolSource(item) {
  return String(item?.raw?.input ?? item?.command ?? "");
}

function commandSessionLoadKey(item) {
  const source = commandToolSource(item);
  if (!/\btools\.write_stdin\s*\(/.test(source) && !/^write_stdin\b/.test(item?.command ?? "")) {
    return null;
  }
  return extractSessionLoadKey(source);
}

function commandSessionStoreKey(item) {
  return extractSessionStoreKey(commandToolSource(item));
}

function waitCommandCellId(command) {
  const text = String(command ?? "");
  const continuedMatch = text.match(/\(continued session ([^)]+)\)\s*$/);
  if (continuedMatch) {
    return continuedMatch[1];
  }
  const writeStdinMatch = text.match(/\btools\.write_stdin\s*\(\s*\{[\s\S]*?(?:\bsession_id\b|["']session_id["'])\s*:\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))/);
  if (writeStdinMatch) {
    return writeStdinMatch[1] ?? writeStdinMatch[2] ?? writeStdinMatch[3] ?? null;
  }
  const normalizedWriteStdinMatch = text.match(/^write_stdin session ([^\s]+)(?:\s|$)/);
  if (normalizedWriteStdinMatch) {
    return normalizedWriteStdinMatch[1];
  }
  const waitMatch = text.match(/^wait\s+(\{.*\})$/s);
  if (!waitMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(waitMatch[1]);
    return parsed?.cell_id != null ? String(parsed.cell_id) : null;
  } catch (_) {
    const fallback = text.match(/"cell_id"\s*:\s*"([^"]+)"/);
    return fallback ? fallback[1] : null;
  }
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
  let firstAt = null;
  let lastAt = null;
  let durationMs = 0;
  const usageMode = selected.skipCodexUsage ? "skip" : selected.usageMode ?? "full";

  for (const fileName of jsonls) {
    const filePath = path.join(eventsDir, fileName);
    const fileBase = path.basename(fileName, ".jsonl");
    const summary = await readRunUsageSummary(shape, filePath, fileBase, usageMode);
    const usage = applyRunUsageSummaryToShape(summary, seenThreads);

    if (hasTokenUsage(usage)) {
      total = addUsage(total, usage);
    }

    if (summary.firstAt && (!firstAt || summary.firstAt < firstAt)) {
      firstAt = summary.firstAt;
    }
    if (summary.lastAt && (!lastAt || summary.lastAt > lastAt)) {
      lastAt = summary.lastAt;
    }
    durationMs += summary.durationMs;

    runs.push({
      id: `${shape}/${fileBase}`,
      threadId: summary.threadIds[0] ?? fileBase,
      threadIds: summary.threadIds,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      durationMs: summary.durationMs,
      turnDurations: summary.turnDurations,
      turnUsages: summary.turnUsages,
      mtime: summary.mtime,
      usage: hasTokenUsage(usage) ? usage : null,
    });
  }

  return {
    shape,
    runCount: runs.length,
    threadCount: seenThreads.size,
    firstAt,
    lastAt,
    durationMs,
    usage: hasTokenUsage(total) ? total : null,
    runs,
  };
}

function readSelectedShapeUsage(shape, fileBase, events, usageMode) {
  const bounds = eventTimeBounds(events, { includeOpenCommandTail: true });
  const threadIds = inferThreadIdsFromRun("", events);
  let usage = null;
  if (usageMode !== "skip") {
    const tokenUsage = usageFromTokenEventsByThread(events);
    for (const entry of tokenUsage.threadUsages) {
      usage = addUsage(usage, entry.usage);
    }
    if (hasTokenUsage(tokenUsage.unthreadedUsage)) {
      usage = addUsage(usage, tokenUsage.unthreadedUsage);
    }
    if (!hasTokenUsage(usage)) {
      usage = usageFromVizEvents(events);
    }
  }
  return {
    shape,
    runCount: 1,
    threadCount: threadIds.length,
    firstAt: bounds.firstAt,
    lastAt: bounds.lastAt,
    durationMs: bounds.durationMs,
    usage: hasTokenUsage(usage) ? usage : null,
    runs: [{
      id: `${shape}/${fileBase}`,
      threadId: threadIds[0] ?? fileBase,
      threadIds,
      firstAt: bounds.firstAt,
      lastAt: bounds.lastAt,
      durationMs: bounds.durationMs,
      turnDurations: turnExecutionDurationEntries(events, new Map(), { includeOpenCommandTail: true }),
      turnUsages: turnUsageEntriesFromEvents(events),
      mtime: null,
      usage: hasTokenUsage(usage) ? usage : null,
    }],
  };
}

async function readFastShapeUsage(shape, fileBase, events, usageMode) {
  const filePath = path.join(RALPH_DIR, shape, "events", `${fileBase}.jsonl`);
  const stat = await fs.stat(filePath);
  const cached = await readLooseRunUsageCacheEntry(shape, fileBase);
  let summary = cached?.summary
    ? normalizeRunUsageSummary(cached.summary, stat, fileBase)
    : null;
  const selectedThreadIds = inferThreadIdsFromRun("", events);

  if (summary) {
    if (!cacheStatMatches(cached.file, stat)) {
      scheduleFastRunUsageRefresh(shape, filePath, fileBase, stat, cached, usageMode);
    }

    const threadUsageById = new Map(
      summary.threadUsages.map((entry) => [entry.threadId, entry.usage]),
    );
    const seenThreadIds = new Set(summary.threadIds);
    let liveCodexUsageDelta = null;
    let liveCodexCompleteUsage = null;
    const latestTurnNumber = latestEventTurnNumber(events);
    const latestTurnThreadIds = new Set(
      events
        .filter((event) => eventTurnNumber(event) === latestTurnNumber)
        .map((event) => eventThreadId(event))
        .filter(Boolean),
    );
    if (usageMode !== "skip") {
      for (const threadId of selectedThreadIds) {
        seenThreadIds.add(threadId);
        const usage = await readCodexThreadUsageFast(threadId);
        if (hasTokenUsage(usage)) {
          const previous = threadUsageById.get(threadId);
          if (latestTurnThreadIds.has(threadId)) {
            if (!previous || usageCounterReset(usage, previous)) {
              liveCodexCompleteUsage = addUsage(liveCodexCompleteUsage, usage);
            } else {
              liveCodexUsageDelta = addUsage(
                liveCodexUsageDelta,
                usageDelta(usage, previous),
              );
            }
          }
          threadUsageById.set(threadId, usage);
        }
      }
    }
    summary.threadIds = [...seenThreadIds].sort();
    summary.threadUsages = [...threadUsageById.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([threadId, usage]) => ({ threadId, usage }));

    const selectedBounds = eventTimeBounds(events, { includeOpenCommandTail: true });
    const liveTurnDurations = turnExecutionDurationEntries(events, new Map(), { includeOpenCommandTail: true });
    if (selectedBounds.firstAt && (!summary.firstAt || selectedBounds.firstAt < summary.firstAt)) {
      summary.firstAt = selectedBounds.firstAt;
    }
    if (selectedBounds.lastAt && (!summary.lastAt || selectedBounds.lastAt > summary.lastAt)) {
      summary.lastAt = selectedBounds.lastAt;
    }
    summary.durationMs = Math.max(
      summary.durationMs + turnDurationPositiveDelta(summary.turnDurations, liveTurnDurations),
      selectedBounds.durationMs,
    );
    summary.turnDurations = mergeTurnDurationEntriesMax(summary.turnDurations, liveTurnDurations);
    if (usageMode !== "skip") {
      summary.turnUsages = mergeTurnUsageEntriesMax(
        summary.turnUsages,
        turnUsageEntriesFromEvents(events.filter((event) =>
          event.eventType !== "codex.session.token_count")),
      );
      summary.turnUsages = addLiveUsageDeltaToLatestTurn(
        summary.turnUsages,
        events,
        liveCodexCompleteUsage,
        liveCodexUsageDelta,
      );
    }
    await augmentRunUsageSummaryFromCompareCache(shape, fileBase, stat, summary);
    return shapeUsageFromRunSummaries(shape, [{ fileBase, summary }]);
  }

  if (usageMode !== "skip") {
    const summary = await readRunUsageSummary(shape, filePath, fileBase, usageMode);
    summary.turnUsages = mergeTurnUsageEntriesMax(
      summary.turnUsages,
      turnUsageEntriesFromEvents(events),
    );
    await augmentRunUsageSummaryFromCompareCache(shape, fileBase, stat, summary);
    return shapeUsageFromRunSummaries(shape, [{ fileBase, summary }]);
  }

  const rebuilt = await readRunUsageSummary(shape, filePath, fileBase, usageMode);
  return shapeUsageFromRunSummaries(shape, [{ fileBase, summary: rebuilt }]);
}

function addLiveUsageDeltaToLatestTurn(
  turnUsages,
  events,
  completeUsage,
  usageDeltaValue,
) {
  if (!hasTokenUsage(completeUsage) && !hasTokenUsage(usageDeltaValue)) {
    return turnUsages;
  }
  const turnNumber = latestEventTurnNumber(events);
  if (!turnNumber) {
    return turnUsages;
  }
  const byTurn = new Map(normalizeTurnUsageEntries(turnUsages).map((entry) => [
    entry.turnNumber,
    { ...entry, usage: normalizeUsage(entry.usage) },
  ]));
  const existing = byTurn.get(turnNumber);
  const baseUsage = hasTokenUsage(completeUsage) &&
      usageMagnitude(completeUsage) > usageMagnitude(existing?.usage)
    ? completeUsage
    : existing?.usage;
  byTurn.set(turnNumber, {
    turnNumber,
    usage: addUsage(baseUsage, usageDeltaValue),
  });
  return [...byTurn.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function latestEventTurnNumber(events) {
  return (events ?? []).reduce((latest, event) => {
    const turn = eventTurnNumber(event);
    return turn == null ? latest : Math.max(latest, turn);
  }, 0);
}

function scheduleFastRunUsageRefresh(shape, filePath, fileBase, stat, cacheEntry, usageMode) {
  if (usageMode === "skip") {
    return;
  }
  const generatedAt = Date.parse(cacheEntry?.generatedAt ?? "");
  if (Number.isFinite(generatedAt) && Date.now() - generatedAt < RUN_USAGE_REFRESH_INTERVAL_MS) {
    return;
  }
  const key = `${shape}\0${fileBase}`;
  if (RUN_USAGE_REFRESHES.has(key)) {
    return;
  }
  const refresh = refreshStaleFastRunUsageSummary(
    shape,
    filePath,
    fileBase,
    stat,
    cacheEntry,
    usageMode,
  ).catch((error) => {
    console.warn(`failed to refresh usage cache for ${shape}/${fileBase}:`, error?.message ?? error);
  }).finally(() => {
    RUN_USAGE_REFRESHES.delete(key);
  });
  RUN_USAGE_REFRESHES.set(key, refresh);
}

async function refreshStaleFastRunUsageSummary(shape, filePath, fileBase, stat, cacheEntry, usageMode) {
  const cachedSize = Number(cacheEntry?.file?.size);
  if (!Number.isFinite(cachedSize) || cachedSize < 0 || cachedSize > stat.size) {
    return null;
  }

  let summary = normalizeRunUsageSummary(cacheEntry.summary, stat, fileBase);
  const deltaEvents = cachedSize < stat.size
    ? await readRunEventsFromOffset(filePath, cachedSize, stat.size)
    : [];

  if (deltaEvents.length) {
    if (deltaEvents.some(isTurnAttemptBoundaryEvent)) {
      // Finalize completed turns from the complete Ralph log. Incremental
      // fragments cannot safely bridge a long reasoning interval or distinguish
      // it from a recorded restart/quota wait without the preceding boundary.
      summary = buildRunLogUsageSummary(fileBase, stat, await readRunFile(filePath), usageMode);
    } else {
      extendRunLogUsageSummaryFromEvents(summary, deltaEvents, usageMode);
    }
    if (usageMode !== "skip") {
      await replaceTouchedSummaryThreadUsages(summary, deltaEvents);
    }
  }

  const latestSessionStats = usageMode === "skip"
    ? []
    : await codexSessionStatsForThreadIds(summary.threadIds);
  await writeRunUsageCache(shape, fileBase, stat, "fast", latestSessionStats, summary);
  return summary;
}

async function replaceTouchedSummaryThreadUsages(summary, events) {
  const touchedThreadIds = inferThreadIdsFromRun("", events);
  if (!touchedThreadIds.length) {
    return;
  }
  const byThread = new Map(summary.threadUsages.map((entry) => [entry.threadId, entry.usage]));
  for (const threadId of touchedThreadIds) {
    const usage = await readCodexThreadUsageFast(threadId);
    if (hasTokenUsage(usage)) {
      byThread.set(threadId, usage);
    }
  }
  summary.threadUsages = [...byThread.entries()]
    .filter(([, usage]) => hasTokenUsage(usage))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([threadId, usage]) => ({ threadId, usage: normalizeUsage(usage) }));
}

async function readRunEventsFromOffset(filePath, offset, endOffset = null) {
  const events = [];
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    start: Math.max(0, offset),
    ...(Number.isFinite(endOffset) && endOffset > offset
      ? { end: Math.max(0, endOffset - 1) }
      : {}),
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed);
      }
    } catch (_) {
      // If the cached byte offset landed in the middle of a line, the first
      // read fragment is not parseable. Later complete JSONL records still are.
    }
  }
  return events;
}

async function extendRunUsageSummaryFromEvents(summary, filePath, events, usageMode) {
  const bounds = eventTimeBounds(events);
  if (bounds.firstAt && (!summary.firstAt || bounds.firstAt < summary.firstAt)) {
    summary.firstAt = bounds.firstAt;
  }
  if (bounds.lastAt && (!summary.lastAt || bounds.lastAt > summary.lastAt)) {
    summary.lastAt = bounds.lastAt;
  }

  const threadIds = inferThreadIdsFromRun(filePath, events);
  const mergedThreadIds = new Set(summary.threadIds);
  for (const threadId of threadIds) {
    mergedThreadIds.add(threadId);
  }

  const sessionTiming = usageMode === "skip"
    ? new Map()
    : await readCodexThreadTiming(threadIds, buildSessionTurnAttemptResolver(events));
  const durationDeltaMs = turnExecutionDurationMs(events, sessionTiming) || bounds.durationMs;
  if (durationDeltaMs > 0) {
    summary.durationMs += durationDeltaMs;
  }
  summary.turnDurations = mergeTurnDurationEntries(
    summary.turnDurations,
    turnExecutionDurationEntries(events, sessionTiming),
  );
  const threadUsageById = new Map(summary.threadUsages.map((entry) => [entry.threadId, entry.usage]));
  let unthreadedUsage = summary.unthreadedUsage;
  if (usageMode !== "skip") {
    const tokenUsage = usageFromTokenEventsByThread(events);
    for (const entry of tokenUsage.threadUsages) {
      threadUsageById.set(entry.threadId, addUsage(threadUsageById.get(entry.threadId), entry.usage));
      mergedThreadIds.add(entry.threadId);
    }
    if (hasTokenUsage(tokenUsage.unthreadedUsage)) {
      unthreadedUsage = addUsage(unthreadedUsage, tokenUsage.unthreadedUsage);
    }

    for (const [threadId, usage] of turnCompletedUsageByThread(events).entries()) {
      if (!threadId) {
        if (hasTokenUsage(usage)) {
          unthreadedUsage = addUsage(unthreadedUsage, usage);
        }
        continue;
      }
      const existing = threadUsageById.get(threadId);
      if (existing) {
        if (usage.cost_usd > 0 && !((existing.cost_usd ?? 0) > 0)) {
          threadUsageById.set(threadId, { ...(normalizeUsage(existing) ?? emptyUsage()), cost_usd: usage.cost_usd });
        }
      } else if (hasTokenUsage(usage)) {
        threadUsageById.set(threadId, usage);
      }
      mergedThreadIds.add(threadId);
    }

    // Codex session counters are cumulative per thread. Replacing any touched
    // thread with the latest fast-read value avoids double-counting when a
    // stale cache was written in the middle of a restarted or continued turn.
    for (const threadId of threadIds) {
      const usage = await readCodexThreadUsageFast(threadId);
      if (hasTokenUsage(usage)) {
        threadUsageById.set(threadId, usage);
        mergedThreadIds.add(threadId);
      }
    }
  }

  summary.threadIds = [...mergedThreadIds].filter(Boolean).sort();
  summary.threadUsages = [...threadUsageById.entries()]
    .filter(([, usage]) => hasTokenUsage(usage))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([threadId, usage]) => ({ threadId, usage: normalizeUsage(usage) ?? emptyUsage() }));
  summary.unthreadedUsage = hasTokenUsage(unthreadedUsage)
    ? normalizeUsage(unthreadedUsage)
    : null;
}

function mergeTurnDurationEntries(existingEntries, newEntries) {
  const byTurn = new Map();
  for (const entry of normalizeTurnDurationEntries(existingEntries)) {
    byTurn.set(entry.turnNumber, { ...entry });
  }
  for (const entry of normalizeTurnDurationEntries(newEntries)) {
    const current = byTurn.get(entry.turnNumber);
    if (!current) {
      byTurn.set(entry.turnNumber, { ...entry });
      continue;
    }
    current.durationMs += entry.durationMs;
    if (entry.firstAt && (!current.firstAt || entry.firstAt < current.firstAt)) {
      current.firstAt = entry.firstAt;
    }
    if (entry.lastAt && (!current.lastAt || entry.lastAt > current.lastAt)) {
      current.lastAt = entry.lastAt;
    }
  }
  return [...byTurn.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function mergeTurnDurationEntriesMax(existingEntries, newEntries) {
  const byTurn = new Map();
  for (const entry of normalizeTurnDurationEntries(existingEntries)) {
    byTurn.set(entry.turnNumber, { ...entry });
  }
  for (const entry of normalizeTurnDurationEntries(newEntries)) {
    const current = byTurn.get(entry.turnNumber);
    if (!current) {
      byTurn.set(entry.turnNumber, { ...entry });
      continue;
    }
    current.durationMs = Math.max(current.durationMs, entry.durationMs);
    if (entry.firstAt && (!current.firstAt || entry.firstAt < current.firstAt)) {
      current.firstAt = entry.firstAt;
    }
    if (entry.lastAt && (!current.lastAt || entry.lastAt > current.lastAt)) {
      current.lastAt = entry.lastAt;
    }
  }
  return [...byTurn.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function turnDurationPositiveDelta(existingEntries, newEntries) {
  const existingByTurn = new Map();
  for (const entry of normalizeTurnDurationEntries(existingEntries)) {
    existingByTurn.set(entry.turnNumber, entry.durationMs);
  }
  let deltaMs = 0;
  for (const entry of normalizeTurnDurationEntries(newEntries)) {
    deltaMs += Math.max(0, entry.durationMs - (existingByTurn.get(entry.turnNumber) ?? 0));
  }
  return deltaMs;
}

function normalizeTurnUsageEntries(rawEntries) {
  const byTurn = new Map();
  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    const turnNumber = Number(raw?.turnNumber);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      continue;
    }
    const usage = normalizeUsage(raw?.usage);
    if (!hasTokenUsage(usage)) {
      continue;
    }
    byTurn.set(turnNumber, {
      turnNumber,
      usage: addUsage(byTurn.get(turnNumber)?.usage, usage),
    });
  }
  return [...byTurn.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function mergeTurnUsageEntriesMax(existingEntries, newEntries) {
  const byTurn = new Map();
  for (const entry of normalizeTurnUsageEntries(existingEntries)) {
    byTurn.set(entry.turnNumber, { ...entry, usage: normalizeUsage(entry.usage) });
  }
  for (const entry of normalizeTurnUsageEntries(newEntries)) {
    const current = byTurn.get(entry.turnNumber);
    if (!current || usageMagnitude(entry.usage) > usageMagnitude(current.usage)) {
      byTurn.set(entry.turnNumber, { ...entry, usage: normalizeUsage(entry.usage) });
    }
  }
  return [...byTurn.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function usageMagnitude(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) {
    return 0;
  }
  return normalized.total_tokens ||
    normalized.input_tokens +
      normalized.cached_input_tokens +
      normalized.output_tokens +
      normalized.reasoning_output_tokens ||
    normalized.cost_usd;
}

function shapeUsageFromRunSummaries(shape, entries) {
  const seenThreads = new Set();
  let total = emptyUsage();
  let firstAt = null;
  let lastAt = null;
  let durationMs = 0;
  const runs = [];

  for (const { fileBase, summary } of entries) {
    const usage = bestRunUsageForShape(summary, seenThreads);
    if (hasTokenUsage(usage)) {
      total = addUsage(total, usage);
    }
    if (summary.firstAt && (!firstAt || summary.firstAt < firstAt)) {
      firstAt = summary.firstAt;
    }
    if (summary.lastAt && (!lastAt || summary.lastAt > lastAt)) {
      lastAt = summary.lastAt;
    }
    durationMs += summary.durationMs;
    runs.push({
      id: `${shape}/${fileBase}`,
      threadId: summary.threadIds[0] ?? fileBase,
      threadIds: summary.threadIds,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      durationMs: summary.durationMs,
      turnDurations: summary.turnDurations,
      turnUsages: summary.turnUsages,
      mtime: summary.mtime,
      usage: hasTokenUsage(usage) ? usage : null,
    });
  }

  return {
    shape,
    runCount: runs.length,
    threadCount: seenThreads.size,
    firstAt,
    lastAt,
    durationMs,
    usage: hasTokenUsage(total) ? total : null,
    runs,
  };
}

async function augmentRunUsageSummaryFromCompareCache(shape, fileBase, stat, summary) {
  const cached = await readComparePaCostsCache(shape, fileBase, stat);
  if (!cached) {
    return;
  }
  summary.turnUsages = mergeTurnUsageEntriesMax(summary.turnUsages, cached.turnUsages);
  summary.turnDurations = mergeTurnDurationEntriesMax(summary.turnDurations, cached.turnDurations);
  const durationFromTurns = sumTurnDurationEntries(summary.turnDurations);
  if (durationFromTurns > summary.durationMs) {
    summary.durationMs = durationFromTurns;
  }
}

async function readComparePaCostsCache(shape, fileBase, stat) {
  const cachePath = comparePaCostsCachePath(shape, fileBase);
  if (!cachePath) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (_) {
    return null;
  }
  if (parsed?.version !== COMPARE_PA_COSTS_CACHE_VERSION) {
    return null;
  }
  const cachedSize = Number(parsed.runFile?.size);
  if (!Number.isFinite(cachedSize) || cachedSize <= 0 || cachedSize > stat.size) {
    return null;
  }

  const usageByTurn = new Map();
  const durationByTurn = new Map();
  for (const slot of Array.isArray(parsed.slots) ? parsed.slots : []) {
    const turnNumber = Number(slot?.turn);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      continue;
    }
    const usage = normalizeUsage(slot?.usage);
    if (hasTokenUsage(usage)) {
      usageByTurn.set(turnNumber, addUsage(usageByTurn.get(turnNumber), usage));
    }
    const durationMs = Number(slot?.durationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      const current = durationByTurn.get(turnNumber) ?? {
        turnNumber,
        durationMs: 0,
        firstAt: null,
        lastAt: null,
      };
      current.durationMs += durationMs;
      durationByTurn.set(turnNumber, current);
    }
  }

  return {
    turnUsages: [...usageByTurn.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([turnNumber, usage]) => ({ turnNumber, usage })),
    turnDurations: [...durationByTurn.values()]
      .sort((left, right) => left.turnNumber - right.turnNumber),
  };
}

function comparePaCostsCachePath(shape, fileBase) {
  if (!/^[a-zA-Z0-9._-]+$/.test(shape ?? "") || !/^[a-zA-Z0-9._-]+$/.test(fileBase ?? "")) {
    return null;
  }
  return path.join(RALPH_DIR, shape, RUN_USAGE_CACHE_DIR, `compare-pa-costs-${fileBase}.json`);
}

function sumTurnDurationEntries(entries) {
  return normalizeTurnDurationEntries(entries)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
}

async function readLooseRunUsageCacheEntry(shape, fileBase) {
  const cachePath = runUsageCachePath(shape, fileBase);
  if (!cachePath) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    return parsed?.version === RUN_USAGE_CACHE_VERSION ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function readRunUsageSummary(shape, filePath, fileBase, usageMode) {
  const stat = await fs.stat(filePath);
  const precision = runUsagePrecision(usageMode);
  const events = await readRunFile(filePath);
  if (precision === "fast") {
    const summary = buildRunLogUsageSummary(fileBase, stat, events, usageMode);
    await writeRunUsageCache(shape, fileBase, stat, precision, [], summary);
    return summary;
  }
  const threadIds = precision ? inferThreadIdsFromRun(filePath, events) : [];
  const sessionStats = precision ? await codexSessionStatsForThreadIds(threadIds) : [];
  if (precision) {
    const cacheEntry = await readRunUsageCacheEntry(shape, fileBase, stat, precision);
    if (cacheEntry && cacheSessionStatsMatch(cacheEntry.codexSessions, sessionStats)) {
      return normalizeRunUsageSummary(cacheEntry.summary, stat, fileBase);
    }
    if (cacheEntry && precision === "fast") {
      const refreshed = await refreshFastRunUsageSummary(
        cacheEntry.summary,
        stat,
        fileBase,
        threadIds,
        cacheEntry.codexSessions,
        sessionStats,
      );
      await writeRunUsageCache(shape, fileBase, stat, precision, sessionStats, refreshed);
      return refreshed;
    }
  }

  const summary = await buildRunUsageSummary(filePath, fileBase, stat, events, precision);
  if (precision) {
    const latestSessionStats = await codexSessionStatsForThreadIds(threadIds);
    await writeRunUsageCache(shape, fileBase, stat, precision, latestSessionStats, summary);
  }
  return summary;
}

async function buildRunUsageSummary(filePath, fileBase, stat, events, precision) {
  const bounds = eventTimeBounds(events);
  const threadIds = inferThreadIdsFromRun(filePath, events);
  const resolveSessionTurn = buildSessionTurnAttemptResolver(events);
  const sessionTiming = await readCodexThreadTiming(threadIds, resolveSessionTurn);
  const sessionTurnUsages = precision
    ? await readCodexThreadUsageByTurn(threadIds, resolveSessionTurn)
    : [];
  const tokenUsage = usageFromTokenEventsByThread(events);
  const threadUsages = [...tokenUsage.threadUsages];
  const coveredThreadIds = new Set(threadUsages.map((entry) => entry.threadId));

  if (precision) {
    for (const threadId of threadIds) {
      if (coveredThreadIds.has(threadId)) {
        continue;
      }
      const usage = await readCodexThreadUsage(threadId, precision);
      if (hasTokenUsage(usage)) {
        threadUsages.push({ threadId, usage });
        coveredThreadIds.add(threadId);
      }
    }
  }

  // Threads with no token_count records (e.g. turns recorded before a provider
  // emitted live counts) fall back to their turn.completed usage; threads that
  // are covered still harvest the exact turn cost from turn.completed.
  const turnUsageByThread = turnCompletedUsageByThread(events);
  for (const [threadId, usage] of turnUsageByThread.entries()) {
    if (!threadId) {
      continue;
    }
    if (coveredThreadIds.has(threadId)) {
      if (usage.cost_usd > 0) {
        const entry = threadUsages.find((candidate) => candidate.threadId === threadId);
        if (entry && !((entry.usage?.cost_usd ?? 0) > 0)) {
          entry.usage = { ...(normalizeUsage(entry.usage) ?? emptyUsage()), cost_usd: usage.cost_usd };
        }
      }
      continue;
    }
    if (hasTokenUsage(usage)) {
      threadUsages.push({ threadId, usage });
      coveredThreadIds.add(threadId);
    }
  }

  let unthreadedUsage = tokenUsage.unthreadedUsage;
  if (!hasTokenUsage(unthreadedUsage) && threadUsages.length === 0) {
    const fallbackUsage = usageFromVizEvents(events);
    if (hasTokenUsage(fallbackUsage) && threadIds.length === 1) {
      threadUsages.push({ threadId: threadIds[0], usage: fallbackUsage });
      coveredThreadIds.add(threadIds[0]);
    } else {
      unthreadedUsage = fallbackUsage;
    }
  }

  return normalizeRunUsageSummary({
    fileBase,
    threadIds,
    threadUsages,
    unthreadedUsage,
    firstAt: bounds.firstAt,
    lastAt: bounds.lastAt,
    durationMs: turnExecutionDurationMs(events, sessionTiming) || bounds.durationMs,
    turnDurations: turnExecutionDurationEntries(events, sessionTiming),
    turnUsages: mergeTurnUsageEntriesMax(turnUsageEntriesFromEvents(events), sessionTurnUsages),
    mtime: stat.mtime.toISOString(),
  }, stat, fileBase);
}

function buildRunLogUsageSummary(fileBase, stat, events, usageMode) {
  const bounds = eventTimeBounds(events, { includeOpenCommandTail: true });
  const threadIds = inferThreadIdsFromRun("", events);
  const turnDurations = turnExecutionDurationEntries(events, new Map(), { includeOpenCommandTail: true });
  const durationMs = turnDurations.reduce((sum, entry) => sum + entry.durationMs, 0) || bounds.durationMs;
  const tokenUsage = usageMode === "skip"
    ? { threadUsages: [], unthreadedUsage: null }
    : usageFromTokenEventsByThread(events);
  const hasThreadUsage = tokenUsage.threadUsages.some((entry) => hasTokenUsage(entry.usage));
  const fallbackUsage =
    usageMode === "skip" || hasThreadUsage || hasTokenUsage(tokenUsage.unthreadedUsage)
      ? null
      : usageFromVizEvents(events);

  return normalizeRunUsageSummary({
    fileBase,
    threadIds,
    threadUsages: tokenUsage.threadUsages,
    unthreadedUsage: hasTokenUsage(tokenUsage.unthreadedUsage)
      ? tokenUsage.unthreadedUsage
      : fallbackUsage,
    firstAt: bounds.firstAt,
    lastAt: bounds.lastAt,
    durationMs,
    turnDurations,
    turnUsages: usageMode === "skip" ? [] : turnUsageEntriesFromEvents(events),
    mtime: stat.mtime.toISOString(),
  }, stat, fileBase);
}

function extendRunLogUsageSummaryFromEvents(summary, events, usageMode) {
  const bounds = eventTimeBounds(events, { includeOpenCommandTail: true });
  if (bounds.firstAt && (!summary.firstAt || bounds.firstAt < summary.firstAt)) {
    summary.firstAt = bounds.firstAt;
  }
  if (bounds.lastAt && (!summary.lastAt || bounds.lastAt > summary.lastAt)) {
    summary.lastAt = bounds.lastAt;
  }

  const turnDurations = turnExecutionDurationEntries(events, new Map(), { includeOpenCommandTail: true });
  const durationMs = turnDurations.reduce((sum, entry) => sum + entry.durationMs, 0) || bounds.durationMs;
  summary.durationMs += durationMs;
  summary.turnDurations = mergeTurnDurationEntries(summary.turnDurations, turnDurations);

  const mergedThreadIds = new Set(summary.threadIds);
  for (const threadId of inferThreadIdsFromRun("", events)) {
    mergedThreadIds.add(threadId);
  }
  summary.threadIds = [...mergedThreadIds].filter(Boolean).sort();

  if (usageMode === "skip") {
    summary.turnUsages = [];
    return;
  }

  const tokenUsage = usageFromTokenEventsByThread(events);
  const threadUsageById = new Map(summary.threadUsages.map((entry) => [entry.threadId, entry.usage]));
  for (const entry of tokenUsage.threadUsages) {
    threadUsageById.set(entry.threadId, addUsage(threadUsageById.get(entry.threadId), entry.usage));
  }
  summary.threadUsages = [...threadUsageById.entries()]
    .filter(([, usage]) => hasTokenUsage(usage))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([threadId, usage]) => ({ threadId, usage: normalizeUsage(usage) ?? emptyUsage() }));
  if (hasTokenUsage(tokenUsage.unthreadedUsage)) {
    summary.unthreadedUsage = addUsage(summary.unthreadedUsage, tokenUsage.unthreadedUsage);
  }
  summary.turnUsages = mergeTurnUsageEntriesMax(summary.turnUsages, turnUsageEntriesFromEvents(events));
}

function applyRunUsageSummaryToShape(summary, seenThreads) {
  let usage = null;
  for (const entry of summary.threadUsages ?? []) {
    const threadId = entry.threadId;
    if (!threadId || seenThreads.has(threadId)) {
      continue;
    }
    seenThreads.add(threadId);
    usage = addUsage(usage, entry.usage);
  }
  for (const threadId of summary.threadIds ?? []) {
    if (threadId) {
      seenThreads.add(threadId);
    }
  }
  if (hasTokenUsage(summary.unthreadedUsage)) {
    usage = addUsage(usage, summary.unthreadedUsage);
  }
  return hasTokenUsage(usage) ? usage : null;
}

function bestRunUsageForShape(summary, seenThreads) {
  const threadUsage = applyRunUsageSummaryToShape(summary, seenThreads);
  const turnUsage = usageFromTurnUsageEntries(summary?.turnUsages);
  if (hasTokenUsage(turnUsage)) {
    return turnUsage;
  }
  return threadUsage;
}

function usageFromTurnUsageEntries(entries) {
  let usage = null;
  for (const entry of normalizeTurnUsageEntries(entries)) {
    usage = addUsage(usage, entry.usage);
  }
  return hasTokenUsage(usage) ? usage : null;
}

function turnCompletedUsageByThread(events) {
  const totals = new Map();
  for (const event of events) {
    if (event.eventType !== "turn.completed" || !event.event?.usage) {
      continue;
    }
    const threadId = eventThreadId(event) ?? "";
    totals.set(threadId, addUsage(totals.get(threadId), event.event.usage));
  }
  return totals;
}

function usageFromTokenEventsByThread(events) {
  const tokenRecords = events
    .filter((event) => event.eventType === "codex.session.token_count" && event.event?.usage)
    .sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
  const previousByThread = new Map();
  const totalsByThread = new Map();

  for (const record of tokenRecords) {
    const current = normalizeUsage(record.event.usage);
    if (!hasTokenUsage(current)) {
      continue;
    }
    const threadId = eventThreadId(record) ?? "";
    if (isUsageBaselineRecord(record)) {
      previousByThread.set(threadId, current);
      continue;
    }
    const previous = previousByThread.get(threadId) ?? null;
    const delta = usageDelta(current, previous);
    previousByThread.set(threadId, current);
    totalsByThread.set(threadId, addUsage(totalsByThread.get(threadId), delta));
  }

  const threadUsages = [];
  let unthreadedUsage = null;
  for (const [threadId, usage] of totalsByThread.entries()) {
    if (!hasTokenUsage(usage)) {
      continue;
    }
    if (threadId) {
      threadUsages.push({ threadId, usage });
    } else {
      unthreadedUsage = addUsage(unthreadedUsage, usage);
    }
  }
  return { threadUsages, unthreadedUsage };
}

function turnUsageEntriesFromEvents(events) {
  const byTurn = usageFromEventsByTurn(events);
  return normalizeTurnUsageEntries([...byTurn.entries()].map(([turnNumber, usage]) => ({
    turnNumber,
    usage,
  })));
}

function usageFromEventsByTurn(events) {
  const map = new Map();
  const tokenTurns = new Set();
  const tokenRecords = events
    .filter((event) => event.eventType === "codex.session.token_count" && event.event?.usage)
    .sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));

  if (tokenRecords.length) {
    const previousByThread = new Map();
    for (const record of tokenRecords) {
      const current = normalizeUsage(record.event.usage);
      if (!hasTokenUsage(current)) {
        continue;
      }
      const threadId = eventThreadId(record) ?? "";
      if (isUsageBaselineRecord(record)) {
        previousByThread.set(threadId, current);
        continue;
      }
      const previous = previousByThread.get(threadId) ?? null;
      const delta = usageDelta(current, previous);
      previousByThread.set(threadId, current);
      if (!hasTokenUsage(delta)) {
        continue;
      }
      const turn = eventTurnNumber(record);
      if (turn == null) {
        continue;
      }
      map.set(turn, addUsage(map.get(turn), delta));
      tokenTurns.add(turn);
    }
  }

  for (const event of events) {
    if (event.eventType === "turn.completed" && event.event?.usage) {
      const turn = eventTurnNumber(event);
      if (turn == null) {
        continue;
      }
      const usage = normalizeUsage(event.event.usage);
      if (!hasTokenUsage(usage)) {
        continue;
      }
      if (tokenTurns.has(turn)) {
        map.set(turn, usageWithCompletedCost(map.get(turn), usage));
        continue;
      }
      map.set(turn, addUsage(map.get(turn), usage));
    }

    if (event.eventType === "finished" && event.event?.value?.usageMetadata) {
      const turn = eventTurnNumber(event);
      if (turn == null || tokenTurns.has(turn)) {
        continue;
      }
      const usage = normalizeUsage(event.event.value.usageMetadata);
      if (hasTokenUsage(usage)) {
        map.set(turn, addUsage(map.get(turn), usage));
      }
    }
  }

  return map;
}

function eventTurnNumber(event) {
  const turnNumber = Number(event?.turnNumber);
  return Number.isInteger(turnNumber) && turnNumber > 0 ? turnNumber : null;
}

function runUsagePrecision(usageMode) {
  if (usageMode === "skip") {
    return null;
  }
  return usageMode === "fast" ? "fast" : "full";
}

async function readRunUsageCacheEntry(shape, fileBase, stat, requestedPrecision) {
  const cachePath = runUsageCachePath(shape, fileBase);
  if (!cachePath) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
  if (
    parsed?.version !== RUN_USAGE_CACHE_VERSION ||
    !cacheStatMatches(parsed.file, stat) ||
    !cachePrecisionSatisfies(parsed.precision, requestedPrecision)
  ) {
    return null;
  }
  return parsed;
}

async function writeRunUsageCache(shape, fileBase, stat, precision, sessionStats, summary) {
  const cachePath = runUsageCachePath(shape, fileBase);
  if (!cachePath) {
    return;
  }
  const body = JSON.stringify({
    version: RUN_USAGE_CACHE_VERSION,
    precision,
    generatedAt: new Date().toISOString(),
    file: {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString(),
    },
    codexSessions: sessionStats,
    summary,
  });
  const dir = path.dirname(cachePath);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, body, "utf8");
    await fs.rename(tmpPath, cachePath);
  } catch (_) {
    try {
      await fs.unlink(tmpPath);
    } catch (_) {}
  }
}

function runUsageCachePath(shape, fileBase) {
  if (!/^[a-zA-Z0-9._-]+$/.test(shape ?? "") || !/^[a-zA-Z0-9._-]+$/.test(fileBase ?? "")) {
    return null;
  }
  return path.join(RALPH_DIR, shape, RUN_USAGE_CACHE_DIR, `${fileBase}.json`);
}

function cacheStatMatches(file, stat) {
  return (
    Number(file?.size) === stat.size &&
    Math.abs(Number(file?.mtimeMs) - stat.mtimeMs) < 0.001
  );
}

async function refreshFastRunUsageSummary(rawSummary, stat, fileBase, threadIds, cachedSessionStats, currentSessionStats) {
  const summary = normalizeRunUsageSummary(rawSummary, stat, fileBase);
  const threadUsageById = new Map(summary.threadUsages.map((entry) => [entry.threadId, entry.usage]));
  const seenThreadIds = new Set(summary.threadIds);

  for (const threadId of threadIds ?? []) {
    if (!threadId) {
      continue;
    }
    seenThreadIds.add(threadId);
    const usage = await readCodexThreadUsageFast(threadId);
    if (hasTokenUsage(usage)) {
      threadUsageById.set(threadId, usage);
    }
  }

  summary.threadIds = [...seenThreadIds].sort();
  summary.threadUsages = [...threadUsageById.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([threadId, usage]) => ({ threadId, usage }));

  const latestSessionMtimeMs = maxSessionMtimeMs(currentSessionStats);
  if (Number.isFinite(latestSessionMtimeMs)) {
    const latestSessionAt = new Date(latestSessionMtimeMs).toISOString();
    if (!summary.lastAt || latestSessionAt > summary.lastAt) {
      summary.lastAt = latestSessionAt;
    }
  }

  return summary;
}

async function codexSessionStatsForThreadIds(threadIds) {
  const stats = [];
  const seen = new Set();
  for (const threadId of threadIds ?? []) {
    if (!threadId || seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    const files = await findCodexSessionFiles(threadId);
    for (const filePath of files.sort()) {
      try {
        const stat = await fs.stat(filePath);
        stats.push({
          threadId,
          file: path.basename(filePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return stats.sort((left, right) =>
    left.threadId.localeCompare(right.threadId) ||
    left.file.localeCompare(right.file));
}

function maxSessionMtimeMs(stats) {
  let max = null;
  for (const entry of stats ?? []) {
    const value = Number(entry?.mtimeMs);
    if (Number.isFinite(value)) {
      max = max == null ? value : Math.max(max, value);
    }
  }
  return max;
}

function cacheSessionStatsMatch(cachedStats, currentStats) {
  const cached = Array.isArray(cachedStats) ? cachedStats : [];
  const current = Array.isArray(currentStats) ? currentStats : [];
  if (cached.length !== current.length) {
    return false;
  }
  for (let index = 0; index < current.length; index += 1) {
    const left = cached[index];
    const right = current[index];
    if (
      left?.threadId !== right.threadId ||
      left?.file !== right.file ||
      Number(left?.size) !== right.size ||
      Math.abs(Number(left?.mtimeMs) - right.mtimeMs) >= 0.001
    ) {
      return false;
    }
  }
  return true;
}

function cachePrecisionSatisfies(cachedPrecision, requestedPrecision) {
  if (cachedPrecision === "full") {
    return true;
  }
  return cachedPrecision === requestedPrecision;
}

function normalizeRunUsageSummary(raw, stat, fileBase) {
  const seenThreadIds = new Set();
  const threadIds = [];
  for (const threadId of raw?.threadIds ?? []) {
    if (typeof threadId !== "string" || !threadId || seenThreadIds.has(threadId)) {
      continue;
    }
    seenThreadIds.add(threadId);
    threadIds.push(threadId);
  }

  const threadUsages = [];
  const seenThreadUsageIds = new Set();
  for (const entry of raw?.threadUsages ?? []) {
    const threadId = entry?.threadId;
    const usage = normalizeUsage(entry?.usage);
    if (
      typeof threadId !== "string" ||
      !threadId ||
      seenThreadUsageIds.has(threadId) ||
      !hasTokenUsage(usage)
    ) {
      continue;
    }
    seenThreadUsageIds.add(threadId);
    if (!seenThreadIds.has(threadId)) {
      seenThreadIds.add(threadId);
      threadIds.push(threadId);
    }
    threadUsages.push({ threadId, usage });
  }

  const unthreadedUsage = normalizeUsage(raw?.unthreadedUsage);
  return {
    fileBase: typeof raw?.fileBase === "string" && raw.fileBase ? raw.fileBase : fileBase,
    threadIds,
    threadUsages,
    unthreadedUsage: hasTokenUsage(unthreadedUsage) ? unthreadedUsage : null,
    firstAt: typeof raw?.firstAt === "string" ? raw.firstAt : null,
    lastAt: typeof raw?.lastAt === "string" ? raw.lastAt : null,
    durationMs: Number.isFinite(raw?.durationMs) ? Math.max(0, raw.durationMs) : 0,
    turnDurations: normalizeTurnDurationEntries(raw?.turnDurations),
    turnUsages: normalizeTurnUsageEntries(raw?.turnUsages),
    mtime: stat.mtime.toISOString(),
  };
}

function normalizeTurnDurationEntries(rawEntries) {
  const entries = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    const turnNumber = Number(raw?.turnNumber);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0 || seen.has(turnNumber)) {
      continue;
    }
    const durationMs = Number(raw?.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      continue;
    }
    seen.add(turnNumber);
    entries.push({
      turnNumber,
      durationMs: Math.max(0, durationMs),
      firstAt: typeof raw?.firstAt === "string" ? raw.firstAt : null,
      lastAt: typeof raw?.lastAt === "string" ? raw.lastAt : null,
    });
  }
  return entries.sort((left, right) => left.turnNumber - right.turnNumber);
}

function eventTimeBounds(events, options = {}) {
  let firstAt = null;
  let lastAt = null;
  const timedEvents = [];
  for (const event of events) {
    const recordedAt = event.recordedAt ?? null;
    const time = Date.parse(recordedAt ?? "");
    if (!recordedAt || !Number.isFinite(time)) {
      continue;
    }
    timedEvents.push({ ...event, time });
    if (!firstAt || recordedAt < firstAt) {
      firstAt = recordedAt;
    }
    if (!lastAt || recordedAt > lastAt) {
      lastAt = recordedAt;
    }
  }
  const durationMs = activeEventDurationMs(timedEvents, options);
  return { firstAt, lastAt, durationMs };
}

function activeEventDurationMs(timedEvents, options = {}) {
  const includeOpenCommandTail = options.includeOpenCommandTail === true;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const events = [...timedEvents].sort((a, b) => a.time - b.time);
  let durationMs = 0;
  let openCommands = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (isTimedWorkStartEvent(event)) {
      openCommands += 1;
    } else if (isTimedWorkEndEvent(event)) {
      openCommands = Math.max(0, openCommands - 1);
    }

    const next = events[i + 1];
    if (!next) {
      continue;
    }
    const gap = Math.max(0, next.time - event.time);
    if (openCommands > 0 || gap <= ACTIVE_EVENT_GAP_MS) {
      durationMs += gap;
    }
  }
  const last = events.at(-1);
  if (includeOpenCommandTail && openCommands > 0 && last) {
    durationMs += Math.max(0, nowMs - last.time);
  }

  return durationMs;
}

function turnExecutionDurationMs(events, sessionTiming = new Map(), options = {}) {
  return turnExecutionDurationEntries(events, sessionTiming, options)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
}

function turnExecutionDurationEntries(events, sessionTiming = new Map(), options = {}) {
  const fallbackDurations = ralphEventTurnDurationFallbacks(events, options);
  const limitWaitsByAttempt = limitWaitsByRawTurnAttempt(events);
  const attemptDurations = new Map();
  for (const [attemptKey, timing] of sessionTiming.entries()) {
    let attemptDurationMs = 0;
    if (timing?.durationMs > 0) {
      attemptDurationMs = Math.max(attemptDurationMs, timing.durationMs);
    }
    if (timing?.goalTimeUsedMs > 0) {
      attemptDurationMs = Math.max(
        attemptDurationMs,
        subtractLimitWaitOverlap(
          timing.goalTimeUsedMs,
          timing.sessionFirstMs,
          timing.sessionLastMs,
          limitWaitsByAttempt.get(attemptKey),
        ),
      );
    }
    if (timing?.sessionActiveMs > 0) {
      attemptDurationMs = Math.max(
        attemptDurationMs,
        subtractLimitWaitOverlap(
          timing.sessionActiveMs,
          timing.sessionFirstMs,
          timing.sessionLastMs,
          limitWaitsByAttempt.get(attemptKey),
        ),
      );
    }
    const fallbackMs = fallbackDurations.get(attemptKey) ?? 0;
    if (attemptDurationMs > 0 && timing?.hasTaskComplete) {
      attemptDurations.set(attemptKey, attemptDurationMs);
    } else if (attemptDurationMs > 0) {
      attemptDurations.set(attemptKey, Math.max(attemptDurationMs, fallbackMs));
    } else if (fallbackDurations.has(attemptKey)) {
      attemptDurations.set(attemptKey, fallbackMs);
    }
  }
  for (const [attemptKey, fallbackMs] of fallbackDurations.entries()) {
    if (!attemptDurations.has(attemptKey)) {
      attemptDurations.set(attemptKey, fallbackMs);
    }
  }
  const boundsByTurn = turnTimeBounds(events);
  const byTurn = new Map();
  for (const [attemptKey, durationMs] of attemptDurations.entries()) {
    const turnNumber = Number(String(attemptKey).split("\0", 1)[0]);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0 || durationMs <= 0) {
      continue;
    }
    byTurn.set(turnNumber, (byTurn.get(turnNumber) ?? 0) + durationMs);
  }
  return [...byTurn.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([turnNumber, durationMs]) => ({
      turnNumber,
      durationMs,
      firstAt: boundsByTurn.get(turnNumber)?.firstAt ?? null,
      lastAt: boundsByTurn.get(turnNumber)?.lastAt ?? null,
    }));
}

function turnTimeBounds(events) {
  const bounds = new Map();
  for (const event of events) {
    if (!isTurnTimingActivityEvent(event)) {
      continue;
    }
    const turnNumber = event?.turnNumber;
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      continue;
    }
    const recordedAt = event.recordedAt ?? null;
    const time = Date.parse(recordedAt ?? "");
    if (!recordedAt || !Number.isFinite(time)) {
      continue;
    }
    const entry = bounds.get(turnNumber) ?? { firstAt: recordedAt, lastAt: recordedAt };
    if (recordedAt < entry.firstAt) {
      entry.firstAt = recordedAt;
    }
    if (recordedAt > entry.lastAt) {
      entry.lastAt = recordedAt;
    }
    bounds.set(turnNumber, entry);
  }
  return bounds;
}

function ralphEventTurnDurationFallbacks(events, options = {}) {
  const includeOpenCommandTail = options.includeOpenCommandTail === true;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const attempts = buildRawTurnAttemptWindows(events);
  const spansByAttempt = new Map();
  const limitWaitsByAttempt = new Map();
  const openCommandsByAttempt = new Map();
  let latestEventTime = -Infinity;
  const latestAttemptKeys = new Set();
  for (const event of events) {
    const turn = event.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const time = Date.parse(event.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    const attemptKey = attempt?.key ?? String(turn);
    if (isLimitWaitEvent(event)) {
      const waitMs = Number(event.event?.wait_ms ?? 0);
      if (Number.isFinite(waitMs) && waitMs > 0) {
        const waits = limitWaitsByAttempt.get(attemptKey) ?? [];
        waits.push({ startMs: time, durationMs: waitMs });
        limitWaitsByAttempt.set(attemptKey, waits);
      }
    }
    if (!isTurnTimingActivityEvent(event)) {
      continue;
    }
    const key = attemptKey;
    if (time > latestEventTime) {
      latestEventTime = time;
      latestAttemptKeys.clear();
      latestAttemptKeys.add(key);
    } else if (time === latestEventTime) {
      latestAttemptKeys.add(key);
    }
    const span = spansByAttempt.get(key) ?? {
      attemptKey,
      first: time,
      last: time,
    };
    span.first = Math.min(span.first, time);
    span.last = Math.max(span.last, time);
    spansByAttempt.set(key, span);
    if (isTimedWorkStartEvent(event)) {
      openCommandsByAttempt.set(key, (openCommandsByAttempt.get(key) ?? 0) + 1);
    } else if (isTimedWorkEndEvent(event)) {
      openCommandsByAttempt.set(key, Math.max(0, (openCommandsByAttempt.get(key) ?? 0) - 1));
    }
  }
  if (includeOpenCommandTail) {
    for (const [key, openCommands] of openCommandsByAttempt.entries()) {
      if (openCommands <= 0 || !latestAttemptKeys.has(key)) {
        continue;
      }
      const span = spansByAttempt.get(key);
      if (span) {
        span.last = Math.max(span.last, nowMs);
      }
    }
  }

  const durations = new Map();
  for (const span of spansByAttempt.values()) {
    const durationMs = subtractLimitWaitOverlap(
      Math.max(0, span.last - span.first),
      span.first,
      span.last,
      limitWaitsByAttempt.get(span.attemptKey),
    );
    durations.set(span.attemptKey, (durations.get(span.attemptKey) ?? 0) + durationMs);
  }
  return durations;
}

function isTurnTimingActivityEvent(event) {
  const type = String(event?.eventType ?? "");
  return type === "ralph.prompt" ||
    type === "thread.started" ||
    type === "codex.session.token_count" ||
    type === "codex.task_complete" ||
    type.startsWith("item.") ||
    type.startsWith("turn.");
}

function limitWaitsByRawTurnAttempt(events) {
  const attempts = buildRawTurnAttemptWindows(events);
  const waitsByAttempt = new Map();
  for (const event of events) {
    if (!isLimitWaitEvent(event)) {
      continue;
    }
    const turn = event.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const time = Date.parse(event.recordedAt ?? "");
    const waitMs = Number(event.event?.wait_ms ?? 0);
    if (!Number.isFinite(time) || !Number.isFinite(waitMs) || waitMs <= 0) {
      continue;
    }
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    const attemptKey = attempt?.key ?? String(turn);
    const waits = waitsByAttempt.get(attemptKey) ?? [];
    waits.push({ startMs: time, durationMs: waitMs });
    waitsByAttempt.set(attemptKey, waits);
  }
  return waitsByAttempt;
}

function subtractLimitWaitOverlap(durationMs, spanStartMs, spanEndMs, waits) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(waits) || !waits.length) {
    return Math.max(0, durationMs || 0);
  }
  if (!Number.isFinite(spanStartMs) || !Number.isFinite(spanEndMs) || spanEndMs <= spanStartMs) {
    return Math.max(0, durationMs);
  }
  let waitedMs = 0;
  for (const wait of waits) {
    const waitStartMs = Number(wait?.startMs);
    const waitDurationMs = Number(wait?.durationMs);
    if (!Number.isFinite(waitStartMs) || !Number.isFinite(waitDurationMs) || waitDurationMs <= 0) {
      continue;
    }
    const start = Math.max(spanStartMs, waitStartMs);
    const end = Math.min(spanEndMs, waitStartMs + waitDurationMs);
    waitedMs += Math.max(0, end - start);
  }
  return Math.max(0, durationMs - waitedMs);
}

function isLimitWaitEvent(event) {
  return event?.eventType === "claude.limit_wait" || event?.eventType === "ralph.limit_wait";
}

function isCommandStartEvent(event) {
  return event.eventType === "item.started" &&
    event.event?.item?.type === "command_execution";
}

function isCommandEndEvent(event) {
  return event.eventType === "item.completed" &&
    event.event?.item?.type === "command_execution";
}

function isTimedWorkStartEvent(event) {
  return isCommandStartEvent(event) ||
    (event.eventType === "item.started" && event.event?.item?.type === "subagent");
}

function isTimedWorkEndEvent(event) {
  return isCommandEndEvent(event) ||
    (event.eventType === "item.completed" && event.event?.item?.type === "subagent");
}

async function readCodexThreadTiming(threadIds, resolveTurn) {
  const timingByTurn = new Map();
  for (const threadId of threadIds) {
    const files = await findCodexSessionFiles(threadId);
    for (const filePath of files.sort()) {
      await readCodexSessionTimingIntoTurns(filePath, resolveTurn, timingByTurn, threadId);
    }
  }
  return timingByTurn;
}

async function readCodexSessionTimingIntoTurns(filePath, resolveTurn, timingByTurn, threadId = null) {
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (
      !line.includes('"type":"token_count"') &&
      !line.includes('"type":"task_complete"') &&
      !line.includes('"type":"thread_goal_updated"')
    ) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }

    const time = Date.parse(record.timestamp ?? "");
    const resolvedTurn = resolveTurn(record.timestamp, threadId);
    const turn = typeof resolvedTurn === "object" ? resolvedTurn?.turnNumber : resolvedTurn;
    const attemptKey = typeof resolvedTurn === "object"
      ? resolvedTurn?.attemptKey
      : Number.isInteger(turn)
        ? String(turn)
        : null;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const key = attemptKey ?? String(turn);
    const timing = timingByTurn.get(key) ?? {
      turnNumber: turn,
      attemptKey: key,
      durationMs: 0,
      hasTaskComplete: false,
      goalTimeUsedMs: 0,
      sessionFirstMs: null,
      sessionLastMs: null,
      sessionActiveMs: 0,
      sessionLastActivityMs: null,
    };
    if (Number.isFinite(time)) {
      timing.sessionFirstMs = timing.sessionFirstMs == null ? time : Math.min(timing.sessionFirstMs, time);
      timing.sessionLastMs = timing.sessionLastMs == null ? time : Math.max(timing.sessionLastMs, time);
      if (timing.sessionLastActivityMs != null) {
        const gap = time - timing.sessionLastActivityMs;
        if (gap >= 0 && gap <= ACTIVE_EVENT_GAP_MS) {
          timing.sessionActiveMs += gap;
        }
      }
      timing.sessionLastActivityMs = time;
    }

    if (record.type === "event_msg" && record.payload?.type === "task_complete") {
      const durationMs = Number(record.payload.duration_ms ?? 0);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        timing.durationMs += durationMs;
        timing.hasTaskComplete = true;
      }
    } else if (record.type === "event_msg" && record.payload?.type === "thread_goal_updated") {
      const timeUsedSeconds = Number(record.payload.goal?.timeUsedSeconds ?? 0);
      if (Number.isFinite(timeUsedSeconds) && timeUsedSeconds > 0) {
        timing.goalTimeUsedMs = Math.max(timing.goalTimeUsedMs, timeUsedSeconds * 1000);
      }
    }
    timingByTurn.set(key, timing);
  }
}

async function readCodexThreadUsage(threadId, mode = "full") {
  if (mode === "fast") {
    return readCodexThreadUsageFast(threadId);
  }

  const files = await findCodexSessionFiles(threadId);
  let total = emptyUsage();
  let previous = null;

  for (const filePath of files) {
    const lines = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.includes('"type":"token_count"')) {
        continue;
      }
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

async function readCodexThreadUsageByTurn(threadIds, resolveTurn) {
  const totalsByTurn = new Map();
  for (const threadId of threadIds ?? []) {
    if (!threadId) {
      continue;
    }
    const files = await findCodexSessionFiles(threadId);
    let previous = null;
    for (const filePath of files.sort()) {
      previous = await readCodexSessionUsageIntoTurns(filePath, resolveTurn, totalsByTurn, previous, threadId);
    }
  }
  return normalizeTurnUsageEntries([...totalsByTurn.entries()].map(([turnNumber, usage]) => ({
    turnNumber,
    usage,
  })));
}

async function readCodexSessionUsageIntoTurns(filePath, resolveTurn, totalsByTurn, previousUsage, threadId = null) {
  let previous = previousUsage;
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.includes('"type":"token_count"')) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const current = record?.type === "event_msg" && record.payload?.type === "token_count"
      ? normalizeUsage(record.payload.info?.total_token_usage)
      : null;
    if (!hasTokenUsage(current)) {
      continue;
    }
    const resolvedTurn = resolveTurn(record.timestamp, threadId);
    const turn = typeof resolvedTurn === "object" ? resolvedTurn?.turnNumber : resolvedTurn;
    const delta = usageDelta(current, previous);
    previous = current;
    if (!Number.isInteger(turn) || turn <= 0 || !hasTokenUsage(delta)) {
      continue;
    }
    totalsByTurn.set(turn, addUsage(totalsByTurn.get(turn), delta));
  }
  return previous;
}

async function readCodexThreadUsageFast(threadId) {
  const files = await findCodexSessionFiles(threadId);
  let total = emptyUsage();
  for (const filePath of files) {
    const usage = await readLatestCodexTokenUsage(filePath);
    if (hasTokenUsage(usage)) {
      total = addUsage(total, usage);
    }
  }
  return hasTokenUsage(total) ? total : null;
}

async function readLatestCodexTokenUsage(filePath) {
  const stat = await fs.stat(filePath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = CODEX_USAGE_FILE_CACHE.get(filePath);
  if (cached?.cacheKey === cacheKey) {
    return cached.usage;
  }

  if (cached && stat.size > cached.fileSize) {
    const appended = await readFileSlice(filePath, cached.fileSize, stat.size);
    const split = splitCompleteSessionLines((cached.trailingText ?? "") + appended);
    const usage = latestCodexTokenUsageFromLines(split.lines) ?? cached.usage;
    CODEX_USAGE_FILE_CACHE.set(filePath, {
      cacheKey,
      fileSize: stat.size,
      trailingText: split.trailingText,
      usage,
    });
    return usage;
  }

  const usage = await readLatestCodexTokenUsageUncached(filePath, stat.size);
  CODEX_USAGE_FILE_CACHE.set(filePath, {
    cacheKey,
    fileSize: stat.size,
    trailingText: "",
    usage,
  });
  return usage;
}

function latestCodexTokenUsageFromLines(lines) {
  for (let index = (lines?.length ?? 0) - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"type":"token_count"')) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const usage = normalizeUsage(record?.payload?.info?.total_token_usage);
      if (hasTokenUsage(usage)) {
        return usage;
      }
    } catch (_) {}
  }
  return null;
}

async function readLatestCodexTokenUsageUncached(filePath, fileSize) {
  if (!fileSize) {
    return null;
  }

  const handle = await fs.open(filePath, "r");
  let position = fileSize;
  let tail = "";
  let bytesReadTotal = 0;
  try {
    while (position > 0 && bytesReadTotal < CODEX_FAST_USAGE_TAIL_BYTES) {
      const length = Math.min(
        CODEX_TAIL_SESSION_CHUNK_BYTES,
        position,
        CODEX_FAST_USAGE_TAIL_BYTES - bytesReadTotal,
      );
      position -= length;
      bytesReadTotal += length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      tail = buffer.toString("utf8") + tail;

      const lines = tail.split(/\r?\n/);
      const completeLines = position > 0 ? lines.slice(1) : lines;
      for (let index = completeLines.length - 1; index >= 0; index -= 1) {
        const line = completeLines[index];
        if (!line.includes('"type":"token_count"')) {
          continue;
        }
        try {
          const record = JSON.parse(line);
          const usage = normalizeUsage(record?.payload?.info?.total_token_usage);
          if (hasTokenUsage(usage)) {
            return usage;
          }
        } catch (_) {
          // The first line of a chunk can be partial; keep expanding backward.
        }
      }
    }
  } finally {
    await handle.close();
  }
  return null;
}

function usageFromVizEvents(events) {
  const tokenRecords = events
    .filter((event) => event.eventType === "codex.session.token_count" && event.event?.usage)
    .sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
  if (tokenRecords.length) {
    let total = emptyUsage();
    const previousByThread = new Map();
    for (const record of tokenRecords) {
      const usage = normalizeUsage(record.event.usage);
      if (!hasTokenUsage(usage)) {
        continue;
      }
      const threadId = eventThreadId(record) ?? "";
      if (isUsageBaselineRecord(record)) {
        previousByThread.set(threadId, usage);
        continue;
      }
      const previous = previousByThread.get(threadId) ?? null;
      total = addUsage(total, usageDelta(usage, previous));
      previousByThread.set(threadId, usage);
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
  const costUsd = Number(usage.cost_usd ?? usage.total_cost_usd) || 0;
  return {
    input_tokens: Math.max(0, input),
    cached_input_tokens: Math.max(0, cached),
    output_tokens: Math.max(0, output),
    reasoning_output_tokens: Math.max(0, reasoning),
    total_tokens: Math.max(0, totalTokens),
    cost_usd: Math.max(0, costUsd),
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
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
    cost_usd: (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
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
    cost_usd: Math.max(0, (a.cost_usd ?? 0) - (b.cost_usd ?? 0)),
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
  return a.total_tokens * 2 < b.total_tokens;
}

function usageWithCompletedCost(liveUsage, completedUsage) {
  const live = normalizeUsage(liveUsage);
  const completed = normalizeUsage(completedUsage);
  if (!hasTokenUsage(live)) {
    return completed;
  }
  if (completed?.cost_usd > 0 && sameTokenUsage(live, completed)) {
    return { ...live, cost_usd: completed.cost_usd };
  }
  return live;
}

function sameTokenUsage(left, right) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  return Boolean(
    a &&
      b &&
      a.input_tokens === b.input_tokens &&
      a.cached_input_tokens === b.cached_input_tokens &&
      a.output_tokens === b.output_tokens &&
      a.reasoning_output_tokens === b.reasoning_output_tokens &&
      a.total_tokens === b.total_tokens,
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
  const existingStages = new Map(
    (Array.isArray(existingStatus.stages) ? existingStatus.stages : [])
      .filter((stage) => typeof stage?.name === "string")
      .map((stage) => [stage.name, stage]),
  );
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
    const existingStage = existingStages.get(stage.name);
    const existingTotal = finitePositiveNumber(existingStage?.total);
    const status = allTestsPassed ? "pass" : failed > 0 ? "fail" : index < failingIndex ? "pass" : "unknown";
    const total = existingTotal ?? 0;
    const passed = inferDerivedStagePassed({
      status,
      failed,
      total,
      existingPassed: existingStage?.passed,
    });
    return {
      name: stage.name,
      status,
      passed,
      total,
      failed,
      timeouts: failureLines.filter((line) => classifyFailureLine(line) === "timeout").length,
      timeoutExpectations: failureLines.filter((line) => classifyFailureLine(line) === "timeout_expected").length,
      targets: Array.isArray(existingStage?.targets) ? existingStage.targets : [],
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

function inferDerivedStagePassed({ status, failed, total, existingPassed }) {
  if (!Number.isFinite(total) || total <= 0) {
    return Number.isFinite(existingPassed) ? Math.max(0, existingPassed) : 0;
  }
  if (status === "pass") {
    return total;
  }
  if (failed > 0) {
    return Math.max(0, Math.min(total, total - failed));
  }
  if (Number.isFinite(existingPassed)) {
    return Math.max(0, Math.min(total, existingPassed));
  }
  return 0;
}

async function augmentSliceMetadataForRun(events, shape) {
  const metadata = await loadSliceMetadataForShape(shape);
  if (metadata) {
    for (const record of events) {
      augmentSliceMetadataRecord(record, metadata);
    }
  }
  augmentObservedSliceMetadata(events);
}

// Older run logs did not persist slice ordinal data, so viz mirrors Ralph's
// subset discovery to label those logs without rewriting run history.
async function loadSliceMetadataForShape(shape) {
  if (!/^[a-zA-Z0-9._-]+$/.test(shape ?? "")) {
    return null;
  }
  if (!SLICE_METADATA_CACHE.has(shape)) {
    SLICE_METADATA_CACHE.set(shape, discoverSliceMetadataForShape(shape).catch((error) => {
      console.warn(`failed to discover slice metadata for ${shape}:`, error?.message ?? error);
      return null;
    }));
  }
  return SLICE_METADATA_CACHE.get(shape);
}

async function discoverSliceMetadataForShape(shape) {
  const descriptors = await discoverRalphConfigDescriptors();
  const exact = descriptors.find((descriptor) => descriptor.runName === shape);
  const prefixMatches = descriptors.filter((descriptor) => shape.startsWith(`${descriptor.namePart}-`));
  const descriptor = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);
  if (!descriptor || descriptor.driverMode !== "slice") {
    return null;
  }

  const stageNames = await sliceDiscoverStageNames(descriptor.workdir);
  const subsetsByStage = new Map();
  for (const stage of stageNames) {
    let subsets = sliceConfiguredSubsetsForStage(descriptor.testSubsets, stage);
    if (!subsets.length && descriptor.autoTestSubsets) {
      subsets = await sliceDiscoverStageAutoTestSubsets(descriptor.workdir, stage, descriptor);
    }
    if (subsets.length) {
      subsetsByStage.set(stage, subsets);
    }
  }

  return {
    shape,
    configPath: descriptor.configPath,
    workdir: descriptor.workdir,
    subsetsByStage,
  };
}

async function discoverRalphConfigDescriptors() {
  let entries;
  try {
    entries = await fs.readdir(ROOT_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const configPaths = entries
    .filter((entry) => entry.isFile() && (entry.name === "ralph.config.json" || entry.name.endsWith(".config.json")))
    .map((entry) => path.join(ROOT_DIR, entry.name));
  const descriptors = [];
  for (const configPath of configPaths) {
    const descriptor = await readRalphConfigDescriptor(configPath);
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

async function readRalphConfigDescriptor(configPath) {
  let fileConfig;
  try {
    fileConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const provider = sliceNormalizeProvider(fileConfig.provider);
  const model = String(
    fileConfig.model ??
      (provider === "antigravity" ? RALPH_DEFAULT_ANTIGRAVITY_MODEL : RALPH_DEFAULT_MODEL),
  );
  const reasoningEffort = String(fileConfig.reasoningEffort ?? RALPH_DEFAULT_REASONING_EFFORT);
  const name = String(
    fileConfig.name ??
      sliceDeriveLegacyName(fileConfig.workdir) ??
      RALPH_DEFAULT_NAME,
  );
  const namePart = sliceSanitizeRunNamePart(name);
  const runName = [
    namePart,
    sliceSanitizeRunNamePart(model),
    sliceSanitizeRunNamePart(reasoningEffort),
  ].join("-");
  const baseDir = path.resolve(
    ROOT_DIR,
    fileConfig.baseDir ??
      sliceDeriveLegacyBaseDir(fileConfig.workdir) ??
      "/work",
  );
  const workdir = fileConfig.workdir
    ? path.resolve(ROOT_DIR, String(fileConfig.workdir))
    : path.join(baseDir, runName);

  return {
    configPath,
    namePart,
    runName,
    workdir,
    driverMode: String(fileConfig.driverMode ?? "standard").trim().toLowerCase(),
    testSubsets: sliceNormalizeTestSubsets(fileConfig.testSubsets),
    autoTestSubsets: sliceParseBoolean(fileConfig.autoTestSubsets, false),
    autoTestSubsetThreshold: sliceParseNonNegativeInt(
      fileConfig.autoTestSubsetThreshold,
      RALPH_DEFAULT_AUTO_TEST_SUBSET_THRESHOLD,
    ),
    autoTestSubsetMaxFiles: sliceParseNonNegativeInt(
      fileConfig.autoTestSubsetMaxFiles,
      RALPH_DEFAULT_AUTO_TEST_SUBSET_MAX_FILES,
    ),
    autoTestSubsetTargetFiles: sliceParseNonNegativeInt(
      fileConfig.autoTestSubsetTargetFiles,
      RALPH_DEFAULT_AUTO_TEST_SUBSET_TARGET_FILES,
    ),
  };
}

function augmentSliceMetadataRecord(record, metadata) {
  const status = record.event?.phaseStatus;
  if (status) {
    augmentSliceMetadataObject(status, metadata);
    for (const check of status.checks ?? []) {
      augmentSliceMetadataObject(check, metadata);
      if (check.testStatus) {
        augmentSliceMetadataObject(check.testStatus, metadata);
      }
    }
    if (status.testStatus) {
      augmentSliceMetadataObject(status.testStatus, metadata);
    }
  }
  const testStatus = record.event?.testStatus;
  if (testStatus) {
    augmentSliceMetadataObject(testStatus, metadata);
  }
}

function augmentSliceMetadataObject(target, metadata) {
  const stage = sliceTargetStage(target);
  const subset = sliceTargetSubset(target);
  const info = lookupSliceInfo(metadata, stage, subset);
  applySliceInfo(target, info);
}

function lookupSliceInfo(metadata, stageName, subsetName) {
  const stage = sliceNormalizeStageName(stageName);
  const subset = sliceNormalizeSubset(subsetName);
  if (!stage) {
    return null;
  }
  const subsets = metadata.subsetsByStage.get(stage) ?? [];
  if (!subsets.length) {
    return null;
  }
  if (!subset) {
    return { sliceCount: subsets.length, sliceSource: "config" };
  }
  const requiredSubset = sliceRequiredAutoTestSubset(subset);
  const normalizedSubset = sliceNormalizeSubsetForCompare(requiredSubset || subset);
  const index = subsets.findIndex((candidate) =>
    sliceNormalizeSubsetForCompare(candidate) === normalizedSubset);
  if (index >= 0) {
    return { sliceIndex: index + 1, sliceCount: subsets.length, sliceSource: "config" };
  }
  const requestedPatterns = sliceSplitSubsetPatterns(requiredSubset || subset);
  const containingIndex = subsets.findIndex((candidate) => {
    const candidatePatterns = sliceSplitSubsetPatterns(candidate);
    return requestedPatterns.length > 0 &&
      requestedPatterns.every((pattern) => candidatePatterns.includes(pattern));
  });
  return containingIndex >= 0
    ? { sliceIndex: containingIndex + 1, sliceCount: subsets.length, sliceSource: "config" }
    : null;
}

function applySliceInfo(target, info) {
  if (!target || !info) {
    return;
  }
  if (!slicePositiveInteger(target.sliceIndex) && info.sliceIndex) {
    target.sliceIndex = info.sliceIndex;
  }
  if (!slicePositiveInteger(target.sliceCount) && info.sliceCount) {
    target.sliceCount = info.sliceCount;
  }
  if (!target.sliceSource && info.sliceSource) {
    target.sliceSource = info.sliceSource;
  }
}

function augmentObservedSliceMetadata(events) {
  const observed = new Map();
  for (const record of events) {
    const status = record.event?.phaseStatus;
    const stage = sliceTargetStage(status);
    const subset = sliceTargetSubset(status);
    if (!stage || !subset) {
      continue;
    }
    const stageMap = observed.get(stage) ?? new Map();
    const key = sliceNormalizeSubsetForCompare(subset);
    if (!stageMap.has(key)) {
      stageMap.set(key, stageMap.size + 1);
    }
    observed.set(stage, stageMap);
  }

  for (const record of events) {
    const status = record.event?.phaseStatus;
    const stage = sliceTargetStage(status);
    const subset = sliceTargetSubset(status);
    if (!stage || !subset || slicePositiveInteger(status?.sliceIndex)) {
      continue;
    }
    const stageMap = observed.get(stage);
    const index = stageMap?.get(sliceNormalizeSubsetForCompare(subset));
    if (!index) {
      continue;
    }
    status.sliceIndex = index;
    status.observedSliceCount = stageMap.size;
    status.sliceSource = status.sliceSource ?? "observed";
  }
}

function sliceTargetStage(target) {
  return sliceNormalizeStageName(
    target?.stage ??
      target?.targetStage ??
      target?.testStatus?.targetStage ??
      target?.primaryCheck?.targetStage,
  );
}

function sliceTargetSubset(target) {
  return sliceNormalizeSubset(
    target?.subset ??
      target?.targetSubset ??
      target?.testStatus?.targetSubset ??
      target?.primaryCheck?.targetSubset,
  );
}

async function sliceDiscoverStageNames(workdir) {
  let entries;
  try {
    entries = await fs.readdir(workdir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const experimentalStages = await sliceReadExperimentalStageNames(workdir);
  return entries
    .filter((entry) => entry.isDirectory() && /^pa\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((stage) => !experimentalStages.has(stage))
    .sort(sliceCompareStageNames);
}

async function sliceDiscoverStageAutoTestSubsets(workdir, stage, options) {
  const stageDir = path.join(workdir, stage);
  const testsDir = path.join(stageDir, "tests");
  const testPaths = (await sliceListTestFiles(testsDir))
    .filter((filePath) => sliceIsRequiredAutoTestFile(testsDir, filePath));
  const courseDir = path.join(stageDir, "course", stage);
  const coursePaths = (await sliceListTestFiles(courseDir))
    .filter((filePath) => sliceIsRequiredAutoTestFile(courseDir, filePath));
  const total = testPaths.length + coursePaths.length;
  if (total <= options.autoTestSubsetThreshold) {
    return [];
  }

  const groups = new Map();
  for (const filePath of testPaths) {
    const relative = path.relative(testsDir, filePath).split(path.sep).join("/");
    const directory = path.dirname(relative).replace(/^\.$/, "");
    const basename = path.basename(relative);
    const prefix = sliceTestFilePrefix(basename);
    const groupPath = directory ? `tests/${directory}/${prefix}-*.t` : `tests/${prefix}-*.t`;
    const groupFiles = groups.get(groupPath) ?? [];
    groupFiles.push(directory ? `tests/${directory}/${basename}` : `tests/${basename}`);
    groups.set(groupPath, groupFiles);
  }

  const groupEntries = [];
  for (const [groupPath, groupFiles] of groups.entries()) {
    groupEntries.push({
      path: groupPath,
      files: groupFiles.sort(sliceCompareTestSubsetNames),
    });
  }
  groupEntries.sort((left, right) => sliceCompareTestSubsetNames(left.path, right.path));
  if (coursePaths.length > 0) {
    groupEntries.push({
      path: `course/${stage}/*.t`,
      files: coursePaths.map((filePath) => path.relative(courseDir, filePath).split(path.sep).join("/")),
    });
  }

  if (options.autoTestSubsetTargetFiles > 0) {
    return sliceBatchAutoTestSubsetGroups(groupEntries, options.autoTestSubsetTargetFiles);
  }

  const result = [];
  const maxFiles = options.autoTestSubsetMaxFiles;
  for (const group of groupEntries) {
    if (maxFiles > 0 && group.files.length > 1 && group.files.length <= maxFiles) {
      result.push(...group.files);
    } else {
      result.push(group.path);
    }
  }
  return result.sort(sliceCompareTestSubsetNames);
}

function sliceBatchAutoTestSubsetGroups(groups, targetFiles) {
  const result = [];
  let currentPaths = [];
  let currentCount = 0;

  const flush = () => {
    if (!currentPaths.length) {
      return;
    }
    result.push(currentPaths.join(" "));
    currentPaths = [];
    currentCount = 0;
  };

  for (const group of groups) {
    const groupCount = Math.max(1, group.files.length);
    if (currentPaths.length > 0 && currentCount + groupCount > targetFiles) {
      flush();
    }
    currentPaths.push(group.path);
    currentCount += groupCount;
    if (currentCount >= targetFiles) {
      flush();
    }
  }
  flush();
  return result;
}

async function sliceListTestFiles(root) {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const result = [];
  await sliceCollectTestFilesRecursive(root, result);
  return result.sort();
}

function sliceIsRequiredAutoTestFile(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  return !sliceIsOptionalAutoTestPattern(relative);
}

function sliceRequiredAutoTestSubset(subsetName) {
  return sliceSplitSubsetPatterns(subsetName)
    .filter((pattern) => !sliceIsOptionalAutoTestPattern(pattern))
    .join(" ");
}

function sliceIsOptionalAutoTestPattern(pattern) {
  const segments = String(pattern ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.includes("debuginfo");
}

function sliceSplitSubsetPatterns(subsetName) {
  const subset = sliceNormalizeSubset(subsetName);
  return subset ? subset.split(/\s+/).map((entry) => entry.trim()).filter(Boolean) : [];
}

async function sliceCollectTestFilesRecursive(directory, result) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await sliceCollectTestFilesRecursive(entryPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".t")) {
      result.push(entryPath);
    }
  }
}

async function sliceReadExperimentalStageNames(workdir) {
  try {
    const makefile = await fs.readFile(path.join(workdir, "Makefile"), "utf8");
    const match = makefile.match(/^EXPERIMENTAL_PAS\s*\?=\s*(.+)$/m);
    return match
      ? new Set(match[1].split(/\s+/).map((entry) => entry.trim()).filter(Boolean))
      : new Set();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

function sliceConfiguredSubsetsForStage(testSubsets, stage) {
  if (testSubsets?.stages && Object.hasOwn(testSubsets.stages, stage)) {
    return testSubsets.stages[stage] ?? [];
  }
  return testSubsets?.default ?? [];
}

function sliceNormalizeTestSubsets(value) {
  const empty = { default: [], stages: {} };
  if (value == null || value === "") {
    return empty;
  }
  if (Array.isArray(value)) {
    return { default: sliceNormalizeTestSubsetList(value), stages: {} };
  }
  if (typeof value !== "object") {
    return empty;
  }
  const normalized = { default: [], stages: {} };
  for (const [key, rawList] of Object.entries(value)) {
    const list = sliceNormalizeTestSubsetList(rawList);
    if (key === "default" || key === "*") {
      normalized.default = list;
      continue;
    }
    const stage = sliceNormalizeStageName(key);
    if (stage) {
      normalized.stages[stage] = list;
    }
  }
  return normalized;
}

function sliceNormalizeTestSubsetList(value) {
  return Array.isArray(value)
    ? value.map((entry) => sliceNormalizeSubset(entry)).filter(Boolean)
    : [];
}

function sliceNormalizeProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  return provider === "antigravity" ? "antigravity" : "codex";
}

function sliceParseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function sliceParseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sliceDeriveLegacyName(workdir) {
  return workdir ? path.basename(path.resolve(ROOT_DIR, String(workdir))) : null;
}

function sliceDeriveLegacyBaseDir(workdir) {
  return workdir ? path.dirname(path.resolve(ROOT_DIR, String(workdir))) : null;
}

function sliceSanitizeRunNamePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function sliceNormalizeStageName(stageName) {
  return typeof stageName === "string" && /^pa\d+$/.test(stageName) ? stageName : null;
}

function sliceNormalizeSubset(subsetName) {
  if (subsetName == null) {
    return null;
  }
  const text = String(subsetName).trim();
  return text && !/[\r\n\0]/.test(text) ? text : null;
}

function sliceNormalizeSubsetForCompare(subsetName) {
  return String(subsetName ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
}

function slicePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function sliceTestFilePrefix(fileName) {
  const match = fileName.match(/^([0-9]+)-/);
  return match ? match[1] : "misc";
}

function sliceCompareStageNames(left, right) {
  return Number.parseInt(left.slice(2), 10) - Number.parseInt(right.slice(2), 10);
}

function sliceCompareTestSubsetNames(left, right) {
  const leftKey = sliceTestSubsetSortKey(left);
  const rightKey = sliceTestSubsetSortKey(right);
  if (leftKey.prefix !== rightKey.prefix) {
    return leftKey.prefix - rightKey.prefix;
  }
  return left.localeCompare(right);
}

function sliceTestSubsetSortKey(name) {
  const match = String(name).match(/\/([0-9]+)-(?:\*|[^/]+)\.t$/);
  return {
    prefix: match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER,
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

  const summary = output.match(/^===== TEST SUMMARY: (\d+)\s*\/\s*(\d+) TESTS PASSED =====$/m) ??
    output.match(/^(\d+)\s*\/\s*(\d+)\s+TESTS PASSED$/m);
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

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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

function inferThreadIdsFromRun(filePath, events) {
  const ids = [];
  const seen = new Set();
  const add = (threadId) => {
    if (typeof threadId !== "string" || !threadId || seen.has(threadId)) {
      return;
    }
    seen.add(threadId);
    ids.push(threadId);
  };

  for (const event of events) {
    add(eventThreadId(event));
  }
  add(inferThreadIdFromRun(filePath, events));
  return ids;
}

function tokenUsageThreadIdsFromEvents(events) {
  const ids = [];
  const seen = new Set();
  for (const event of events) {
    if (event.eventType !== "codex.session.token_count" || !event.event?.usage) {
      continue;
    }
    const threadId = eventThreadId(event);
    if (!threadId || seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    ids.push(threadId);
  }
  return ids;
}

function eventThreadId(event) {
  return event?.threadId ??
    event?.event?.thread_id ??
    event?.event?.threadId ??
    event?.event?.goal?.threadId ??
    null;
}

function isUsageBaselineRecord(event) {
  return event?.eventType === "codex.session.token_count" &&
    (event?.event?.baseline === true || event?._usageBaseline === true);
}

function inferThreadIdsForDetail(filePath, events, selectedWindows, detailOptions) {
  const ids = [];
  const seen = new Set();
  const add = (threadId) => {
    if (typeof threadId !== "string" || !threadId || seen.has(threadId)) {
      return;
    }
    seen.add(threadId);
    ids.push(threadId);
  };

  if (detailOptions.mode === "all") {
    events.forEach((event) => add(event.threadId));
  } else {
    for (const window of selectedWindows ?? []) {
      for (const event of events) {
        if (event.turnNumber === window.turnNumber) {
          add(event.threadId);
        }
      }
    }
  }

  if (ids.length === 0) {
    add(inferThreadIdFromRun(filePath, events));
  }
  return ids;
}

function mergeEventStreams(primary, secondary) {
  const primaryItemCardStreams = primaryItemCardStreamKeys(primary);
  const seen = new Set(primary.map(eventKey));
  const merged = [...primary];
  for (const event of secondary) {
    if (isFileChangeWithDiff(event)) {
      const fileChangeIndex = findMergeableFileChangeIndex(merged, event);
      if (fileChangeIndex >= 0) {
        merged[fileChangeIndex] = mergeFileChangeEventDiffs(merged[fileChangeIndex], event);
        seen.add(eventKey(event));
        continue;
      }
    }
    if (
      isDisplayItemCardEvent(event) &&
      !isFileChangeWithDiff(event) &&
      primaryItemCardStreams.has(eventItemCardStreamKey(event))
    ) {
      continue;
    }
    const key = eventKey(event);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
}

function findMergeableFileChangeIndex(events, candidate) {
  const candidateSignature = fileChangeEventSignature(candidate);
  if (!candidateSignature) {
    return -1;
  }
  const streamKey = eventTurnThreadKey(candidate);
  const candidateTime = Date.parse(candidate?.recordedAt ?? "");
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      eventTurnThreadKey(event) === streamKey &&
      event?.eventType === "item.completed" &&
      event?.event?.item?.type === "file_change" &&
      fileChangeEventSignature(event) === candidateSignature
    ) {
      if (isFileChangeWithDiff(event) && !fileChangeDiffsCompatible(event, candidate)) {
        continue;
      }
      const eventTime = Date.parse(event?.recordedAt ?? "");
      const distance = Number.isFinite(candidateTime) && Number.isFinite(eventTime)
        ? Math.abs(candidateTime - eventTime)
        : 0;
      if (distance > FILE_CHANGE_DIFF_MERGE_WINDOW_MS) {
        continue;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }
  return bestIndex;
}

function fileChangeDiffsCompatible(existing, candidate) {
  const existingDiffs = fileChangeDiffMap(existing);
  const candidateDiffs = fileChangeDiffMap(candidate);
  for (const [signature, existingDiff] of existingDiffs.entries()) {
    const candidateDiff = candidateDiffs.get(signature);
    if (existingDiff && candidateDiff && existingDiff !== candidateDiff) {
      return false;
    }
  }
  return true;
}

function fileChangeDiffMap(record) {
  const diffs = new Map();
  for (const change of record?.event?.item?.changes ?? []) {
    diffs.set(fileChangeSignature(change), typeof change?.diff === "string" ? change.diff : "");
  }
  return diffs;
}

function mergeFileChangeEventDiffs(existing, rich) {
  const richChanges = new Map(
    (rich?.event?.item?.changes ?? []).map((change) => [fileChangeSignature(change), change]),
  );
  const mergedChanges = (existing?.event?.item?.changes ?? []).map((change) => {
    const richChange = richChanges.get(fileChangeSignature(change));
    if (!richChange?.diff || change.diff) {
      return change;
    }
    return {
      ...change,
      diff: richChange.diff,
      raw: richChange.raw ?? change.raw,
    };
  });
  return {
    ...existing,
    event: {
      ...existing.event,
      item: {
        ...existing.event.item,
        changes: mergedChanges,
        raw: existing.event.item.raw ?? rich.event?.item?.raw,
      },
    },
  };
}

function fileChangeEventSignature(record) {
  const changes = record?.event?.item?.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return "";
  }
  return changes.map(fileChangeSignature).sort().join("|");
}

function fileChangeSignature(change) {
  return [
    change?.kind ?? "update",
    change?.path ?? "",
    change?.movePath ?? change?.move_path ?? "",
  ].join("\0");
}

function isFileChangeWithDiff(record) {
  return record?.eventType === "item.completed" &&
    record?.event?.item?.type === "file_change" &&
    Array.isArray(record.event.item.changes) &&
    record.event.item.changes.some((change) => typeof change?.diff === "string" && change.diff.length > 0);
}

function primaryItemCardStreamKeys(events) {
  const keys = new Set();
  for (const event of events ?? []) {
    if (isDisplayItemCardEvent(event)) {
      keys.add(eventItemCardStreamKey(event));
    }
  }
  return keys;
}

function eventItemCardStreamKey(record) {
  const item = record?.event?.item ?? {};
  const base = eventTurnThreadKey(record);
  if (item.type === "command_execution") {
    return [base, item.type, item.id ?? ""].join("|");
  }
  if (item.type === "agent_message" || item.type === "reasoning") {
    return [base, item.type, item.text ?? ""].join("|");
  }
  if (item.type === "file_change") {
    return [base, item.type, fileChangeEventSignature(record)].join("|");
  }
  return [base, item.type ?? "", item.id ?? ""].join("|");
}

function eventTurnThreadKey(record) {
  return [
    record?.threadId ?? "",
    Number.isInteger(record?.turnNumber) && record.turnNumber > 0 ? record.turnNumber : "setup",
  ].join("|");
}

function isDisplayItemCardEvent(record) {
  const item = record?.event?.item;
  if (!item || typeof item !== "object") {
    return false;
  }
  if (
    record?.eventType === "item.started" &&
    (item.type === "command_execution" || item.type === "todo_list")
  ) {
    return true;
  }
  if (record?.eventType === "item.updated" && item.type === "todo_list") {
    return true;
  }
  if (record?.eventType !== "item.completed") {
    return false;
  }
  return [
    "agent_message",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "reasoning",
    "todo_list",
    "web_search",
  ].includes(item.type);
}

function eventKey(record) {
  const event = record.event ?? {};
  const item = event.item ?? {};
  const progress = event.progress ?? {};
  return [
    record.recordedAt ?? "",
    record.threadId ?? "",
    record.turnNumber ?? "",
    record.eventType ?? "",
    event.type ?? "",
    item.id ?? "",
    item.type ?? "",
    progress.stage ?? "",
    progress.passed ?? "",
    progress.total ?? "",
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

function buildWindowBackedSessionTurnResolver(selectedWindows, fallback) {
  const windows = (selectedWindows ?? [])
    .filter((window) => Number.isInteger(window.turnNumber) && Number.isFinite(window.startTime))
    .sort((a, b) => a.startTime - b.startTime);
  return (recordedAt) => {
    const time = Date.parse(recordedAt ?? "");
    if (Number.isFinite(time)) {
      for (const window of windows) {
        const endTime = Number.isFinite(window.endTime) ? window.endTime : Infinity;
        if (time >= window.startTime && time < endTime) {
          return window.turnNumber;
        }
      }
    }
    return fallback(recordedAt);
  };
}

function buildSessionTurnAttemptResolver(events) {
  const attempts = buildRawTurnAttemptWindows(events);
  const byThread = new Map();

  for (const event of events) {
    const threadId = eventThreadId(event);
    if (!threadId) {
      continue;
    }
    const turn = event.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const time = Date.parse(event.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    if (!attempt) {
      continue;
    }
    const entries = byThread.get(threadId) ?? [];
    if (!entries.some((entry) => entry.key === attempt.key)) {
      entries.push({
        turnNumber: attempt.turnNumber,
        attemptKey: attempt.key,
        startTime: attempt.startTime,
      });
      entries.sort((a, b) => a.startTime - b.startTime);
      byThread.set(threadId, entries);
    }
  }

  return (recordedAt, threadId = null) => {
    const time = Date.parse(recordedAt ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }

    const entries = threadId ? byThread.get(threadId) : null;
    if (entries?.length) {
      let selected = null;
      for (const entry of entries) {
        if (entry.startTime > time) {
          break;
        }
        selected = entry;
      }
      return selected ?? entries[0];
    }

    let selected = null;
    for (const attempt of attempts) {
      if (attempt.startTime > time) {
        break;
      }
      selected = attempt;
    }
    return selected
      ? { turnNumber: selected.turnNumber, attemptKey: selected.key }
      : null;
  };
}

function buildRawTurnAttemptWindows(events) {
  const starts = events
    .filter((event) => isTurnAttemptBoundaryEvent(event) &&
      Number.isInteger(event.turnNumber) &&
      event.turnNumber > 0)
    .map((event) => ({
      turnNumber: event.turnNumber,
      startTime: Date.parse(event.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.startTime))
    .sort((a, b) => a.startTime - b.startTime);

  const countsByTurn = new Map();
  return starts.map((start, index) => {
    const attemptIndex = countsByTurn.get(start.turnNumber) ?? 0;
    countsByTurn.set(start.turnNumber, attemptIndex + 1);
    return {
      ...start,
      attemptIndex,
      endTime: starts[index + 1]?.startTime ?? Infinity,
      key: `${start.turnNumber}\0${attemptIndex}`,
    };
  });
}

function isTurnAttemptBoundaryEvent(event) {
  return event?.eventType === "ralph.turn-restart" ||
    (event?.eventType === "ralph.phase-status" && event.event?.action === "turn-start");
}

function rawTurnAttemptForTime(attempts, turnNumber, time) {
  let selected = null;
  let nextSameTurn = null;
  for (const attempt of attempts) {
    if (attempt.startTime > time) {
      if (attempt.turnNumber === turnNumber) {
        nextSameTurn = attempt;
      }
      break;
    }
    if (attempt.turnNumber === turnNumber) {
      selected = attempt;
      if (time < attempt.endTime) {
        return attempt;
      }
    }
  }
  return selected ?? nextSameTurn;
}

function defaultCodexDetailOptions() {
  return { mode: "none" };
}

function parseCodexDetailOptions(params) {
  const mode = String(params.get("codex") ?? "none").toLowerCase();
  const maxEventsPerTurn = parseOptionalBoundedInt(
    params.get("maxEventsPerTurn"),
    DEFAULT_CODEX_MAX_EVENTS_PER_TURN,
    50,
    5_000,
  );
  const outputLimit = parseOptionalBoundedInt(
    params.get("outputLimit"),
    CODEX_SESSION_OUTPUT_LIMIT,
    1_000,
    100_000,
  );
  if (mode === "none" || mode === "off" || mode === "ralph") {
    return { mode: "none" };
  }
  if (mode === "all" || mode === "full") {
    return { mode: "all", outputLimit };
  }
  if (mode === "turns" || mode === "turn") {
    return { mode: "turns", turns: parseTurnList(params.get("turns")), maxEventsPerTurn, outputLimit };
  }

  const tailTurns = Number.parseInt(params.get("tailTurns") ?? String(DEFAULT_CODEX_TAIL_TURNS), 10);
  return {
    mode: "tail",
    tailTurns: Number.isFinite(tailTurns)
      ? Math.max(1, Math.min(20, tailTurns))
      : DEFAULT_CODEX_TAIL_TURNS,
    maxEventsPerTurn,
    outputLimit,
  };
}

function normalizeUsageMode(raw) {
  const mode = String(raw ?? "fast").toLowerCase();
  if (mode === "full" || mode === "fast" || mode === "skip" || mode === "none" || mode === "off") {
    return mode === "none" || mode === "off" ? "skip" : mode;
  }
  return "fast";
}

function parseOptionalBoundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function parseTurnList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((turn) => Number.isInteger(turn) && turn > 0);
}

function buildTurnWindows(events) {
  const starts = events
    .filter((event) => event.eventType === "ralph.prompt" && Number.isInteger(event.turnNumber))
    .map((event) => ({
      turnNumber: event.turnNumber,
      time: Date.parse(event.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return starts.map((entry, index) => ({
    turnNumber: entry.turnNumber,
    startTime: entry.time,
    endTime: starts[index + 1]?.time ?? Infinity,
  }));
}

function selectTurnWindows(turnWindows, detailOptions) {
  if (detailOptions.mode === "all") {
    return [];
  }
  if (detailOptions.mode === "turns") {
    const wanted = new Set(detailOptions.turns ?? []);
    return (turnWindows ?? []).filter((window) => wanted.has(window.turnNumber));
  }
  if (detailOptions.mode === "tail") {
    const count = Math.max(1, detailOptions.tailTurns ?? DEFAULT_CODEX_TAIL_TURNS);
    return windowsForLatestDistinctTurns(turnWindows, count);
  }
  return [];
}

function windowsForLatestDistinctTurns(turnWindows, count) {
  const latestByTurn = latestWindowPerTurn(turnWindows);
  const wanted = new Set(latestByTurn.slice(-count).map((window) => window.turnNumber));
  return (turnWindows ?? []).filter((window) => wanted.has(window.turnNumber));
}

function latestWindowPerTurn(turnWindows) {
  const byTurn = new Map();
  for (const window of turnWindows ?? []) {
    const previous = byTurn.get(window.turnNumber);
    if (!previous || window.startTime > previous.startTime) {
      byTurn.set(window.turnNumber, window);
    }
  }
  return [...byTurn.values()].sort((a, b) => a.startTime - b.startTime);
}

function buildSessionReadOptions(selectedWindows, detailOptions) {
  if (detailOptions.mode === "all") {
    return {
      mode: "all",
      maxEventsPerTurn: null,
      outputLimit: detailOptions.outputLimit ?? CODEX_SESSION_OUTPUT_LIMIT,
      skipTokenCounts: false,
    };
  }
  const windows = selectedWindows
    .map((window) => ({
      turnNumber: window.turnNumber,
      startTime: window.startTime,
      endTime: window.endTime,
    }))
    .filter((window) => Number.isFinite(window.startTime))
    .sort((a, b) => a.startTime - b.startTime);
  const minTime = windows[0]?.startTime ?? Infinity;
  const finiteEnds = windows.map((window) => window.endTime).filter(Number.isFinite);
  const maxTime = finiteEnds.length === windows.length ? Math.max(...finiteEnds) : Infinity;
  return {
    mode: "windows",
    windows,
    minTime,
    maxTime,
    maxEventsPerTurn: detailOptions.maxEventsPerTurn ?? DEFAULT_CODEX_MAX_EVENTS_PER_TURN,
    outputLimit: detailOptions.outputLimit ?? CODEX_SESSION_OUTPUT_LIMIT,
    skipTokenCounts: false,
    includeTokenBaseline: true,
  };
}

function timestampIncludedBySessionReadOptions(timestamp, options) {
  if (options?.mode === "all") {
    return true;
  }
  const time = Date.parse(timestamp ?? "");
  if (!Number.isFinite(time)) {
    return false;
  }
  if (time < options.minTime || time >= options.maxTime) {
    return false;
  }
  return options.windows.some((window) => time >= window.startTime && time < window.endTime);
}

function sessionLineTimestamp(line) {
  return String(line ?? "").match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

function shouldStopSessionRead(timestamp, options) {
  if (options?.mode === "all" || !Number.isFinite(options?.maxTime)) {
    return false;
  }
  const time = Date.parse(timestamp ?? "");
  return Number.isFinite(time) && time >= options.maxTime;
}

async function readCodexSessionEvents(threadId, resolveTurnNumber, readOptions = { mode: "all" }) {
  if (readOptions?.mode === "windows" && (readOptions.windows?.length ?? 0) > 1) {
    return readCodexSessionWindowEvents(threadId, resolveTurnNumber, readOptions);
  }

  const files = await findCodexSessionFiles(threadId);
  const events = [];
  const context = buildCodexSessionReadContext(threadId, resolveTurnNumber);
  for (const filePath of files) {
    if (shouldReadCodexSessionFromTail(readOptions)) {
      events.push(...await readCachedOpenCodexSessionEvents(
        filePath,
        threadId,
        resolveTurnNumber,
        readOptions,
      ));
      continue;
    }

    const lines = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const rawLine of lines) {
      if (processCodexSessionLine(rawLine, readOptions, context, events) === "stop") {
        break;
      }
    }
  }
  return limitSessionEventsByTurn(events, readOptions.maxEventsPerTurn);
}

async function readCodexSessionWindowEvents(threadId, resolveTurnNumber, readOptions) {
  const files = await findCodexSessionFiles(threadId);
  const events = [];
  const closedWindows = (readOptions.windows ?? []).filter((window) => Number.isFinite(window.endTime));
  const openWindows = (readOptions.windows ?? []).filter((window) => !Number.isFinite(window.endTime));

  for (const filePath of files) {
    for (const window of closedWindows) {
      events.push(...await readCachedClosedCodexSessionWindow(
        filePath,
        threadId,
        resolveTurnNumber,
        readOptions,
        window,
      ));
    }

    for (const window of openWindows) {
      const windowOptions = {
        ...readOptions,
        windows: [window],
        minTime: window.startTime,
        maxTime: Infinity,
        includeTokenBaseline: closedWindows.length === 0,
      };
      events.push(...await readCodexSessionEventsFromFile(
        filePath,
        threadId,
        resolveTurnNumber,
        windowOptions,
      ));
    }
  }

  return limitSessionEventsByTurn(events, readOptions.maxEventsPerTurn);
}

async function readCodexSessionProgressEvents(threadIds, resolveTurnNumber, readOptions) {
  const events = [];
  for (const threadId of threadIds ?? []) {
    const files = await findCodexSessionFiles(threadId);
    for (const filePath of files) {
      const observations = await readCodexSessionProgressObservations(filePath);
      for (const observation of observations) {
        if (!timestampIncludedBySessionReadOptions(observation.recordedAt, readOptions)) {
          continue;
        }
        const turnNumber = resolveTurnNumber(observation.recordedAt);
        if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
          continue;
        }
        events.push({
          recordedAt: observation.recordedAt,
          threadId,
          turnNumber,
          eventType: "ralph.agent-progress",
          event: {
            type: "ralph.agent-progress",
            progress: {
              ...observation,
              commandKind: "session-cache",
              commandTarget: "cached test summary",
            },
          },
        });
      }
    }
  }
  return compactBestProgressEvents(events);
}

async function readCodexSessionProgressObservations(filePath) {
  const stat = await fs.stat(filePath);
  const cachePath = codexSessionProgressCachePath(filePath);
  const cached = cachePath ? await readCodexSessionProgressCache(cachePath, filePath) : null;
  if (cached && Number(cached.file?.size) === stat.size) {
    return cached.observations;
  }

  let observations = [];
  let startOffset = 0;
  if (cached && Number(cached.file?.size) > 0 && Number(cached.file.size) < stat.size) {
    observations = cached.observations;
    startOffset = Math.max(0, Number(cached.file.size) - CODEX_SESSION_PROGRESS_OVERLAP_BYTES);
  }

  const scanned = await scanCodexSessionProgressObservations(filePath, startOffset);
  observations = dedupeProgressObservations([...observations, ...scanned]);
  if (cachePath) {
    await writeCodexSessionProgressCache(cachePath, filePath, stat, observations);
  }
  return observations;
}

async function readCodexSessionProgressCache(cachePath, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return null;
    }
    return null;
  }
  if (
    parsed?.version !== CODEX_SESSION_PROGRESS_CACHE_VERSION ||
    parsed?.file?.path !== filePath ||
    !Array.isArray(parsed?.observations)
  ) {
    return null;
  }
  return {
    file: parsed.file,
    observations: dedupeProgressObservations(parsed.observations.map(normalizeProgressObservation).filter(Boolean)),
  };
}

async function writeCodexSessionProgressCache(cachePath, filePath, stat, observations) {
  const body = JSON.stringify({
    version: CODEX_SESSION_PROGRESS_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    file: {
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString(),
    },
    observations,
  });
  const dir = path.dirname(cachePath);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, body, "utf8");
    await fs.rename(tmpPath, cachePath);
  } catch (_) {
    try {
      await fs.unlink(tmpPath);
    } catch (_) {}
  }
}

function codexSessionProgressCachePath(filePath) {
  const key = createHash("sha256").update(filePath).digest("hex").slice(0, 24);
  return path.join(RALPH_DIR, CODEX_SESSION_PROGRESS_CACHE_DIR, `${key}.json`);
}

async function scanCodexSessionProgressObservations(filePath, startOffset = 0) {
  const observations = [];
  const callsById = new Map();
  const commandsBySessionId = new Map();
  const sessionIdsByStoreKey = new Map();
  const commandContext = { commandsBySessionId, sessionIdsByStoreKey };
  const stream = createReadStream(filePath, { encoding: "utf8", start: Math.max(0, startOffset) });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line || !line.includes('"type":"response_item"')) {
      continue;
    }
    const isFunctionCallLine =
      line.includes('"function_call"') ||
      line.includes('"custom_tool_call"') ||
      line.includes('"function_call_output"') ||
      line.includes('"custom_tool_call_output"');
    if (!isFunctionCallLine) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const payload = record.payload;
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      if (payload.call_id) {
        const args = parseFunctionCallArgs(payload);
        callsById.set(payload.call_id, {
          name: payload.name,
          args,
          command: formatFunctionCall(payload, args, commandContext),
        });
      }
      continue;
    }
    if (
      payload?.type !== "function_call_output" &&
      payload?.type !== "custom_tool_call_output"
    ) {
      continue;
    }
    const call = callsById.get(payload.call_id) ?? null;
    const parentSessionId = functionCallParentSessionId(call, commandContext);
    const parentCommand = parentSessionId ? commandsBySessionId.get(parentSessionId) : null;
    const sessionId = parseRunningSessionId(payload.output);
    if (sessionId && (parentCommand || call?.command)) {
      commandsBySessionId.set(sessionId, parentCommand ?? call.command);
    }
    const sessionStoreKey = functionCallSessionStoreKey(call);
    if (sessionId && sessionStoreKey) {
      sessionIdsByStoreKey.set(sessionStoreKey, sessionId);
    }
    if (
      !line.includes("TEST SUMMARY") &&
      !line.includes("ALL TESTS PASSED SUCCESSFULLY") &&
      !line.includes(" tests: PASS (") &&
      !line.includes(" tests: FAIL (") &&
      !line.includes(" tests: FAIL after ")
    ) {
      continue;
    }
    const command = parentCommand
      ? `${parentCommand} (continued session ${parentSessionId})`
      : call?.command ?? "";
    const observation = progressObservationFromCodexOutputRecord(record, command);
    if (observation) {
      observations.push(observation);
    }
  }
  return observations;
}

function progressObservationFromCodexOutputRecord(record, command = "") {
  if (
    record?.type !== "response_item" ||
    (record.payload?.type !== "function_call_output" &&
      record.payload?.type !== "custom_tool_call_output")
  ) {
    return null;
  }
  const output = commandOutputText(record.payload.output);
  return progressObservationFromSessionOutput(output, record.timestamp, command);
}

function progressObservationFromSessionOutput(output, recordedAt, command = "") {
  const commandInfo = parseSingleStageProgressCommand(command);
  const stage = inferSingleSessionProgressStage(output) ?? commandInfo?.stage ?? null;
  const directProgress = stage
    ? parseSingleStageProgressFromSessionOutput(output, stage)
    : null;
  if (directProgress?.total > 0) {
    return normalizeProgressObservation({
      recordedAt,
      stage,
      passed: directProgress.passed,
      total: directProgress.total,
      status: directProgress.status,
      hasSubset: commandInfo?.hasSubset === true,
    });
  }
  const summary = commandInfo?.kind === "selected"
    ? parseLastSessionTestSummary(output)
    : parseSessionTestSummary(output);
  if (!summary) {
    return null;
  }
  if (!stage) {
    return null;
  }
  const progress = parseSingleStageSummaryProgressFromSessionOutput(summary, command, stage, output);
  if (!progress || progress.total <= 0) {
    return null;
  }
  return normalizeProgressObservation({
    recordedAt,
    stage,
    passed: progress.passed,
    total: progress.total,
    status: summary.allTestsPassed && progress.status === "pass" ? "pass" : progress.status,
    hasSubset: false,
  });
}

function parseSingleStageProgressFromSessionOutput(output, expectedStage) {
  const section = parseStageSections(String(output ?? "")).find((candidate) => candidate.name === expectedStage);
  const targets = new Map();
  for (const line of (section?.body ?? String(output ?? "")).split(/\r?\n/)) {
    let match = line.match(/^(.+?): PASS \((\d+)\/(\d+)\)$/);
    if (match) {
      targets.set(match[1], {
        passed: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
        status: "pass",
      });
      continue;
    }
    match = line.match(/^(.+?): FAIL \((\d+)\/(\d+)\)$/) ??
      line.match(/^(.+?): FAIL after (\d+)\/(\d+) passed$/);
    if (match) {
      targets.set(match[1], {
        passed: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
        status: "fail",
      });
    }
  }
  const entries = [...targets.entries()];
  const aggregateEntries = entries.filter(([target]) =>
    isStageAggregateProgressTarget(target, expectedStage));
  if (!section && aggregateEntries.length === 0) {
    return null;
  }
  const nonAggregateEntries = entries.filter(([target]) =>
    !isStageAggregateProgressTarget(target, expectedStage));
  const selectedTargets = (aggregateEntries.length ? aggregateEntries : nonAggregateEntries)
    .map(([, target]) => target);
  if (selectedTargets.length === 0) {
    return null;
  }
  const passed = selectedTargets.reduce((sum, target) => sum + target.passed, 0);
  const total = selectedTargets.reduce((sum, target) => sum + target.total, 0);
  const failed = selectedTargets.some((target) => target.status === "fail");
  const allPassed = selectedTargets.every((target) => target.status === "pass");
  return {
    passed,
    total,
    status: failed ? "fail" : allPassed ? "pass" : "running",
  };
}

function parseSingleStageSummaryProgressFromSessionOutput(summary, command, expectedStage, output = "") {
  const commandInfo = parseSingleStageProgressCommand(command);
  if (!commandInfo) {
    if (!Number.isFinite(summary.testsTotal) || summary.testsTotal <= 0) {
      return null;
    }
    return {
      passed: summary.testsPassed,
      total: summary.testsTotal,
      status: summary.allTestsPassed || summary.testsPassed === summary.testsTotal ? "pass" : "fail",
    };
  }
  if (commandInfo.stage !== expectedStage || commandInfo.hasSubset) {
    return null;
  }
  if (commandInfo.kind !== "selected") {
    return null;
  }
  const outputStages = [...new Set(parseStageSections(output).map((section) => section.name))];
  if (
    outputStages.length > 0 &&
    (outputStages.length !== 1 || outputStages[0] !== expectedStage)
  ) {
    return null;
  }
  return {
    passed: summary.testsPassed,
    total: summary.testsTotal,
    status: summary.allTestsPassed || summary.testsPassed === summary.testsTotal ? "pass" : "fail",
  };
}

function isStageAggregateProgressTarget(target, stage) {
  const normalized = String(target ?? "").trim().replace(/\s+/g, " ");
  return normalized === `${stage} tests` || normalized === `${stage}/tests`;
}

function parseSessionTestSummary(output) {
  return parseSessionTestSummaries(output)[0] ?? null;
}

function parseLastSessionTestSummary(output) {
  return parseSessionTestSummaries(output).at(-1) ?? null;
}

function parseSessionTestSummaries(output) {
  const summaries = [];
  const allPassed = String(output ?? "").match(
    /^===== ALL TESTS PASSED SUCCESSFULLY!(?: \((\d+)\s*\/\s*(\d+)\))? =====$/m,
  );
  if (allPassed) {
    const testsPassed = parseOptionalInt(allPassed[1]);
    const testsTotal = parseOptionalInt(allPassed[2]);
    summaries.push({
      allTestsPassed: true,
      testsPassed: testsPassed ?? testsTotal ?? 0,
      testsTotal: testsTotal ?? testsPassed ?? 0,
    });
  }

  const summaryRegex = /^===== TEST SUMMARY: (\d+)\s*\/\s*(\d+) TESTS PASSED =====$|^(\d+)\s*\/\s*(\d+)\s+TESTS PASSED$/gm;
  let summary;
  while ((summary = summaryRegex.exec(String(output ?? ""))) !== null) {
    summaries.push({
      allTestsPassed: false,
      testsPassed: Number.parseInt(summary[1] ?? summary[3], 10),
      testsTotal: Number.parseInt(summary[2] ?? summary[4], 10),
    });
  }
  return summaries;
}

function inferSingleSessionProgressStage(output) {
  const stages = [...String(output ?? "").matchAll(/^===== (pa\d+) =====$/gm)]
    .map((match) => match[1]);
  stages.push(
    ...[...String(output ?? "").matchAll(/^(pa\d+) tests: (?:PASS|FAIL)(?: \(| after )/gm)]
      .map((match) => match[1]),
  );
  const unique = [...new Set(stages)];
  if (unique.length === 1) {
    return unique[0];
  }
  return null;
}

function inferSingleSessionProgressStageFromCommand(command) {
  return parseSingleStageProgressCommand(command)?.stage ?? null;
}

function parseSingleStageProgressCommand(command) {
  const text = String(command ?? "").replace(/\s+\(continued session \d+\)\s*$/, "");
  if (hasProgressUnsafeShellOperator(text)) {
    return null;
  }
  const selected = parseActiveTestReportStagesFromCommand(text);
  if (selected.length === 1 && /\bmake\b[\s\S]*?\btest-report\b/.test(text)) {
    return {
      kind: "selected",
      stage: selected[0],
      hasSubset: /\bGLOB\s*=/.test(text),
    };
  }
  const through = text.match(/\bmake\b[\s\S]*?\btest-report-through-pa(\d+)\b/);
  if (through) {
    return {
      kind: "through",
      stage: `pa${Number.parseInt(through[1], 10)}`,
      hasSubset: false,
    };
  }
  const single = text.match(/\bmake\b[\s\S]*?\btest-pa(\d+)\b/);
  if (single) {
    return {
      kind: "single",
      stage: `pa${Number.parseInt(single[1], 10)}`,
      hasSubset: false,
    };
  }
  return null;
}

function hasProgressUnsafeShellOperator(text) {
  const scanText = shellOperatorScanText(text);
  if (!/[|<>]/.test(scanText)) {
    return false;
  }
  return !isSafeFilteredTestReportCommand(text);
}

function isSafeFilteredTestReportCommand(text) {
  if (!/\bmake\b[\s\S]*?\btest-report\b/.test(text)) {
    return false;
  }
  const scanText = shellOperatorScanText(text);
  const withoutSafeRedirects = scanText
    .replace(/\s*\d?>&\d+/g, "")
    .replace(/\s*\d?>\s*\/dev\/null\b/g, "");
  if (/[<>]/.test(withoutSafeRedirects)) {
    return false;
  }
  const pipeSegments = scanText.split("|").slice(1);
  if (pipeSegments.length === 0) {
    return true;
  }
  return pipeSegments.every((segment) =>
    /^\s*(grep|egrep|fgrep|sed|tail|head|awk|sort|uniq|wc|cat|cut|tr)\b/.test(segment));
}

function shellOperatorScanText(text) {
  const value = String(text ?? "");
  let result = "";
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      result += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

function parseActiveTestReportStagesFromCommand(command) {
  const match = String(command ?? "").match(
    /\bACTIVE_TEST_REPORT_PAS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return [...raw.matchAll(/\bpa\d+\b/g)].map((stage) => stage[0]);
}

function normalizeProgressObservation(raw) {
  const stage = typeof raw?.stage === "string" && /^pa\d+$/.test(raw.stage) ? raw.stage : null;
  const passed = Number(raw?.passed);
  const total = Number(raw?.total);
  const recordedAt = typeof raw?.recordedAt === "string" ? raw.recordedAt : null;
  if (!stage || !recordedAt || !Number.isFinite(passed) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return {
    recordedAt,
    stage,
    passed: Math.max(0, Math.min(passed, total)),
    total,
    status: raw?.status === "pass" ? "pass" : raw?.status === "running" ? "running" : "fail",
    hasSubset: raw?.hasSubset === true,
  };
}

function dedupeProgressObservations(observations) {
  const byKey = new Map();
  for (const observation of observations) {
    const normalized = normalizeProgressObservation(observation);
    if (!normalized) {
      continue;
    }
    byKey.set(progressObservationKey(normalized), normalized);
  }
  return [...byKey.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

function progressObservationKey(observation) {
  return [
    observation.recordedAt,
    observation.stage,
    observation.passed,
    observation.total,
    observation.status,
  ].join("|");
}

function compactBestProgressEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    const progress = event.event?.progress;
    const key = [event.turnNumber, progress?.stage, progress?.total].join("|");
    const previous = byKey.get(key);
    if (!previous || compareProgressEvents(event, previous) > 0) {
      byKey.set(key, event);
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
}

function compareProgressEvents(left, right) {
  const leftProgress = left.event?.progress ?? {};
  const rightProgress = right.event?.progress ?? {};
  const passedDelta = (leftProgress.passed ?? 0) - (rightProgress.passed ?? 0);
  if (passedDelta !== 0) {
    return passedDelta;
  }
  return String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? ""));
}

async function readCachedClosedCodexSessionWindow(filePath, threadId, resolveTurnNumber, readOptions, window) {
  const stat = await fs.stat(filePath);
  const cachePath = codexSessionWindowCachePath(filePath, threadId, readOptions, window);
  const cached = cachePath ? await readCodexSessionWindowCache(cachePath, stat) : null;
  if (cached) {
    return filterSuppressedSessionEvents(cached, readOptions);
  }

  const windowOptions = {
    ...readOptions,
    windows: [window],
    minTime: window.startTime,
    maxTime: window.endTime,
    includeTokenBaseline: true,
    suppressedItemCardStreams: new Set(),
  };
  const events = await readCodexSessionEventsFromFile(
    filePath,
    threadId,
    resolveTurnNumber,
    windowOptions,
  );
  const limited = limitSessionEventsByTurn(events, readOptions.maxEventsPerTurn);
  if (cachePath) {
    await writeCodexSessionWindowCache(cachePath, stat, limited);
  }
  return filterSuppressedSessionEvents(limited, readOptions);
}

async function readCodexSessionEventsFromFile(filePath, threadId, resolveTurnNumber, readOptions) {
  if (shouldReadCodexSessionFromTail(readOptions)) {
    return readCachedOpenCodexSessionEvents(
      filePath,
      threadId,
      resolveTurnNumber,
      readOptions,
    );
  }

  const events = [];
  const context = buildCodexSessionReadContext(threadId, resolveTurnNumber);
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    if (processCodexSessionLine(rawLine, readOptions, context, events) === "stop") {
      break;
    }
  }
  return events;
}

async function readCachedOpenCodexSessionEvents(
  filePath,
  threadId,
  resolveTurnNumber,
  readOptions,
) {
  const cacheKey = openCodexSessionCacheKey(filePath, threadId, readOptions);
  const pending = OPEN_CODEX_SESSION_READS.get(cacheKey);
  if (pending) {
    const entry = await pending;
    return selectCachedOpenCodexSessionEvents(entry.events, readOptions);
  }

  const read = refreshOpenCodexSessionCache(
    cacheKey,
    filePath,
    threadId,
    resolveTurnNumber,
    readOptions,
  );
  OPEN_CODEX_SESSION_READS.set(cacheKey, read);
  try {
    const entry = await read;
    return selectCachedOpenCodexSessionEvents(entry.events, readOptions);
  } finally {
    if (OPEN_CODEX_SESSION_READS.get(cacheKey) === read) {
      OPEN_CODEX_SESSION_READS.delete(cacheKey);
    }
  }
}

async function refreshOpenCodexSessionCache(
  cacheKey,
  filePath,
  threadId,
  resolveTurnNumber,
  readOptions,
) {
  const stat = await fs.stat(filePath);
  let entry = OPEN_CODEX_SESSION_CACHES.get(cacheKey);
  if (!entry || stat.size < entry.fileSize) {
    const tail = await readCodexSessionTailData(filePath, readOptions);
    const context = buildCodexSessionReadContext(threadId, resolveTurnNumber);
    const events = [];
    const parseOptions = openCodexSessionParseOptions(readOptions);
    for (const rawLine of tail.lines) {
      processCodexSessionLine(rawLine, parseOptions, context, events);
    }
    entry = {
      context,
      events,
      fileSize: tail.fileSize,
      minTime: readOptions.minTime,
      parseOptions,
      trailingText: tail.trailingText,
      lastUsedAt: Date.now(),
    };
    OPEN_CODEX_SESSION_CACHES.set(cacheKey, entry);
    pruneOpenCodexSessionCaches();
    return entry;
  }

  if (stat.size > entry.fileSize) {
    const appended = await readFileSlice(filePath, entry.fileSize, stat.size);
    const split = splitCompleteSessionLines(entry.trailingText + appended);
    for (const rawLine of split.lines) {
      processCodexSessionLine(rawLine, entry.parseOptions, entry.context, entry.events);
    }
    entry.fileSize = stat.size;
    entry.trailingText = split.trailingText;
  }
  entry.lastUsedAt = Date.now();
  return entry;
}

function openCodexSessionCacheKey(filePath, threadId, readOptions) {
  const window = readOptions.windows?.[0] ?? {};
  return JSON.stringify({
    filePath: path.resolve(filePath),
    threadId,
    turnNumber: window.turnNumber ?? null,
    outputLimit: readOptions.outputLimit ?? null,
    skipTokenCounts: readOptions.skipTokenCounts === true,
    includeTokenBaseline: readOptions.includeTokenBaseline === true,
  });
}

function openCodexSessionParseOptions(readOptions) {
  return {
    ...readOptions,
    suppressedItemCardStreams: new Set(),
  };
}

function selectCachedOpenCodexSessionEvents(events, readOptions) {
  const selected = filterSuppressedSessionEvents(events, readOptions);
  return limitSessionEventsByTurn(selected, readOptions.maxEventsPerTurn);
}

function pruneOpenCodexSessionCaches() {
  if (OPEN_CODEX_SESSION_CACHES.size <= OPEN_CODEX_SESSION_CACHE_LIMIT) {
    return;
  }
  const oldest = [...OPEN_CODEX_SESSION_CACHES.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    .slice(0, OPEN_CODEX_SESSION_CACHES.size - OPEN_CODEX_SESSION_CACHE_LIMIT);
  for (const [cacheKey] of oldest) {
    OPEN_CODEX_SESSION_CACHES.delete(cacheKey);
  }
}

function buildCodexSessionReadContext(threadId, resolveTurnNumber) {
  return {
    threadId,
    resolveTurnNumber,
    commandsByCallId: new Map(),
    functionCallsByCallId: new Map(),
    commandsBySessionId: new Map(),
    sessionIdsByStoreKey: new Map(),
    tokenBaseline: null,
    tokenBaselineEmitted: false,
  };
}

async function readCodexSessionWindowCache(cachePath, stat) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (
      parsed?.version !== CODEX_SESSION_WINDOW_CACHE_VERSION ||
      !Array.isArray(parsed.events) ||
      Number(parsed.file?.sizeAtCache) > stat.size
    ) {
      return null;
    }
    return parsed.events;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeCodexSessionWindowCache(cachePath, stat, events) {
  const body = JSON.stringify({
    version: CODEX_SESSION_WINDOW_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    file: {
      sizeAtCache: stat.size,
    },
    events,
  });
  const dir = path.dirname(cachePath);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, body, "utf8");
    await fs.rename(tmpPath, cachePath);
  } catch (_) {
    try {
      await fs.unlink(tmpPath);
    } catch (_) {}
  }
}

function codexSessionWindowCachePath(filePath, threadId, readOptions, window) {
  const key = JSON.stringify({
    version: CODEX_SESSION_WINDOW_CACHE_VERSION,
    filePath: path.resolve(filePath),
    threadId,
    startTime: window.startTime,
    endTime: window.endTime,
    maxEventsPerTurn: readOptions.maxEventsPerTurn ?? null,
    outputLimit: readOptions.outputLimit ?? null,
  });
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(RALPH_DIR, CODEX_SESSION_WINDOW_CACHE_DIR, `${digest}.json`);
}

function processCodexSessionLine(rawLine, readOptions, context, events) {
  const line = String(rawLine ?? "").trim();
  if (!line) {
    return "continue";
  }
  const timestamp = readOptions.mode === "all" ? null : sessionLineTimestamp(line);
  if (timestamp && shouldStopSessionRead(timestamp, readOptions)) {
    return "stop";
  }
  const includedByTimestamp = readOptions.mode === "all" ||
    timestampIncludedBySessionReadOptions(timestamp, readOptions);
  if (
    !includedByTimestamp &&
    !shouldParseOutOfWindowSessionLineForUsageBaseline(line, timestamp, readOptions)
  ) {
    return "continue";
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch (_) {
    return "continue";
  }
  if (shouldSkipSuppressedSessionResponseItem(record, readOptions, context)) {
    return "continue";
  }
  const converted = convertCodexSessionRecord(record, context);
  if (!converted) {
    return "continue";
  }
  if (
    readOptions.mode !== "all" &&
    !timestampIncludedBySessionReadOptions(record.timestamp, readOptions)
  ) {
    rememberTokenBaseline(converted, readOptions, context);
    return "continue";
  }
  if (readOptions.skipTokenCounts && converted.eventType === "codex.session.token_count") {
    return "continue";
  }
  if (shouldSkipSuppressedSessionItemCard(converted, readOptions)) {
    return "continue";
  }
  emitTokenBaselineIfNeeded(converted, readOptions, context, events);
  events.push(compactConvertedSessionEvent(converted, readOptions.outputLimit));
  return "continue";
}

function shouldSkipSuppressedSessionResponseItem(record, readOptions, context) {
  return false;
}

function shouldSkipSuppressedSessionItemCard(record, readOptions) {
  if (isFileChangeWithDiff(record)) {
    return false;
  }
  return (
    readOptions?.suppressedItemCardStreams instanceof Set &&
    readOptions.suppressedItemCardStreams.has(eventItemCardStreamKey(record)) &&
    isDisplayItemCardEvent(record)
  );
}

function filterSuppressedSessionEvents(events, readOptions) {
  if (
    !(readOptions?.suppressedItemCardStreams instanceof Set) ||
    readOptions.suppressedItemCardStreams.size === 0
  ) {
    return events;
  }
  return (events ?? []).filter((event) => !shouldSkipSuppressedSessionItemCard(event, readOptions));
}

function rememberTokenBaseline(record, readOptions, context) {
  if (!readOptions.includeTokenBaseline || record.eventType !== "codex.session.token_count") {
    return;
  }
  if (!record.event?.usage) {
    return;
  }
  const time = Date.parse(record.recordedAt ?? "");
  if (!Number.isFinite(time) || !hasFutureIncludedWindow(time, readOptions)) {
    return;
  }
  context.tokenBaseline = {
    ...record,
    _usageBaseline: true,
    event: {
      ...record.event,
      baseline: true,
    },
  };
  context.tokenBaselineEmitted = false;
}

function shouldParseOutOfWindowSessionLineForUsageBaseline(line, timestamp, readOptions) {
  if (!readOptions.includeTokenBaseline || !String(line ?? "").includes('"type":"token_count"')) {
    return false;
  }
  const time = Date.parse(timestamp ?? "");
  return Number.isFinite(time) &&
    (!Number.isFinite(readOptions.maxTime) || time < readOptions.maxTime) &&
    hasFutureIncludedWindow(time, readOptions);
}

function hasFutureIncludedWindow(time, readOptions) {
  return (readOptions.windows ?? []).some((window) => time < window.startTime);
}

function emitTokenBaselineIfNeeded(record, readOptions, context, events) {
  if (!readOptions.includeTokenBaseline) {
    return;
  }
  if (record.eventType !== "codex.session.token_count" || !context.tokenBaseline) {
    return;
  }
  events.push(compactConvertedSessionEvent(context.tokenBaseline, readOptions.outputLimit));
  context.tokenBaseline = null;
  context.tokenBaselineEmitted = true;
}

function shouldReadCodexSessionFromTail(readOptions) {
  return (
    readOptions?.mode === "windows" &&
    (readOptions.windows?.length ?? 0) === 1 &&
    Number.isFinite(readOptions.minTime) &&
    !Number.isFinite(readOptions.maxTime)
  );
}

async function readCodexSessionTailData(filePath, readOptions) {
  const stat = await fs.stat(filePath);
  if (!stat.size) {
    return { fileSize: 0, lines: [], trailingText: "" };
  }

  const handle = await fs.open(filePath, "r");
  let position = stat.size;
  let tail = "";
  let bytesReadTotal = 0;
  try {
    while (position > 0 && bytesReadTotal < CODEX_TAIL_SESSION_MAX_BYTES) {
      const length = Math.min(
        CODEX_TAIL_SESSION_CHUNK_BYTES,
        position,
        CODEX_TAIL_SESSION_MAX_BYTES - bytesReadTotal,
      );
      position -= length;
      bytesReadTotal += length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      tail = buffer.toString("utf8") + tail;

      const lines = tail.split(/\r?\n/);
      const completeLines = position > 0 ? lines.slice(1) : lines;
      const earliest = earliestSessionTimestampMs(completeLines);
      if (earliest != null && earliest < readOptions.minTime) {
        const split = splitCompleteSessionLines(tail, position > 0);
        return { fileSize: stat.size, ...split };
      }
    }
  } finally {
    await handle.close();
  }
  const split = splitCompleteSessionLines(tail, position > 0);
  return { fileSize: stat.size, ...split };
}

function splitCompleteSessionLines(text, dropFirstPartial = false) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (dropFirstPartial) {
    lines.shift();
  }
  const hasTrailingNewline = /(?:\r?\n)$/.test(text);
  const trailingText = hasTrailingNewline ? "" : lines.pop() ?? "";
  return {
    lines: lines.filter(Boolean),
    trailingText,
  };
}

function earliestSessionTimestampMs(lines) {
  for (const line of lines) {
    const timestamp = sessionLineTimestamp(line);
    const time = Date.parse(timestamp ?? "");
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return null;
}

function compactConvertedSessionEvent(record, outputLimit = CODEX_SESSION_OUTPUT_LIMIT) {
  const item = record.event?.item;
  if (!item) {
    return record;
  }
  const compactItem = { ...item };
  delete compactItem.raw;
  if (compactItem.aggregated_output != null) {
    const sessionId = commandOutputSessionId(compactItem.aggregated_output);
    const exitCode = parseFunctionOutputExitCode(
      compactItem.aggregated_output,
      compactItem.command ?? "",
    );
    if (compactItem.session_id == null && sessionId != null) {
      compactItem.session_id = sessionId;
    }
    if (!Number.isFinite(compactItem.exit_code) && Number.isFinite(exitCode)) {
      compactItem.exit_code = exitCode;
    }
    compactItem.aggregated_output = truncateSessionOutput(compactItem.aggregated_output, outputLimit);
  }
  if (Array.isArray(compactItem.changes)) {
    compactItem.changes = compactItem.changes.map((change) => {
      const compactChange = { ...change };
      delete compactChange.raw;
      if (typeof compactChange.diff === "string") {
        compactChange.diff = truncateSessionOutput(compactChange.diff, outputLimit);
      }
      return compactChange;
    });
  }
  return {
    ...record,
    event: {
      ...record.event,
      item: compactItem,
    },
  };
}

function truncateSessionOutput(output, outputLimit) {
  const text = textValue(output);
  if (!Number.isFinite(outputLimit) || outputLimit <= 0 || text.length <= outputLimit) {
    return text;
  }
  return `${truncateMiddle(text, outputLimit)}\n[ralph-viz truncated output from ${text.length} chars]`;
}

function limitSessionEventsByTurn(events, maxEventsPerTurn) {
  if (!Number.isFinite(maxEventsPerTurn) || maxEventsPerTurn <= 0) {
    return events;
  }
  const byTurn = new Map();
  for (const event of events) {
    const turn = displayTurnForRecord(event);
    const list = byTurn.get(turn) ?? [];
    list.push(event);
    byTurn.set(turn, list);
  }

  const keep = new Set();
  for (const group of byTurn.values()) {
    if (group.length <= maxEventsPerTurn) {
      group.forEach((event) => keep.add(event));
      continue;
    }
    keepSessionBoundaryEvents(group, keep);
    group
      .filter(isAlwaysKeptSessionEvent)
      .forEach((event) => keep.add(event));
    const tail = group.slice(-maxEventsPerTurn);
    tail.forEach((event) => keep.add(event));
    const neededCommandStarts = new Set(
      tail
        .filter((event) => event.eventType === "item.completed" &&
          event.event?.item?.type === "command_execution" &&
          event.event.item.id)
        .map((event) => event.event.item.id),
    );
    if (!neededCommandStarts.size) {
      keepReferencedTestReportLogWriters(group, tail, keep);
      continue;
    }
    for (const event of group) {
      if (
        event.eventType === "item.started" &&
        event.event?.item?.type === "command_execution" &&
        neededCommandStarts.has(event.event.item.id)
      ) {
        keep.add(event);
      }
    }
    keepReferencedTestReportLogWriters(group, tail, keep);
  }

  return events.filter((event) => keep.has(event));
}

function keepReferencedTestReportLogWriters(group, tail, keep) {
  const referencedLogs = new Set();
  for (const event of tail) {
    const item = event.event?.item;
    if (item?.type !== "command_execution") {
      continue;
    }
    for (const logPath of extractReferencedTempLogPaths(item.command ?? "")) {
      referencedLogs.add(logPath);
    }
  }
  if (referencedLogs.size === 0) {
    return;
  }
  const keptCommandIds = new Set();
  for (const event of group) {
    const item = event.event?.item;
    if (event.eventType !== "item.completed" || item?.type !== "command_execution") {
      continue;
    }
    const redirected = extractRedirectedTempLogPaths(item.command ?? "");
    if (!redirected.some((logPath) => referencedLogs.has(logPath))) {
      continue;
    }
    keep.add(event);
    if (item.id) {
      keptCommandIds.add(item.id);
    }
  }
  if (keptCommandIds.size === 0) {
    return;
  }
  for (const event of group) {
    const item = event.event?.item;
    if (
      event.eventType === "item.started" &&
      item?.type === "command_execution" &&
      keptCommandIds.has(item.id)
    ) {
      keep.add(event);
    }
  }
}

function keepSessionBoundaryEvents(group, keep) {
  const tokenCounts = group.filter((event) => event.eventType === "codex.session.token_count");
  if (tokenCounts.length > 0) {
    keep.add(tokenCounts[0]);
    keep.add(tokenCounts[tokenCounts.length - 1]);
    tokenCounts
      .filter(isUsageBaselineRecord)
      .forEach((event) => keep.add(event));
  }

  const goalUpdates = group.filter((event) => event.eventType === "codex.thread_goal_updated");
  if (goalUpdates.length > 0) {
    keep.add(goalUpdates[goalUpdates.length - 1]);
  }
}

function isAlwaysKeptSessionEvent(event) {
  return [
    "codex.task_complete",
    "ralph.agent-progress",
    "ralph.goal",
    "ralph.phase-status",
    "ralph.prompt",
    "ralph.test-status",
    "ralph.turn-restart",
    "turn.completed",
    "turn.failed",
    "turn.started",
  ].includes(event.eventType);
}

function extractRedirectedTempLogPaths(text) {
  const paths = [];
  const regex = /(?:^|[\s;])(?:\d?>{1,2}|&>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let match;
  while ((match = regex.exec(String(text ?? ""))) !== null) {
    const logPath = normalizeTempLogPath(match[1] ?? match[2] ?? match[3] ?? "");
    if (logPath) {
      paths.push(logPath);
    }
  }
  return [...new Set(paths)];
}

function extractReferencedTempLogPaths(text) {
  const paths = [...String(text ?? "").matchAll(/\/tmp\/[A-Za-z0-9._/-]+\.log\b/g)]
    .map((match) => normalizeTempLogPath(match[0]))
    .filter(Boolean);
  return [...new Set(paths)];
}

function normalizeTempLogPath(logPath) {
  const path = String(logPath ?? "").trim();
  return /^\/tmp\/[A-Za-z0-9._/-]+\.log$/.test(path) ? path : "";
}

async function findCodexSessionFiles(threadId) {
  if (typeof threadId !== "string" || !threadId) {
    return [];
  }
  const index = await codexSessionIndex();
  const indexedMatches = index.byThreadId.get(threadId);
  if (indexedMatches) {
    return [...indexedMatches].sort();
  }

  const sessionsDir = path.join(CODEX_DIR, "sessions");
  const matches = [];
  await walkSessions(sessionsDir, matches, threadId, 0);
  return matches.sort();
}

async function codexSessionIndex() {
  const now = Date.now();
  if (
    CODEX_SESSION_INDEX_CACHE &&
    now - CODEX_SESSION_INDEX_CACHE.loadedAt < CODEX_SESSION_INDEX_TTL_MS
  ) {
    return CODEX_SESSION_INDEX_CACHE.index;
  }

  const sessionsDir = path.join(CODEX_DIR, "sessions");
  const index = { byThreadId: new Map() };
  await walkSessionIndex(sessionsDir, index, 0);
  CODEX_SESSION_INDEX_CACHE = { loadedAt: now, index };
  return index;
}

async function walkSessionIndex(directory, index, depth) {
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
      await walkSessionIndex(entryPath, index, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const threadId = codexThreadIdFromSessionFileName(entry.name);
      if (!threadId) {
        continue;
      }
      const matches = index.byThreadId.get(threadId) ?? [];
      matches.push(entryPath);
      index.byThreadId.set(threadId, matches);
    }
  }
}

function codexThreadIdFromSessionFileName(fileName) {
  const match = String(fileName ?? "").match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
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
    sessionIdsByStoreKey: context.sessionIdsByStoreKey,
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
  if (payload.type === "task_complete") {
    return buildVizRecord(context, "codex.task_complete", {
      type: "codex.task_complete",
      durationMs: Number(payload.duration_ms ?? 0),
      raw: payload,
    });
  }
  if (payload.type === "thread_goal_updated") {
    return buildVizRecord(context, "codex.thread_goal_updated", {
      type: "codex.thread_goal_updated",
      timeUsedSeconds: Number(payload.goal?.timeUsedSeconds ?? 0),
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
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const args = parseFunctionCallArgs(payload);
    const command = formatFunctionCall(payload, args, context);
    if (payload.call_id) {
      const batchCommands = payload.name === "exec" && typeof args?.input === "string"
        ? extractToolExecCommands(args.input)
        : [];
      context.commandsByCallId?.set(payload.call_id, command);
      context.functionCallsByCallId?.set(payload.call_id, {
        name: payload.name,
        args,
        command,
        batchCommands,
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
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const call = context.functionCallsByCallId?.get(payload.call_id) ?? null;
    const parentSessionId = functionCallParentSessionId(call, context);
    const parentCommand = parentSessionId
      ? context.commandsBySessionId?.get(parentSessionId)
      : null;
    const sessionId = parseRunningSessionId(payload.output);
    if (sessionId && (parentCommand || call?.command)) {
      context.commandsBySessionId?.set(sessionId, parentCommand ?? call.command);
    }
    const sessionStoreKey = functionCallSessionStoreKey(call);
    if (sessionId && sessionStoreKey) {
      context.sessionIdsByStoreKey?.set(sessionStoreKey, sessionId);
    }
    const command =
      call?.name === "write_stdin"
        ? formatWriteStdinCommand(call.args, context)
        : parentCommand
          ? `${parentCommand} (continued session ${parentSessionId})`
          : context.commandsByCallId?.get(payload.call_id) ?? "";
    const batchCommands = buildCommandBatch(call?.batchCommands, payload.output);
    return buildVizRecord(context, "item.completed", {
      type: "item.completed",
      item: {
        id: payload.call_id,
        type: "command_execution",
        status: "completed",
        exit_code: parseFunctionOutputExitCode(payload.output, command),
        command,
        session_id: call?.args?.session_id ?? null,
        stdin: call?.name === "write_stdin" ? call.args?.chars ?? "" : null,
        aggregated_output: payload.output ?? "",
        ...(batchCommands ? { batch_commands: batchCommands } : {}),
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

function buildCommandBatch(commands, output) {
  const chunks = codexCommandOutputChunks(output);
  if (!Array.isArray(commands) || commands.length <= 1 || chunks.length !== commands.length) {
    return null;
  }
  return commands.map((command, index) => ({
    command,
    output: chunks[index].output,
    exit_code: Number.isFinite(chunks[index].exit_code) ? chunks[index].exit_code : null,
    wall_time_seconds: Number.isFinite(chunks[index].wall_time_seconds)
      ? chunks[index].wall_time_seconds
      : null,
    session_id: chunks[index].session_id ?? null,
    chunk_id: chunks[index].chunk_id ?? null,
  }));
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
  if (payload.type === "custom_tool_call") {
    return typeof payload.input === "string" ? { input: payload.input } : {};
  }
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
  if (payload.name === "exec" && typeof args.input === "string") {
    return formatCustomExecCommand(args.input, context);
  }
  return `${payload.name} ${JSON.stringify(args)}`;
}

function isExecCallName(name) {
  return name === "exec_command" || name === "exec";
}

function functionCallParentSessionId(call, context = null) {
  if (call?.name === "wait") {
    return normalizeSessionId(call.args?.cell_id);
  }
  if (call?.name === "write_stdin") {
    return resolveStoredSessionId(call.args, context);
  }
  if (call?.name === "exec" && typeof call.args?.input === "string") {
    return resolveStoredSessionId(extractToolWriteStdinArgs(call.args.input), context);
  }
  return null;
}

function functionCallSessionStoreKey(call) {
  return call?.name === "exec" && typeof call.args?.input === "string"
    ? extractSessionStoreKey(call.args.input)
    : null;
}

function resolveStoredSessionId(args, context) {
  const sessionId = normalizeSessionId(args?.session_id);
  if (sessionId) {
    return sessionId;
  }
  return args?.session_store_key
    ? normalizeSessionId(context?.sessionIdsByStoreKey?.get(args.session_store_key))
    : null;
}

function formatCustomExecCommand(input, context = null) {
  const writeStdinArgs = extractToolWriteStdinArgs(input);
  if (writeStdinArgs) {
    return formatWriteStdinCommand(writeStdinArgs, context ?? {});
  }
  const commands = extractToolExecCommands(input);
  if (commands.length === 1) {
    return commands[0];
  }
  if (commands.length > 1) {
    return commands.map((command, index) => `command ${index + 1}: ${command}`).join("\n");
  }
  if (/\btools\.apply_patch\s*\(/.test(input)) {
    return "apply_patch";
  }
  if (/\btools\.update_goal\s*\(/.test(input)) {
    return "update_goal";
  }
  return `exec ${input}`;
}

function extractToolWriteStdinArgs(input) {
  const text = String(input ?? "");
  const match = text.match(/\btools\.write_stdin\s*\(\s*(\{[\s\S]*?\})\s*\)/);
  if (!match) {
    return null;
  }
  return {
    session_id: jsObjectPropertyValue(match[1], "session_id"),
    session_store_key: extractSessionLoadKey(text),
    chars: jsObjectPropertyValue(match[1], "chars") ?? "",
  };
}

function extractSessionLoadKey(input) {
  const match = String(input ?? "").match(/\bload\s*\(\s*(["'])([^"']+)\1\s*\)/);
  return match ? match[2] : null;
}

function extractSessionStoreKey(input) {
  const match = String(input ?? "").match(
    /\bstore\s*\(\s*(["'])([^"']+)\1\s*,\s*[^\n)]*?\.session_id\b/,
  );
  return match ? match[2] : null;
}

function jsObjectPropertyValue(text, propertyName) {
  const pattern = new RegExp(
    `(?:\\b${propertyName}\\b|["']${propertyName}["'])\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))`,
  );
  const match = String(text ?? "").match(pattern);
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

function extractToolExecCommands(input) {
  const commands = [];
  const text = String(input ?? "");
  const regex = /(?:\bcmd\b|["']cmd["'])\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    commands.push(decodeJsStringLiteral(match[2]));
  }
  return commands;
}

function decodeJsStringLiteral(value) {
  return String(value ?? "")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\([\s\S])/g, (_, escaped) => {
      switch (escaped) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      default: return escaped;
      }
    });
}

function formatWriteStdinCommand(args, context) {
  const sessionId = resolveStoredSessionId(args, context);
  const originalCommand = sessionId ? context.commandsBySessionId?.get(sessionId) : null;
  const stdin = typeof args?.chars === "string" ? args.chars : "";
  const suffix = sessionId
    ? `session ${sessionId}`
    : args?.session_store_key
      ? `stored session ${args.session_store_key}`
      : "unknown session";
  const base = originalCommand
    ? `${originalCommand} (continued ${suffix})`
    : `write_stdin ${suffix}`;
  if (!stdin) {
    return base;
  }
  return `${base} stdin=${JSON.stringify(truncateMiddle(stdin, 160))}`;
}

function parseRunningSessionId(output) {
  const chunkSessionId = codexCommandOutputChunks(output)
    .map((chunk) => chunk.session_id)
    .find((sessionId) => sessionId != null && sessionId !== "");
  if (chunkSessionId != null) {
    return String(chunkSessionId);
  }
  const bareSessionId = bareCommandOutputSessionId(output);
  if (bareSessionId != null) {
    return bareSessionId;
  }
  const match = textValue(output).match(
    /(?:Process running with session ID|Script running with cell ID)\s+([A-Za-z0-9._-]+)/,
  );
  return match ? match[1] : null;
}

function normalizeSessionId(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function truncateMiddle(value, maxLength) {
  const text = textValue(value);
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function parseFunctionOutputExitCode(output, command = "") {
  const chunkExitCode = codexCommandOutputChunks(output)
    .map((chunk) => chunk.exit_code)
    .find((exitCode) => Number.isFinite(exitCode));
  if (Number.isFinite(chunkExitCode)) {
    return chunkExitCode;
  }
  const match = textValue(output).match(/Process exited with code (-?\d+)/);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  if (commandOutputSessionId(output) != null) {
    return null;
  }
  return inferDirectMakeExitCode(command, output);
}

function inferDirectMakeExitCode(command, output) {
  const text = String(command ?? "").replace(/\s+\(continued session [^)]+\)\s*$/, "");
  if (!isDirectMakeCommandForExitInference(text)) {
    return null;
  }
  const outputText = commandOutputText(output);
  return /^make(?:\[\d+\])?: \*\*\* .*?(?:Error \d+|Terminated|Killed)\s*$/m.test(outputText)
    ? 2
    : null;
}

function isDirectMakeCommandForExitInference(command) {
  const text = String(command ?? "").trim();
  if (!/^\s*(?:env\s+)?(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*make(?:\s|$)/.test(text)) {
    return false;
  }
  const scanText = shellOperatorScanText(text);
  return !/[\n;&|<>`]/.test(scanText) && !/\$\(/.test(scanText);
}

function textValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return structuredTextStringValue(value);
  }
  if (Array.isArray(value)) {
    return joinTextParts(value.map((entry) => textValue(entry)));
  }
  if (typeof value === "object") {
    if (isCodexCommandOutputChunk(value)) {
      return value.output;
    }
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.output === "string") {
      return value.output;
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function commandOutputText(value) {
  const chunks = codexCommandOutputChunks(value);
  if (chunks.length > 0) {
    return joinTextParts(chunks.map((chunk) => chunk.output));
  }
  return stripCommandOutputTransport(textValue(value));
}

function commandOutputSessionId(value) {
  const sessionId = codexCommandOutputChunks(value)
    .map((chunk) => chunk.session_id)
    .find((candidate) => candidate != null && candidate !== "");
  return sessionId == null ? parseRunningSessionId(value) : String(sessionId);
}

function bareCommandOutputSessionId(value) {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const sessionId = bareCommandOutputSessionId(entry);
      if (sessionId != null) {
        return sessionId;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.session_id != null && value.session_id !== "") {
      return String(value.session_id);
    }
    return bareCommandOutputSessionId(value.text ?? value.output ?? null);
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.session_id != null && parsed.session_id !== "") {
      return String(parsed.session_id);
    }
  } catch (_) {
    // Fall through to the transport-envelope form.
  }
  const match = text.match(
    /(?:^|\n)\s*(?:\{\s*"session_id"\s*:\s*"?([A-Za-z0-9._-]+)"?\s*\}|SESSION_ID=([A-Za-z0-9._-]+))\s*$/,
  );
  return match ? match[1] ?? match[2] : null;
}

function stripCommandOutputTransport(value) {
  return String(value ?? "")
    .replace(/^Script completed\r?\nWall time [^\r\n]*\r?\nOutput:\r?\n/, "")
    .replace(
      /(?:^|\n)\s*(?:\{\s*"session_id"\s*:\s*"?[A-Za-z0-9._-]+"?\s*\}|SESSION_ID=[A-Za-z0-9._-]+)\s*$/m,
      "",
    )
    .trim();
}

function structuredTextStringValue(value) {
  const envelope = codexCommandOutputEnvelopeText(value);
  if (envelope != null) {
    return envelope;
  }
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "[" && trimmed[0] !== "{")) {
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
  return isStructuredTextPayload(parsed) || isCodexCommandOutputChunk(parsed)
    ? textValue(parsed)
    : value;
}

function codexCommandOutputEnvelopeText(value) {
  const text = String(value ?? "");
  const match = text.match(/^([\s\S]*?\bOutput:\r?\n)(\{[\s\S]*\})\s*$/);
  if (!match) {
    return null;
  }
  const chunk = parseCodexCommandOutputChunk(match[2]);
  return chunk ? `${match[1]}${chunk.output}` : null;
}

function codexCommandOutputChunks(value) {
  const chunks = [];
  collectCodexCommandOutputChunks(value, chunks);
  return chunks;
}

function collectCodexCommandOutputChunks(value, chunks) {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    const direct = parseCodexCommandOutputChunk(value);
    if (direct) {
      chunks.push(direct);
      return;
    }
    const envelope = String(value).match(/\bOutput:\s*(\{[\s\S]*\})\s*$/);
    const nested = envelope ? parseCodexCommandOutputChunk(envelope[1]) : null;
    if (nested) {
      chunks.push(nested);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCodexCommandOutputChunks(entry, chunks);
    }
    return;
  }
  if (typeof value === "object") {
    if (isCodexCommandOutputChunk(value)) {
      chunks.push(value);
      return;
    }
    if (typeof value.text === "string") {
      collectCodexCommandOutputChunks(value.text, chunks);
    }
    if (typeof value.output === "string") {
      collectCodexCommandOutputChunks(value.output, chunks);
    }
  }
}

function parseCodexCommandOutputChunk(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed[0] !== "{") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isCodexCommandOutputChunk(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isCodexCommandOutputChunk(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.output === "string" &&
      (typeof value.chunk_id === "string" ||
        Object.prototype.hasOwnProperty.call(value, "wall_time_seconds") ||
        Object.prototype.hasOwnProperty.call(value, "session_id") ||
        Object.prototype.hasOwnProperty.call(value, "exit_code") ||
        Object.prototype.hasOwnProperty.call(value, "original_token_count")),
  );
}

function isStructuredTextPayload(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isStructuredTextPayload);
  }
  const type = typeof value?.type === "string" ? value.type : "";
  return Boolean(
    value &&
      typeof value === "object" &&
      (type === "input_text" || type === "output_text") &&
      (typeof value.text === "string" || typeof value.output === "string"),
  );
}

function joinTextParts(parts) {
  const filtered = parts.filter((part) => part !== "");
  let result = "";
  for (const part of filtered) {
    if (result && !/[\r\n]$/.test(result) && !/^[\r\n]/.test(part)) {
      result += "\n";
    }
    result += part;
  }
  return result;
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
        const eventLogPath = typeof parsed.eventLogPath === "string" ? parsed.eventLogPath : null;
        const fileBase = eventLogPath && eventLogPath.endsWith(".jsonl")
          ? path.basename(eventLogPath, ".jsonl")
          : typeof parsed.threadId === "string"
            ? parsed.threadId
            : null;
        if (fileBase) {
          const stat = await fs.stat(statePath);
          candidates.push({
            id: `${dir.name}/${fileBase}`,
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
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

async function appendScrollDebugEvent(event) {
  await fs.mkdir(RALPH_DIR, { recursive: true });
  await fs.appendFile(
    SCROLL_DEBUG_LOG_PATH,
    `${JSON.stringify({ serverAt: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

async function appBuildId() {
  const files = ["index.html", "app.js", "model-pricing.js", "styles.css"];
  const stats = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(path.join(SPA_DIR, file));
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  }));
  const key = stats.join("|");
  if (APP_BUILD_ID_CACHE?.key === key) {
    return APP_BUILD_ID_CACHE.value;
  }
  const value = createHash("sha256").update(key).digest("hex").slice(0, 16);
  APP_BUILD_ID_CACHE = { key, value };
  return value;
}

function sendStaticFile(res, filePath, contentType, fallback = "Not found") {
  return fs
    .readFile(filePath, "utf8")
    .then((content) => {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
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

  if (pathname === "/model-pricing.js") {
    return sendStaticFile(res, path.join(SPA_DIR, "model-pricing.js"), "application/javascript; charset=utf-8");
  }

  if (pathname === "/styles.css") {
    return sendStaticFile(res, path.join(SPA_DIR, "styles.css"), "text/css; charset=utf-8");
  }

  if (pathname === "/api/state") {
    const currentThread = await currentRunId();
    const appVersion = await appBuildId();
    return sendJson(res, { currentThread, appVersion });
  }

  if (pathname === "/api/debug-scroll") {
    if (req.method === "POST") {
      const event = await readJsonBody(req);
      await appendScrollDebugEvent(event && typeof event === "object" ? event : { value: event });
      return sendJson(res, { ok: true });
    }
    if (req.method === "GET") {
      let raw = "";
      try {
        raw = await fs.readFile(SCROLL_DEBUG_LOG_PATH, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const limit = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get("limit") ?? "200", 10)));
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
      return sendJson(res, { path: SCROLL_DEBUG_LOG_PATH, lines });
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  if (pathname === "/api/runs") {
    const fileEntries = await listFiles();
    const runs = fileEntries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      size: entry.size,
      mtime: entry.mtime,
      eventMtime: entry.eventMtime,
      state: entry.state,
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
    const detailOptions = parseCodexDetailOptions(url.searchParams);
    const usageMode = normalizeUsageMode(url.searchParams.get("usage"));
    try {
      events = await readRunWithCodexSession(runRef.filePath, detailOptions);
      await augmentSliceMetadataForRun(events, runRef.shape);
      shapeUsage = usageMode === "full"
        ? await readShapeUsage(runRef.shape, {
            filePath: runRef.filePath,
            events,
            sessionComplete: detailOptions.mode === "all",
            usageMode,
          })
        : await readFastShapeUsage(runRef.shape, runRef.threadId, events, usageMode);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      throw error;
    }
    if (!events.length) {
      return sendJson(res, { error: "Run not found" }, 404);
    }
    return sendJson(res, { events, shapeUsage, codexDetail: detailOptions });
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
