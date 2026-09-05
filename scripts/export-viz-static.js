#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import "../ralph-viz/assignment-layouts.js";
import { VIEWER_ASSET_NAMES } from "../ralph-viz/viewer-assets.js";
import {
  collectSubagentEvents,
  DEFAULT_CLAUDE_PROJECTS_DIR,
} from "../subagent-events.js";

const execFileAsync = promisify(execFile);
const ASSIGNMENT_LAYOUT = globalThis.RALPH_ASSIGNMENT_LAYOUT;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const DEFAULT_RUNS = [
  "trusted-gpt-5.5-xhigh",
  "opus-opus-xhigh",
  "mini-gpt-5.6-sol-xhigh",
  "fable-claude-fable-5-xhigh",
  "luna-gpt-5.6-luna-ultra",
  "v3opus-claude-opus-5-xhigh",
  "v3codex-gpt-5.6-sol-xhigh",
  "v3multi-gpt-5.6-sol-xhigh",
];
const RUN_REPOSITORIES = new Map([
  ["trusted", "https://github.com/vishvananda/cppgm-run-trusted"],
  ["opus", "https://github.com/vishvananda/cppgm-run-opus"],
  ["mini", "https://github.com/vishvananda/cppgm-run-mini"],
  ["fable", "https://github.com/vishvananda/cppgm-run-fable"],
  ["luna", "https://github.com/vishvananda/cppgm-run-luna"],
  ["v3opus", "https://github.com/vishvananda/cppgm-run-v3opus"],
  ["v3codex", "https://github.com/vishvananda/cppgm-run-v3codex"],
  ["v3multi", "https://github.com/vishvananda/cppgm-run-v3multi"],
]);
const FORMAT_VERSION = 1;
const EXPORT_CACHE_VERSION = 1;
const COMPARISON_MAX_OLD_SPACE_MB = 16384;
const DEFAULT_PUBLISHED_BASE_URL =
  "https://storage.googleapis.com/ralph-run-viewer-zippy-960/";

