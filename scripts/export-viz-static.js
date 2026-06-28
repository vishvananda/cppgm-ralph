#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const DEFAULT_RUNS = [
  "phases-gpt-5.5-xhigh",
  "trusted-gpt-5.5-xhigh",
  "fable-claude-fable-5-xhigh",
  "opus-opus-xhigh",
];
const SPARK_RUN = "spark-gpt-5.4-medium";
const FORMAT_VERSION = 1;
const ASSIGNMENT_LAYOUTS = {
  v1: {
    id: "v1",
    shortLabel: "v1",
    label: "v1 legacy layout",
    description: "Legacy assignment layout used by phases and spark. It tops out at pa37 Inception.",
  },
  v2: {
    id: "v2",
    shortLabel: "v2",
    label: "v2 current layout",
    description: "Current assignment layout used by trusted, fable, and opus. It includes abimangle at pa30 and tops out at pa39 Inception.",
  },
};

function usage() {
  return `Usage: node scripts/export-viz-static.js [options]

Export Ralph run viewer data as static files.

Options:
  --out <dir>           Output directory (default: ./ralph-viz-static)
  --run <spec>          Run to export; repeatable. Defaults to phases/trusted/fable/opus
  --runs <a,b,c>        Comma-separated run specs
  --include-spark       Include ${SPARK_RUN}
  --through <paN|N>     Last PA for comparison data (default: pa39)
  --ralph-dir <dir>     Ralph state dir (default: ~/work/.ralph)
  --codex-dir <dir>     Codex sessions dir (default: ~/.codex/sessions)
  --work-dir <dir>      Run prompt/config dir (default: ~/work)
  --no-clean            Do not remove output dir before exporting
  --no-compare          Skip comparison generation
  --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, "ralph-viz-static"),
    ralphDir: path.join(os.homedir(), "work", ".ralph"),
    codexDir: path.join(os.homedir(), ".codex", "sessions"),
    workDir: path.join(os.homedir(), "work"),
    through: "pa39",
    runs: [],
    clean: true,
    compare: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--out") {
      options.outDir = expandHome(next());
    } else if (arg === "--run") {
      options.runs.push(next());
    } else if (arg === "--runs") {
      options.runs.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg === "--include-spark" || arg === "--spark") {
      options.includeSpark = true;
    } else if (arg === "--through") {
      options.through = normalizePa(next());
    } else if (arg === "--ralph-dir") {
      options.ralphDir = expandHome(next());
    } else if (arg === "--codex-dir") {
      options.codexDir = expandHome(next());
    } else if (arg === "--work-dir") {
      options.workDir = expandHome(next());
    } else if (arg === "--no-clean") {
      options.clean = false;
    } else if (arg === "--no-compare") {
      options.compare = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.runs.push(arg);
    }
  }
  if (!options.runs.length) {
    options.runs = [...DEFAULT_RUNS];
  }
  if (options.includeSpark && !options.runs.includes(SPARK_RUN)) {
    options.runs.push(SPARK_RUN);
  }
  return options;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value?.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function normalizePa(value) {
  const match = String(value ?? "").match(/^(?:pa)?(\d+)$/i);
  if (!match) {
    throw new Error(`invalid PA value: ${value}`);
  }
  return `pa${Number.parseInt(match[1], 10)}`;
}

function paNumber(value) {
  const match = String(value ?? "").match(/^pa(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function inferAssignmentLayout(shape) {
  const text = String(shape ?? "");
  if (text.startsWith("phases") || text.startsWith("spark")) {
    return ASSIGNMENT_LAYOUTS.v1;
  }
  return ASSIGNMENT_LAYOUTS.v2;
}

function inferRunWorktree(run, options) {
  const prefix = inferDocPrefix(run.shape);
  return path.join(options.workDir, prefix);
}

function sanitizePathPart(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

async function resolveRun(spec, ralphDir) {
  const expanded = expandHome(spec);
  if (fsSync.existsSync(expanded)) {
    const stat = await fs.stat(expanded);
    if (stat.isFile()) {
      return runFromFile(expanded, ralphDir);
    }
    if (stat.isDirectory()) {
      return runFromFile(await newestJsonl(expanded), ralphDir);
    }
  }

  if (spec.includes("/")) {
    const [shape, fileBase] = spec.split("/", 2);
    const candidate = path.join(ralphDir, shape, "events", `${fileBase}.jsonl`);
    if (fsSync.existsSync(candidate)) {
      return runFromFile(candidate, ralphDir);
    }
  }

  const eventsDir = path.join(ralphDir, spec, "events");
  if (fsSync.existsSync(eventsDir)) {
    const runFile = path.join(eventsDir, "run.jsonl");
    return runFromFile(fsSync.existsSync(runFile) ? runFile : await newestJsonl(eventsDir), ralphDir);
  }

  throw new Error(`could not resolve run spec: ${spec}`);
}

async function runFromFile(filePath, ralphDir) {
  const resolved = path.resolve(filePath);
  const fileBase = path.basename(resolved, ".jsonl");
  const shape = path.basename(path.dirname(path.dirname(resolved)));
  const id = `${shape}/${fileBase}`;
  const label = fileBase === "run" ? shape : `${shape} ${fileBase.slice(0, 4)}`;
  const statePath = path.join(ralphDir, shape, "state.json");
  const stat = await fs.stat(resolved);
  return {
    spec: shape,
    id,
    label,
    shape,
    fileBase,
    filePath: resolved,
    statePath,
    safeId: sanitizePathPart(fileBase === "run" ? shape : `${shape}-${fileBase}`),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    eventMtime: stat.mtime.toISOString(),
  };
}

async function newestJsonl(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const filePath = path.join(directory, entry.name);
      files.push({ filePath, stat: await fs.stat(filePath) });
    }
  }
  if (!files.length) {
    throw new Error(`no .jsonl files under ${directory}`);
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files[0].filePath;
}

async function readJsonl(filePath) {
  const records = [];
  let index = 0;
  const lines = readline.createInterface({
    input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    index += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      console.warn(`${filePath}:${index + 1}: skipped invalid JSON: ${error.message}`);
    }
  }
  return records;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readRunStateSummary(run) {
  const parsed = await readJsonIfExists(run.statePath);
  if (!parsed) return null;
  return {
    matchesCurrent: true,
    active: Boolean(parsed.activePhase),
    recentlyUpdated: true,
    activeAgeMs: null,
    turnsCompleted: Number.isInteger(parsed.turnsCompleted) ? parsed.turnsCompleted : null,
    activeStage: typeof parsed.activeStage === "string" ? parsed.activeStage : null,
    activeSubset: typeof parsed.activeSubset === "string" ? parsed.activeSubset : null,
    activePhase: typeof parsed.activePhase === "string" ? parsed.activePhase : null,
    phaseAttempted: parsed.phaseAttempted === true,
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
    eventLogPath: typeof parsed.eventLogPath === "string" ? parsed.eventLogPath : null,
    lastExitCode: Number.isInteger(parsed.lastExitCode) ? parsed.lastExitCode : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
  };
}

function eventTurnKey(record) {
  if (Number.isInteger(record?.turnNumber) && record.turnNumber > 0) {
    return String(record.turnNumber);
  }
  return "setup";
}

function turnFileName(turnKey) {
  if (turnKey === "setup") return "turn-setup.json";
  const number = Number.parseInt(turnKey, 10);
  return Number.isFinite(number)
    ? `turn-${String(number).padStart(4, "0")}.json`
    : `turn-${sanitizePathPart(turnKey)}.json`;
}

function sortableTurnValue(turnKey) {
  return turnKey === "setup" ? -1 : Number.parseInt(turnKey, 10);
}

function groupEventsByTurn(events) {
  const groups = new Map();
  for (const event of events) {
    const turnKey = eventTurnKey(event);
    const list = groups.get(turnKey) ?? [];
    list.push(event);
    groups.set(turnKey, list);
  }
  return [...groups.entries()].sort((a, b) => sortableTurnValue(a[0]) - sortableTurnValue(b[0]));
}

function eventTimeBounds(events) {
  const times = events
    .map((event) => Date.parse(event?.recordedAt ?? ""))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyViewerAssets(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  for (const name of ["index.html", "app.js", "styles.css"]) {
    await fs.copyFile(path.join(REPO_ROOT, "ralph-viz", name), path.join(outDir, name));
  }
}

async function collectDocs(run, options, outRunDir) {
  const docsDir = path.join(outRunDir, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  const docs = [];
  const prefix = inferDocPrefix(run.shape);
  const candidates = [];

  try {
    const entries = await fs.readdir(options.workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === `${prefix}.config.json` || entry.name.startsWith(`${prefix}.`) && entry.name.endsWith(".md")) {
        candidates.push(path.join(options.workDir, entry.name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  for (const extra of ["state.json", "current-goal.json"]) {
    const filePath = path.join(options.ralphDir, run.shape, extra);
    if (fsSync.existsSync(filePath)) {
      candidates.push(filePath);
    }
  }

  const seen = new Set();
  for (const sourcePath of candidates.sort()) {
    const resolved = path.resolve(sourcePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = await fs.stat(resolved);
    const name = sanitizeDocFileName(path.basename(sourcePath));
    const relativePath = `runs/${run.safeId}/docs/${name}`;
    await fs.copyFile(resolved, path.join(docsDir, name));
    docs.push({
      name,
      title: docTitle(path.basename(sourcePath)),
      kind: name.endsWith(".json") ? "json" : "markdown",
      path: relativePath,
      sourcePath: resolved,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
  await writeJson(path.join(docsDir, "index.json"), { formatVersion: FORMAT_VERSION, runId: run.id, docs });
  return docs;
}

function inferDocPrefix(shape) {
  for (const prefix of ["phases", "trusted", "fable", "opus", "spark"]) {
    if (shape.startsWith(prefix)) return prefix;
  }
  return shape.split("-")[0] || shape;
}

function sanitizeDocFileName(name) {
  return path.basename(name).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function docTitle(name) {
  return name
    .replace(/\.(md|json)$/i, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function collectAssignmentTitles(run, options) {
  const worktree = inferRunWorktree(run, options);
  const titles = {};
  for (let number = 1; number <= 60; number += 1) {
    const stage = `pa${number}`;
    const readmePath = path.join(worktree, stage, "README.md");
    let raw = "";
    try {
      raw = await fs.readFile(readmePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const title = assignmentTitleFromReadme(raw);
    if (title) {
      titles[stage] = title;
    }
  }
  return titles;
}

function assignmentTitleFromReadme(raw) {
  for (const line of String(raw ?? "").split(/\r?\n/).slice(0, 20)) {
    const text = line.trim();
    if (/^#{1,3}\s+/.test(text)) {
      return text.replace(/^#+\s*/, "");
    }
  }
  return null;
}

async function buildComparison(options, runs) {
  if (!options.compare || !runs.length) {
    return null;
  }
  const comparisonRuns = runs.filter((run) => inferAssignmentLayout(run.shape).id === "v2");
  if (!comparisonRuns.length) {
    return null;
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "compare-pa-costs.js");
  const args = [
    scriptPath,
    "--format", "json",
    "--through", options.through,
    "--ralph-dir", options.ralphDir,
    "--codex-dir", options.codexDir,
    ...comparisonRuns.map((run) => run.spec),
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: REPO_ROOT,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (stderr.trim()) {
      console.warn(stderr.trim());
    }
    return JSON.parse(stdout);
  } catch (error) {
    console.warn(`comparison export failed: ${error.message}`);
    return null;
  }
}

function annotateComparison(comparison, runMetas) {
  if (!comparison || !Array.isArray(comparison.runs)) {
    return comparison;
  }
  const metaBySpec = new Map(runMetas.map((run) => [run.label, run]));
  for (const run of comparison.runs) {
    const meta =
      metaBySpec.get(run.spec) ??
      metaBySpec.get(run.label) ??
      runMetas.find((candidate) => path.resolve(candidate.filePath ?? "") === path.resolve(run.filePath ?? ""));
    if (!meta) continue;
    run.layout = meta.assignmentLayout;
    run.assignmentTitles = meta.assignmentTitles;
    run.dataPath = meta.dataPath;
  }
  comparison.assignmentLayouts = ASSIGNMENT_LAYOUTS;
  comparison.series = comparisonSeries(comparison);
  return comparison;
}

function comparisonSeries(comparison) {
  const rows = Array.isArray(comparison?.rows) ? comparison.rows : [];
  const runs = Array.isArray(comparison?.runs) ? comparison.runs : [];
  return runs.map((run, runIndex) => {
    let cost = 0;
    let durationMs = 0;
    return {
      label: run.label,
      model: run.model ?? null,
      points: rows.flatMap((row, index) => {
        const summary = row.runs?.[runIndex] ?? null;
        if (!comparisonSummaryStarted(summary)) {
          return [];
        }
        cost += Number(summary.cost ?? 0) || 0;
        durationMs += Number(summary.durationMs ?? 0) || 0;
        return [{
          pa: row.pa,
          index,
          status: summary.status ?? "complete",
          cost,
          durationMs,
        }];
      }),
    };
  });
}

function comparisonSummaryStarted(summary) {
  if (!summary || summary.status === "not started") {
    return false;
  }
  return (Array.isArray(summary.turns) && summary.turns.length > 0) ||
    (Number(summary.durationMs ?? 0) || 0) > 0 ||
    (Number(summary.cost ?? 0) || 0) > 0 ||
    summary.status === "partial" ||
    summary.status === "complete";
}

function totalForRun(comparison, run) {
  const entry = comparison?.runs?.find((candidate) =>
    candidate.spec === run.spec ||
    candidate.label === run.spec ||
    candidate.label === run.label ||
    path.resolve(candidate.filePath ?? "") === path.resolve(run.filePath));
  return entry?.total ?? null;
}

async function exportRun(run, options, comparison) {
  const outRunDir = path.join(options.outDir, "data", "runs", run.safeId);
  const turnsDir = path.join(outRunDir, "turns");
  await fs.mkdir(turnsDir, { recursive: true });
  const runEvents = await readJsonl(run.filePath);
  const codexUsageEvents = await collectCodexUsageEvents(runEvents, options);
  const events = mergeEventsByTime(runEvents, codexUsageEvents);
  const grouped = groupEventsByTurn(events);
  const turns = [];
  for (const [turnKey, turnEvents] of grouped) {
    const fileName = turnFileName(turnKey);
    const relativePath = `runs/${run.safeId}/turns/${fileName}`;
    await writeJson(path.join(turnsDir, fileName), {
      formatVersion: FORMAT_VERSION,
      runId: run.id,
      turn: turnKey,
      events: turnEvents,
    });
    turns.push({
      turn: turnKey,
      path: relativePath,
      eventCount: turnEvents.length,
      ...eventTimeBounds(turnEvents),
    });
  }

  const docs = await collectDocs(run, options, outRunDir);
  const assignmentLayout = inferAssignmentLayout(run.shape);
  const assignmentTitles = await collectAssignmentTitles(run, options);
  const state = await readRunStateSummary(run);
  const bounds = eventTimeBounds(events);
  const total = totalForRun(comparison, run);
  const shapeUsage = total?.usage
    ? {
        runCount: 1,
        threadCount: null,
        durationMs: total.durationMs ?? 0,
        usage: total.usage,
        cost: total.cost ?? 0,
      }
    : null;
  const runMeta = {
    id: run.id,
    label: run.label,
    fileBase: run.fileBase,
    filePath: run.filePath,
    dataPath: `runs/${run.safeId}/summary.json`,
    docsPath: `runs/${run.safeId}/docs/index.json`,
    safeId: run.safeId,
    assignmentLayout,
    assignmentTitles,
    size: run.size,
    mtime: run.mtime,
    eventMtime: run.eventMtime,
    eventCount: events.length,
    syntheticUsageEventCount: codexUsageEvents.length,
    turnCount: turns.length,
    first: bounds.first,
    last: bounds.last,
    state,
  };
  await writeJson(path.join(outRunDir, "summary.json"), {
    formatVersion: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    run: runMeta,
    codexDetail: { mode: "static" },
    shapeUsage,
    turns,
    docs,
    eventCount: events.length,
    syntheticUsageEventCount: codexUsageEvents.length,
    ...bounds,
  });
  return runMeta;
}

async function collectCodexUsageEvents(events, options) {
  const threadIds = [...new Set(events.map(eventThreadId).filter(Boolean))]
    .filter(Boolean);
  if (!threadIds.length) {
    return [];
  }
  const existingUsageKeys = new Set(
    events
      .filter((event) => event.eventType === "codex.session.token_count" && event.event?.usage)
      .map((event) => usageEventKey(eventThreadId(event), event.event.usage))
      .filter(Boolean),
  );
  const resolveTurn = buildTurnResolver(events);
  const filesByThread = findCodexSessionFiles(options.codexDir, threadIds);
  const usageEvents = [];
  for (const threadId of threadIds) {
    for (const filePath of (filesByThread.get(threadId) ?? []).sort()) {
      usageEvents.push(...await readCodexUsageEvents(filePath, threadId, resolveTurn, existingUsageKeys));
    }
  }
  return usageEvents;
}

function usageEventKey(threadId, usage) {
  if (!threadId || !usage || typeof usage !== "object") {
    return "";
  }
  return [
    threadId,
    usage.input_tokens ?? usage.promptTokenCount ?? 0,
    usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? 0,
    usage.output_tokens ?? ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)),
    usage.reasoning_output_tokens ?? usage.thinking_output_tokens ?? usage.thoughtsTokenCount ?? 0,
    usage.total_tokens ?? usage.totalTokenCount ?? 0,
  ].join("\0");
}

function eventThreadId(record) {
  return (
    record?.threadId ??
    record?.event?.thread_id ??
    record?.event?.threadId ??
    record?.event?.goal?.threadId ??
    null
  );
}

function buildTurnResolver(events) {
  const starts = events
    .filter((event) =>
      (event.eventType === "ralph.phase-status" && event.event?.action === "turn-start") ||
      event.eventType === "ralph.prompt")
    .map((event) => ({
      turnNumber: event.turnNumber,
      time: Date.parse(event.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isInteger(entry.turnNumber) && entry.turnNumber > 0 && Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return (timestamp) => {
    const time = Date.parse(timestamp ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }
    let selected = null;
    for (const start of starts) {
      if (start.time > time) {
        break;
      }
      selected = start;
    }
    return selected?.turnNumber ?? null;
  };
}

function findCodexSessionFiles(codexDir, threadIds) {
  const wanted = new Set(threadIds);
  const matches = new Map([...wanted].map((threadId) => [threadId, []]));
  walkCodexSessions(codexDir, (filePath) => {
    const basename = path.basename(filePath);
    for (const threadId of wanted) {
      if (basename.endsWith(`${threadId}.jsonl`)) {
        matches.get(threadId).push(filePath);
      }
    }
  });
  return matches;
}

function walkCodexSessions(directory, visit, depth = 0) {
  if (depth > 6 || !fsSync.existsSync(directory)) {
    return;
  }
  for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkCodexSessions(entryPath, visit, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      visit(entryPath);
    }
  }
}

async function readCodexUsageEvents(filePath, threadId, resolveTurn, existingUsageKeys) {
  const events = [];
  const lines = readline.createInterface({
    input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    if (!rawLine.includes('"type":"token_count"')) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch (_) {
      continue;
    }
    if (record?.type !== "event_msg" || record.payload?.type !== "token_count") {
      continue;
    }
    const usage = record.payload?.info?.total_token_usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const key = usageEventKey(threadId, usage);
    if (existingUsageKeys?.has(key)) {
      continue;
    }
    const turnNumber = resolveTurn(record.timestamp);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      continue;
    }
    events.push({
      recordedAt: record.timestamp,
      threadId,
      turnNumber,
      eventType: "codex.session.token_count",
      event: {
        type: "codex.session.token_count",
        usage,
        source: "codex-session-export",
      },
    });
  }
  return events;
}

function mergeEventsByTime(primary, secondary) {
  if (!secondary.length) {
    return primary;
  }
  return [...primary, ...secondary].sort((a, b) =>
    String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
}

async function cleanOutput(options) {
  if (options.clean) {
    await fs.rm(options.outDir, { recursive: true, force: true });
  }
  await fs.mkdir(path.join(options.outDir, "data"), { recursive: true });
}

async function writeComparison(options, comparison) {
  if (!comparison) {
    return [];
  }
  const relativePath = "comparisons/pa-costs.json";
  await writeJson(path.join(options.outDir, "data", relativePath), comparison);
  return [{
    id: "pa-costs",
    label: `PA Costs Through ${comparison.through ?? options.through}`,
    path: relativePath,
    through: comparison.through ?? options.through,
  }];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await cleanOutput(options);
  await copyViewerAssets(options.outDir);

  const runs = [];
  for (const spec of options.runs) {
    try {
      runs.push(await resolveRun(spec, options.ralphDir));
    } catch (error) {
      console.warn(`skipping ${spec}: ${error.message}`);
    }
  }
  if (!runs.length) {
    throw new Error("no runs resolved");
  }

  const comparison = await buildComparison(options, runs);
  const runMetas = [];
  for (const run of runs) {
    console.error(`exporting ${run.id}`);
    runMetas.push(await exportRun(run, options, comparison));
  }
  annotateComparison(comparison, runMetas);
  const comparisons = await writeComparison(options, comparison);
  await writeJson(path.join(options.outDir, "data", "runs.json"), {
    formatVersion: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      ralphDir: options.ralphDir,
      codexDir: options.codexDir,
      workDir: options.workDir,
      through: options.through,
    },
    runs: runMetas,
    comparisons,
  });
  console.log(`Exported ${runMetas.length} runs to ${options.outDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
