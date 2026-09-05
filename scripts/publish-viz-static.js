#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_SOURCE = "/dev/shm/ralph-viz-static-qol";
const DEFAULT_BUCKET = "gs://ralph-run-viewer-zippy-960";
const CATALOG_EXCLUDES = [
  "data/runs[.]json$",
  "data/comparisons/pa-costs[.]json$",
];

function usage() {
  return `Usage: node scripts/publish-viz-static.js [options]

Publish an exported Ralph visualization without dropping archived runs.

Options:
  --source <dir>       Static export directory (default: ${DEFAULT_SOURCE})
  --bucket <gs://...>  Published bucket (default: ${DEFAULT_BUCKET})
  --dry-run            Validate and show the object sync without uploading
  --help               Show this help
`;
}

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    bucket: DEFAULT_BUCKET,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      index += 1;
      return argv[index];
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--source") {
      options.source = path.resolve(next());
    } else if (arg === "--bucket") {
      options.bucket = next().replace(/\/+$/, "");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.bucket.startsWith("gs://")) {
    throw new Error("--bucket must be a gs:// URL");
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readGcsJson(uri) {
  const { stdout } = await execFileAsync("gcloud", ["storage", "cat", uri], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function comparisonRunKey(run) {
  return run?.spec ?? String(run?.label ?? "").replace(/^\d+-/, "");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function publishExcludePattern(manifest) {
  const retainedRunPaths = (manifest?.runs ?? [])
    .filter((run) => run.exportRetained === true)
    .map((run) => `data/runs/${escapeRegex(run.safeId)}/`);
  return [...CATALOG_EXCLUDES, ...retainedRunPaths].join("|");
}

export function assertPublishedCatalogPreserved(
  localManifest,
  publishedManifest,
  localComparison,
  publishedComparison,
) {
  const localRunIds = new Set((localManifest?.runs ?? []).map((run) => run.id));
  const missingRunIds = (publishedManifest?.runs ?? [])
    .map((run) => run.id)
    .filter((id) => !localRunIds.has(id));
  if (missingRunIds.length) {
    throw new Error(
      `refusing to publish: export drops published runs: ${missingRunIds.join(", ")}`,
    );
  }

  const localComparisonRuns = new Set(
    (localComparison?.runs ?? []).map(comparisonRunKey).filter(Boolean),
  );
  const missingComparisonRuns = (publishedComparison?.runs ?? [])
    .map(comparisonRunKey)
    .filter((id) => id && !localComparisonRuns.has(id));
  if (missingComparisonRuns.length) {
    throw new Error(
      "refusing to publish: comparison drops published runs: " +
      missingComparisonRuns.join(", "),
    );
  }

  const localRows = new Map((localComparison?.rows ?? []).map((row) => [row.pa, row]));
  const localComparisonIndex = new Map(
    (localComparison?.runs ?? []).map((run, index) => [comparisonRunKey(run), index]),
  );
  for (const publishedRow of publishedComparison?.rows ?? []) {
    const localRow = localRows.get(publishedRow.pa);
    if (!localRow) {
      throw new Error(
        `refusing to publish: comparison drops published row ${publishedRow.pa}`,
      );
    }
    for (const [publishedIndex, publishedSummary] of
      (publishedRow.runs ?? []).entries()) {
      if (publishedSummary == null) continue;
      const runKey = comparisonRunKey(publishedComparison.runs?.[publishedIndex]);
      const localIndex = localComparisonIndex.get(runKey);
      if (localIndex == null || localRow.runs?.[localIndex] == null) {
        throw new Error(
          `refusing to publish: comparison drops ${runKey} data at ${publishedRow.pa}`,
        );
      }
    }
  }
}

async function runGcloud(args) {
  const child = spawn("gcloud", args, { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`gcloud exited ${code ?? signal}`));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const localManifestPath = path.join(options.source, "data", "runs.json");
  const localManifest = await readJson(localManifestPath);
  const localComparisonEntry = localManifest.comparisons?.[0];
  if (!localComparisonEntry?.path) {
    throw new Error("local export has no comparison artifact");
  }
  const localComparisonPath = path.join(
    options.source,
    "data",
    localComparisonEntry.path,
  );
  const [localComparison, publishedManifest] = await Promise.all([
    readJson(localComparisonPath),
    readGcsJson(`${options.bucket}/data/runs.json`),
  ]);
  const publishedComparisonEntry = publishedManifest.comparisons?.[0];
  if (!publishedComparisonEntry?.path) {
    throw new Error("published export has no comparison artifact");
  }
  const publishedComparison = await readGcsJson(
    `${options.bucket}/data/${publishedComparisonEntry.path}`,
  );

  assertPublishedCatalogPreserved(
    localManifest,
    publishedManifest,
    localComparison,
    publishedComparison,
  );

  const rsyncArgs = [
    "storage", "rsync", options.source, options.bucket,
    "--recursive", "--exclude", publishExcludePattern(localManifest),
  ];
  if (options.dryRun) {
    rsyncArgs.push("--dry-run");
    await runGcloud(rsyncArgs);
    console.log(
      `Validated ${localManifest.runs.length} runs; catalogs would be published last.`,
    );
    return;
  }

  const snapshot = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotBase = `${options.bucket}/history/${snapshot}`;
  await runGcloud([
    "storage", "cp", `${options.bucket}/data/runs.json`,
    `${snapshotBase}/runs.json`,
  ]);
  await runGcloud([
    "storage", "cp",
    `${options.bucket}/data/${publishedComparisonEntry.path}`,
    `${snapshotBase}/pa-costs.json`,
  ]);
  await runGcloud(rsyncArgs);
  await runGcloud([
    "storage", "cp", localComparisonPath,
    `${options.bucket}/data/${localComparisonEntry.path}`,
  ]);
  await runGcloud([
    "storage", "cp", localManifestPath,
    `${options.bucket}/data/runs.json`,
  ]);
  console.log(
    `Published ${localManifest.runs.length} runs without deleting destination-only artifacts; ` +
    `previous catalogs saved under ${snapshotBase}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exit(1);
  });
}