function usage() {
  return `Usage: node scripts/export-viz-static.js [options]

Export Ralph run viewer data as static files.

Options:
  --out <dir>           Output directory (default: ./ralph-viz-static)
  --run <spec>          Run to export; repeatable. Defaults to all published runs
  --runs <a,b,c>        Comma-separated run specs
  --through <paN|N>     Last PA for comparison data (default: pa39)
  --ralph-dir <dir>     Ralph state dir (default: ~/work/.ralph)
  --codex-dir <dir>     Codex sessions dir (default: ~/.codex/sessions)
  --claude-dir <dir>    Claude projects dir (default: ~/.claude/projects)
  --work-dir <dir>      Run prompt/config dir (default: ~/work)
  --published-base <url> Published export used to retain archived runs
                         (default: ralph-run-viewer-zippy-960)
  --no-published-base   Do not consult the published export for missing runs
  --clean               Force a full rebuild (exports are incremental by default)
  --no-clean            Retained alias for the incremental default
  --no-compare          Skip comparison generation
  --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, "ralph-viz-static"),
    ralphDir: path.join(os.homedir(), "work", ".ralph"),
    codexDir: path.join(os.homedir(), ".codex", "sessions"),
    claudeDir: DEFAULT_CLAUDE_PROJECTS_DIR,
    workDir: path.join(os.homedir(), "work"),
    through: "pa39",
    runs: [],
    clean: false,
    compare: true,
    publishedBaseUrl:
      process.env.RALPH_VIZ_PUBLISHED_EXPORT_URL ?? DEFAULT_PUBLISHED_BASE_URL,
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
    } else if (arg === "--through") {
      options.through = normalizePa(next());
    } else if (arg === "--ralph-dir") {
      options.ralphDir = expandHome(next());
    } else if (arg === "--codex-dir") {
      options.codexDir = expandHome(next());
    } else if (arg === "--claude-dir") {
      options.claudeDir = expandHome(next());
    } else if (arg === "--work-dir") {
      options.workDir = expandHome(next());
    } else if (arg === "--published-base") {
      options.publishedBaseUrl = next();
    } else if (arg === "--no-published-base") {
      options.publishedBaseUrl = null;
    } else if (arg === "--clean") {
      options.clean = true;
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

async function inferAssignmentLayout(run, options) {
  const prefix = inferDocPrefix(run.shape);
  const config = await readJsonIfExists(path.join(options.workDir, `${prefix}.config.json`));
  const id = ASSIGNMENT_LAYOUT.inferLayoutId(run.shape, config?.assignmentLayout);
  return ASSIGNMENT_LAYOUT.descriptor(id);
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

function publishedArtifactUrl(baseUrl, relativePath) {
  const base = String(baseUrl ?? "").endsWith("/")
    ? String(baseUrl)
    : `${String(baseUrl)}/`;
  return new URL(relativePath.replace(/^\/+/, ""), base).href;
}

async function fetchJsonArtifact(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function readPublishedBaseline(options) {
  if (!options.publishedBaseUrl) return null;
  const manifest = await fetchJsonArtifact(publishedArtifactUrl(
    options.publishedBaseUrl,
    "data/runs.json",
  ));
  const comparisonEntry = manifest.comparisons?.[0];
  const comparison = options.compare && comparisonEntry?.path
    ? await fetchJsonArtifact(publishedArtifactUrl(
        options.publishedBaseUrl,
        `data/${comparisonEntry.path}`,
      ))
    : null;
  return { manifest, comparison };
}

function runMetaForSpec(manifest, spec) {
  return (manifest?.runs ?? []).find((run) =>
    run.id === `${spec}/run` ||
    run.label === spec ||
    run.safeId === sanitizePathPart(spec));
}

function artifactTimestamp(artifact) {
  for (const value of [
    artifact?.generatedAt,
    artifact?.eventMtime,
    artifact?.mtime,
    artifact?.last,
  ]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function newerArtifact(local, published) {
  if (!local) return published ?? null;
  if (!published) return local;
  return artifactTimestamp(published) > artifactTimestamp(local)
    ? published
    : local;
}

function retainedRunIdentity(spec, meta) {
  return {
    spec,
    id: meta.id ?? `${spec}/run`,
    label: meta.label ?? spec,
    shape: String(meta.id ?? `${spec}/run`).split("/", 1)[0],
    fileBase: meta.fileBase ?? "run",
    filePath: meta.filePath ?? "",
    safeId: meta.safeId ?? sanitizePathPart(spec),
  };
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
  for (const name of VIEWER_ASSET_NAMES) {
    await fs.copyFile(path.join(REPO_ROOT, "ralph-viz", name), path.join(outDir, name));
  }
}

async function runDocCandidatePaths(run, options) {
  const prefix = inferDocPrefix(run.shape);
  const candidates = [
    path.join(options.workDir, `${prefix}.config.json`),
    path.join(options.ralphDir, run.shape, "state.json"),
    path.join(options.ralphDir, run.shape, "current-goal.json"),
  ];
  try {
    const entries = await fs.readdir(options.workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(`${prefix}.`) && entry.name.endsWith(".md")) {
        candidates.push(path.join(options.workDir, entry.name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...new Set(candidates.map((filePath) => path.resolve(filePath)))].sort();
}

async function collectDocs(run, options, outRunDir) {
  const docsDir = path.join(outRunDir, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  const docs = [];
  const candidates = await runDocCandidatePaths(run, options);

  const seen = new Set();
  for (const sourcePath of candidates.sort()) {
    const resolved = path.resolve(sourcePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
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
  for (const prefix of ["trusted", "opus", "fable", "mini", "luna"]) {
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

function assignmentReadmePaths(run, options) {
  const worktree = inferRunWorktree(run, options);
  return Array.from({ length: 60 }, (_, index) =>
    path.join(worktree, `pa${index + 1}`, "README.md"));
}

async function staticRunSourcePaths(run, options) {
  return [
    run.filePath,
    ...await runDocCandidatePaths(run, options),
    ...assignmentReadmePaths(run, options),
  ];
}

async function sourceFileSnapshot(filePaths) {
  const unique = [...new Set(filePaths.filter(Boolean).map((filePath) => path.resolve(filePath)))].sort();
  return Promise.all(unique.map(async (filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return {
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { path: filePath, missing: true };
      }
      throw error;
    }
  }));
}

function sourceFileSnapshotSync(filePath) {
  const resolved = path.resolve(filePath);
  try {
    const stat = fsSync.statSync(resolved);
    return {
      path: resolved,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: resolved, missing: true };
    }
    throw error;
  }
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function exportImplementationFingerprint() {
  const sources = [
    SCRIPT_FILE,
    path.join(REPO_ROOT, "scripts", "compare-pa-costs.js"),
    path.join(REPO_ROOT, "subagent-events.js"),
    path.join(REPO_ROOT, "subagent-event-utils.js"),
    path.join(REPO_ROOT, "codex-subagent-events.js"),
    path.join(REPO_ROOT, "claude-subagent-events.js"),
    path.join(REPO_ROOT, "ralph-viz", "assignment-layouts.js"),
    path.join(REPO_ROOT, "ralph-viz", "model-pricing.js"),
  ];
  const hash = createHash("sha256");
  hash.update(String(EXPORT_CACHE_VERSION));
  for (const sourcePath of sources) {
    hash.update(sourcePath);
    hash.update(await fs.readFile(sourcePath));
  }
  return hash.digest("hex");
}

function sourceFingerprint(snapshot, implementation) {
  return fingerprint({ version: EXPORT_CACHE_VERSION, implementation, snapshot });
}

async function prepareRunExport(run, options, previous, implementation) {
  const priorSources = Array.isArray(previous?.exportSources)
    ? previous.exportSources.map((entry) => entry?.path).filter(Boolean)
    : [];
  const sourcePaths = [
    ...await staticRunSourcePaths(run, options),
    ...priorSources,
  ];
  const snapshot = await sourceFileSnapshot(sourcePaths);
  const exportSourceFingerprint = fingerprint(snapshot);
  const exportFingerprint = sourceFingerprint(snapshot, implementation);
  const summaryPath = path.join(options.outDir, "data", "runs", run.safeId, "summary.json");
  const previousSourceFingerprint = previous?.exportSourceFingerprint ?? (
    Array.isArray(previous?.exportSources) ? fingerprint(previous.exportSources) : null
  );
  const reusable = !options.clean &&
    previous?.exportCacheVersion === EXPORT_CACHE_VERSION &&
    previous?.exportSettled === true &&
    previousSourceFingerprint === exportSourceFingerprint &&
    fsSync.existsSync(summaryPath);
  return {
    run,
    previous,
    sourcePaths,
    snapshot,
    exportSourceFingerprint,
    exportFingerprint,
    reusable,
  };
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
  if (!runs.length) {
    return null;
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "compare-pa-costs.js");
  const args = [
    `--max-old-space-size=${COMPARISON_MAX_OLD_SPACE_MB}`,
    scriptPath,
    "--format", "json",
    "--through", options.through,
    "--ralph-dir", options.ralphDir,
    "--codex-dir", options.codexDir,
    "--claude-dir", options.claudeDir,
    ...runs.map((run) => run.spec),
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
  for (const [index, run] of comparison.runs.entries()) {
    const meta =
      metaBySpec.get(run.spec) ??
      metaBySpec.get(run.label) ??
      runMetas.find((candidate) => path.resolve(candidate.filePath ?? "") === path.resolve(run.filePath ?? ""));
    if (meta) {
      run.layout = meta.assignmentLayout;
      run.assignmentTitles = meta.assignmentTitles;
      run.dataPath = meta.dataPath;
      run.repositoryUrl = meta.repositoryUrl;
    }
    run.ordinal = index + 1;
    const baseLabel = String(run.label ?? run.spec ?? `run-${run.ordinal}`)
      .replace(/^\d+-/, "");
    run.label = `${run.ordinal}-${baseLabel}`;
  }
  comparison.assignmentLayouts = ASSIGNMENT_LAYOUT.layouts;
  comparison.displayLayout = "v3";
  const throughNumber = paNumber(comparison.through);
  comparison.series = comparisonSeries({
    ...comparison,
    rows: ASSIGNMENT_LAYOUT.remapComparisonRows(comparison, comparison.displayLayout)
      .slice(0, throughNumber ?? undefined),
  });
  return comparison;
}

function comparisonSeries(comparison) {
  const rows = Array.isArray(comparison?.rows) ? comparison.rows : [];
  const runs = Array.isArray(comparison?.runs) ? comparison.runs : [];
  return runs.map((run, runIndex) => {
    let cost = 0;
    let durationMs = 0;
    let totalDurationMs = 0;
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
        totalDurationMs += Number(summary.totalDurationMs ?? summary.durationMs ?? 0) || 0;
        return [{
          pa: row.pa,
          index,
          status: summary.status ?? "complete",
          cost,
          durationMs,
          totalDurationMs,
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
    (Number(summary.totalDurationMs ?? 0) || 0) > 0 ||
    (Number(summary.cost ?? 0) || 0) > 0 ||
    summary.status === "partial" ||
    summary.status === "complete";
}

function comparisonRunForExport(comparison, run) {
  return comparison?.runs?.find((candidate) =>
    candidate.spec === run.spec ||
    candidate.label === run.spec ||
    candidate.label === run.label ||
    path.resolve(candidate.filePath ?? "") === path.resolve(run.filePath)) ?? null;
}

function comparisonRunIndex(comparison, run) {
  return (comparison?.runs ?? []).findIndex((candidate) =>
    candidate.spec === run.spec ||
    candidate.label === run.spec ||
    candidate.label === run.label ||
    path.resolve(candidate.filePath ?? "") === path.resolve(run.filePath));
}

export function mergeComparisonUpdates(previous, updated, runs) {
  if (!previous || !updated) {
    return updated ?? previous ?? null;
  }
  const previousRows = new Map((previous.rows ?? []).map((row) => [row.pa, row]));
  const updatedRows = new Map((updated.rows ?? []).map((row) => [row.pa, row]));
  const selected = runs.map((run) => {
    const updatedIndex = comparisonRunIndex(updated, run);
    if (updatedIndex >= 0) {
      return { comparison: updated, index: updatedIndex, run };
    }
    const previousIndex = comparisonRunIndex(previous, run);
    if (previousIndex >= 0) {
      return { comparison: previous, index: previousIndex, run };
    }
    throw new Error(`comparison is missing run ${run.spec}`);
  });
  const paNames = [...new Set([
    ...(previous.rows ?? []).map((row) => row.pa),
    ...(updated.rows ?? []).map((row) => row.pa),
  ])].sort((left, right) => paNumber(left) - paNumber(right));
  return {
    ...previous,
    ...updated,
    runs: selected.map(({ comparison, index, run }) => ({
      ...comparison.runs[index],
      label: run.label,
      spec: run.spec,
      filePath: run.filePath,
    })),
    rows: paNames.map((pa) => ({
      pa,
      runs: selected.map(({ comparison, index }) => {
        const row = comparison === updated ? updatedRows.get(pa) : previousRows.get(pa);
        return row?.runs?.[index] ?? null;
      }),
    })),
  };
}

async function exportRun(run, options, comparison, prepared, implementation) {
  const outRunDir = path.join(options.outDir, "data", "runs", run.safeId);
  const turnsDir = path.join(outRunDir, "turns");
  await fs.mkdir(turnsDir, { recursive: true });
  const sourcePaths = new Set(prepared.sourcePaths.map((filePath) => path.resolve(filePath)));
  const initialSources = new Map(prepared.snapshot.map((entry) => [entry.path, entry]));
  const onSourceFile = (filePath) => {
    const resolved = path.resolve(filePath);
    sourcePaths.add(resolved);
    if (!initialSources.has(resolved)) {
      initialSources.set(resolved, sourceFileSnapshotSync(resolved));
    }
  };
  const runEvents = await readJsonl(run.filePath);
  const codexUsageEvents = await collectCodexUsageEvents(runEvents, options, onSourceFile);
  const subagentEvents = await collectSubagentEvents(runEvents, {
    claudeDir: options.claudeDir,
    codexDir: path.basename(options.codexDir) === "sessions"
      ? path.dirname(options.codexDir)
      : options.codexDir,
    onSourceFile,
  });
  const events = mergeEventsByTime(
    mergeEventsByTime(runEvents, codexUsageEvents),
    subagentEvents,
  );
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
  const assignmentLayout = await inferAssignmentLayout(run, options);
  const assignmentTitles = await collectAssignmentTitles(run, options);
  const state = await readRunStateSummary(run);
  const bounds = eventTimeBounds(events);
  const comparisonRun = comparisonRunForExport(comparison, run);
  const total = comparisonRun?.total ?? null;
  const shapeUsage = total?.usage
    ? {
        runCount: 1,
        threadCount: null,
        durationMs: total.durationMs ?? 0,
        usage: total.usage,
        cost: total.cost ?? 0,
        runs: [{
          id: `${run.id}/run`,
          threadId: null,
          threadIds: [],
          durationMs: total.durationMs ?? 0,
          turnDurations: comparisonRun?.turnDurations ?? [],
          turnUsages: comparisonRun?.turnUsages ?? [],
          usage: total.usage,
        }],
      }
    : null;
  const exportSources = await sourceFileSnapshot([...sourcePaths]);
  const initialExportSources = [...initialSources.values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const initialExportFingerprint = sourceFingerprint(initialExportSources, implementation);
  const finalExportFingerprint = sourceFingerprint(exportSources, implementation);
  const runMeta = {
    id: run.id,
    label: run.label,
    repositoryUrl: RUN_REPOSITORIES.get(inferDocPrefix(run.shape)) ?? null,
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
    syntheticSubagentEventCount: subagentEvents.length,
    turnCount: turns.length,
    first: bounds.first,
    last: bounds.last,
    state,
    exportCacheVersion: EXPORT_CACHE_VERSION,
    exportSourceFingerprint: fingerprint(exportSources),
    exportFingerprint: finalExportFingerprint,
    exportSettled: finalExportFingerprint === initialExportFingerprint,
    exportSources,
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
    syntheticSubagentEventCount: subagentEvents.length,
    ...bounds,
  });
  return runMeta;
}

async function collectCodexUsageEvents(events, options, onSourceFile = null) {
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
      onSourceFile?.(filePath);
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

function comparisonExportFingerprint(options, preparedRuns, implementation) {
  return fingerprint({
    version: EXPORT_CACHE_VERSION,
    implementation,
    through: options.through,
    runs: preparedRuns.map((prepared) => ({
      id: prepared.run.id,
      spec: prepared.run.spec,
      fingerprint: prepared.exportFingerprint,
    })),
  });
}

async function readPreviousComparisonArtifact(previousManifest, options) {
  if (!previousManifest) {
    return null;
  }
  const entry = previousManifest.comparisons?.[0];
  if (!entry?.path) {
    return null;
  }
  const filePath = path.join(options.outDir, "data", entry.path);
  const comparison = await readJsonIfExists(filePath);
  return comparison ? { comparison, entries: previousManifest.comparisons } : null;
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

function comparisonContainsRun(comparison, run) {
  return comparisonRunIndex(comparison, run) >= 0;
}

function combineComparisonBaselines(published, local, runs, through) {
  const publishedMatch = published?.through === through ? published : null;
  const localMatch = local?.through === through ? local : null;
  const represented = runs.filter((run) =>
    comparisonContainsRun(publishedMatch, run) || comparisonContainsRun(localMatch, run));
  if (!represented.length) return null;
  if (!publishedMatch) {
    return mergeComparisonUpdates(localMatch, localMatch, represented);
  }
  if (!localMatch) {
    return mergeComparisonUpdates(publishedMatch, publishedMatch, represented);
  }
  return artifactTimestamp(publishedMatch) > artifactTimestamp(localMatch)
    ? mergeComparisonUpdates(localMatch, publishedMatch, represented)
    : mergeComparisonUpdates(publishedMatch, localMatch, represented);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifestPath = path.join(options.outDir, "data", "runs.json");
  const localManifest = await readJsonIfExists(manifestPath);
  const localComparison = localManifest
    ? await readPreviousComparisonArtifact(localManifest, options)
    : null;

  const resolvedRuns = new Map();
  const missingSpecs = [];
  for (const spec of options.runs) {
    try {
      resolvedRuns.set(spec, await resolveRun(spec, options.ralphDir));
    } catch (error) {
      missingSpecs.push(spec);
      console.warn(`local source unavailable for ${spec}: ${error.message}`);
    }
  }

  const needsPublishedBaseline = missingSpecs.length > 0;
  let publishedBaseline = null;
  if (needsPublishedBaseline && options.publishedBaseUrl) {
    try {
      publishedBaseline = await readPublishedBaseline(options);
      console.error(`loaded archived-run baseline from ${options.publishedBaseUrl}`);
    } catch (error) {
      console.warn(`published baseline unavailable: ${error.message}`);
    }
  }

  const entries = [];
  const unresolvedSpecs = [];
  for (const spec of options.runs) {
    const run = resolvedRuns.get(spec);
    if (run) {
      entries.push({ kind: "live", spec, run });
      continue;
    }
    const meta = newerArtifact(
      runMetaForSpec(localManifest, spec),
      runMetaForSpec(publishedBaseline?.manifest, spec),
    );
    if (!meta) {
      unresolvedSpecs.push(spec);
      continue;
    }
    entries.push({
      kind: "retained",
      spec,
      run: retainedRunIdentity(spec, meta),
      meta: { ...meta, exportRetained: true, exportSettled: true },
    });
    console.error(`retaining archived ${spec}`);
  }
  if (unresolvedSpecs.length) {
    throw new Error(
      `cannot safely export; no local or published artifact for: ${unresolvedSpecs.join(", ")}`,
    );
  }
  if (!entries.length) {
    throw new Error("no runs resolved or retained");
  }

  await cleanOutput(options);
  await copyViewerAssets(options.outDir);

  const implementation = await exportImplementationFingerprint();
  const previousRuns = new Map((localManifest?.runs ?? []).map((run) => [run.id, run]));
  const preparedLiveRuns = [];
  const preparedById = new Map();
  for (const entry of entries.filter((candidate) => candidate.kind === "live")) {
    const prepared = await prepareRunExport(
      entry.run,
      options,
      previousRuns.get(entry.run.id) ?? null,
      implementation,
    );
    preparedLiveRuns.push(prepared);
    preparedById.set(entry.run.id, prepared);
  }

  const comparisonPrepared = entries.map((entry) =>
    entry.kind === "live"
      ? preparedById.get(entry.run.id)
      : {
          run: entry.run,
          exportFingerprint: entry.meta.exportFingerprint ?? fingerprint({
            id: entry.meta.id,
            size: entry.meta.size,
            eventMtime: entry.meta.eventMtime,
          }),
        });

  const expectedComparisonFingerprint = comparisonExportFingerprint(
    options,
    comparisonPrepared,
    implementation,
  );
  const reusedComparison = options.compare &&
    localManifest?.source?.comparisonFingerprint === expectedComparisonFingerprint &&
    localComparison
      ? localComparison
      : null;
  const catalogRuns = entries.map((entry) => entry.run);
  const priorComparison = options.compare && !reusedComparison
    ? combineComparisonBaselines(
        publishedBaseline?.comparison,
        localComparison?.comparison,
        catalogRuns,
        options.through,
      )
    : null;
  let comparison = reusedComparison?.comparison ?? null;
  if (reusedComparison) {
    console.error("reusing unchanged comparison");
  } else if (options.compare) {
    const canUpdateIncrementally = Boolean(priorComparison);
    const publishedComparisonIsNewer = artifactTimestamp(publishedBaseline?.comparison) >
      artifactTimestamp(localComparison?.comparison);
    const baselineImplementation = publishedComparisonIsNewer
      ? publishedBaseline?.manifest?.source?.implementationFingerprint
      : localComparison
        ? localManifest?.source?.implementationFingerprint
        : publishedBaseline?.manifest?.source?.implementationFingerprint;
    const implementationMatches = baselineImplementation === implementation;
    const comparisonRuns = canUpdateIncrementally
      ? preparedLiveRuns
          .filter((prepared) => !implementationMatches || !prepared.reusable)
          .map((prepared) => prepared.run)
      : preparedLiveRuns.map((prepared) => prepared.run);
    if (canUpdateIncrementally && comparisonRuns.length < catalogRuns.length) {
      console.error(
        `updating comparison from ${comparisonRuns.length} changed run` +
        `${comparisonRuns.length === 1 ? "" : "s"}`,
      );
    }
    const updates = comparisonRuns.length
      ? await buildComparison(options, comparisonRuns)
      : null;
    if (canUpdateIncrementally) {
      if (comparisonRuns.length && !updates) {
        console.warn("comparison update failed; retaining the previous comparison unchanged");
      }
      comparison = updates
        ? mergeComparisonUpdates(priorComparison, updates, catalogRuns)
        : priorComparison;
    } else {
      const retained = entries.filter((entry) => entry.kind === "retained");
      if (retained.length) {
        throw new Error(
          "cannot safely rebuild comparison: archived runs require a matching prior comparison",
        );
      }
      if (!updates) {
        throw new Error("comparison generation failed and no prior comparison is available");
      }
      comparison = updates;
    }
  }

  const runMetas = [];
  let reusedRunCount = 0;
  let retainedRunCount = 0;
  for (const entry of entries) {
    if (entry.kind === "retained") {
      runMetas.push(entry.meta);
      reusedRunCount += 1;
      retainedRunCount += 1;
      continue;
    }
    const prepared = preparedById.get(entry.run.id);
    if (prepared.reusable) {
      console.error(`reusing unchanged ${prepared.run.id}`);
      runMetas.push(prepared.previous);
      reusedRunCount += 1;
      continue;
    }
    console.error(`exporting ${prepared.run.id}`);
    runMetas.push(await exportRun(
      prepared.run,
      options,
      comparison,
      prepared,
      implementation,
    ));
  }

  let comparisons = [];
  if (reusedComparison) {
    comparisons = reusedComparison.entries;
  } else {
    annotateComparison(comparison, runMetas);
    comparisons = await writeComparison(options, comparison);
  }
  const allExportsSettled = runMetas.every((run) => run.exportSettled === true);
  const finalMetaById = new Map(runMetas.map((run) => [run.id, run]));
  const finalComparisonFingerprint = comparison && allExportsSettled
    ? comparisonExportFingerprint(
        options,
        entries.map((entry) => ({
          run: entry.run,
          exportFingerprint: finalMetaById.get(entry.run.id)?.exportFingerprint ??
            comparisonPrepared.find((prepared) => prepared.run.id === entry.run.id)
              ?.exportFingerprint,
        })),
        implementation,
      )
    : null;
  await writeJson(manifestPath, {
    formatVersion: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      ralphDir: options.ralphDir,
      codexDir: options.codexDir,
      claudeDir: options.claudeDir,
      workDir: options.workDir,
      through: options.through,
      exportCacheVersion: EXPORT_CACHE_VERSION,
      implementationFingerprint: implementation,
      comparisonFingerprint: finalComparisonFingerprint,
      reusedRuns: reusedRunCount,
      retainedRuns: retainedRunCount,
      exportedRuns: runMetas.length - reusedRunCount,
      comparisonReused: Boolean(reusedComparison),
    },
    runs: runMetas,
    comparisons,
  });
  console.log(
    `Exported ${runMetas.length} runs to ${options.outDir} ` +
    `(${reusedRunCount} reused, ${retainedRunCount} retained, ` +
    `${runMetas.length - reusedRunCount} rebuilt)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exit(1);
  });
}
