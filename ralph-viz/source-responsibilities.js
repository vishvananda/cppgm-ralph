import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const baselines = new Map();

export function parseSourceResponsibilities(text, sources, { historical = false } = {}) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.shift() !== "cpp_source\trust_owner\tstatus") return null;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) return null;
  const expected = new Set(sources);
  const rows = new Map();
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3 || rows.has(fields[0])) return null;
    rows.set(fields[0], fields);
  }
  if (!historical && (rows.size !== expected.size || [...rows.keys()].some(key => !expected.has(key)))) return null;
  const owners = new Set();
  let complete = 0;
  for (const source of expected) {
    const row = rows.get(source);
    if (!row || row[2] !== "complete" || !row[1]) continue;
    const paths = row[1].split(",");
    if (paths.some(owner => path.isAbsolute(owner) || owner.split(/[\\/]/).includes(".."))) return null;
    paths.forEach(owner => owners.add(owner));
    complete++;
  }
  return { complete, total: sources.length, owners: [...owners] };
}

async function readBaseline(workdir, startedAt, sources) {
  const key = JSON.stringify([workdir, startedAt, sources]);
  if (!baselines.has(key)) {
    baselines.set(key, (async () => {
      try {
        const { stdout: revision } = await execFileAsync("git", ["log", "-1", "--format=%H",
          `--before=${startedAt}`, "--", "docs/port/source-map.tsv"], { cwd: workdir, timeout: 3000 });
        if (!/^[0-9a-f]{40}\s*$/.test(revision)) return null;
        const { stdout } = await execFileAsync("git", ["show", `${revision.trim()}:docs/port/source-map.tsv`],
          { cwd: workdir, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
        return parseSourceResponsibilities(stdout, sources, { historical: true });
      } catch { return null; }
    })());
    if (baselines.size > 64) baselines.delete(baselines.keys().next().value);
  }
  return baselines.get(key);
}

async function readStageTests(workdir, manifestText) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(workdir, "scripts/clone/settings.json"), "utf8"));
    if (!path.isAbsolute(settings.artifacts ?? "")) return null;
    const reportPath = path.join(settings.artifacts, "results/pa33.json");
    const [text, stat] = await Promise.all([fs.readFile(reportPath, "utf8"), fs.stat(reportPath)]);
    const report = JSON.parse(text);
    const manifest = JSON.parse(manifestText);
    if (report.stage !== "pa33" || report.manifest_sha256 !== createHash("sha256").update(manifestText).digest("hex") ||
        !Array.isArray(report.results) || !report.results.length) return null;
    const cases = new Set(report.results.map(row => row.case));
    if (cases.size !== report.results.length ||
        report.results.some(row => typeof row.case !== "string" || typeof row.passed !== "boolean") ||
        !Array.isArray(manifest.stages?.pa33) || manifest.stages.pa33.some(name => !cases.has(name))) return null;
    return { passed: report.results.filter(row => row.passed).length, total: report.results.length,
      recordedAt: stat.mtime.toISOString() };
  } catch { return null; }
}

// Viewer-only evidence: never modify the worker's ledger, checks or run log.
export async function augmentSourceResponsibilityProgress(events, workdir, statePath) {
  if (!workdir || !events.length) return;
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.activeStage !== "pa33") return;
    const turn = state.activeTurn?.turnNumber ?? state.turnsCompleted;
    const phase = events.find(record => record.turnNumber === turn &&
      record.eventType === "ralph.phase-status" && record.event?.phaseStatus?.stage === "pa33");
    if (!phase) return;
    const [manifestText, mapText] = await Promise.all([
      fs.readFile(path.join(workdir, "scripts/clone/manifest.json"), "utf8"),
      fs.readFile(path.join(workdir, "docs/port/source-map.tsv"), "utf8"),
    ]);
    const sources = JSON.parse(manifestText).source_responsibilities;
    const current = parseSourceResponsibilities(mapText, sources);
    if (!current) return;
    // Match clone_check.py: a completed row must name existing implementation files.
    const existing = await Promise.all(current.owners.map(async owner => {
      try { return (await fs.stat(path.join(workdir, owner))).isFile(); }
      catch { return false; }
    }));
    if (existing.some(value => !value)) return;
    const [start, tests] = await Promise.all([
      readBaseline(workdir, phase.recordedAt, sources), readStageTests(workdir, manifestText),
    ]);
    events.push({ recordedAt: new Date().toISOString(), threadId: phase.threadId,
      turnNumber: turn, eventType: "ralph.source-progress", event: {
        sourceProgress: { stage: "pa33", tests, current: { passed: current.complete, total: current.total },
          start: start ? { passed: start.complete, total: start.total } : null },
      } });
  } catch (error) {
    // An absent or mid-write ledger must not prevent the rest of a run loading.
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.warn("source responsibility progress unavailable:", error.message);
    }
  }
}
