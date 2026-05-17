#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_WORK_BASE = "/home/vishvananda/work";
const DEFAULT_ASSIGNMENT_REPO = "/home/vishvananda/cppgm-assignments";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING = "xhigh";
const DEFAULT_TEST_COMMAND = "make test-report-through-paX";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const sourceRun = required(options.sourceRun, "--source-run");
  const targetRun = required(options.targetRun, "--target-run");
  const throughStage = normalizeStage(required(options.through, "--through"));
  const workBase = path.resolve(options.workBase ?? DEFAULT_WORK_BASE);
  const assignmentRepo = path.resolve(options.assignmentRepo ?? DEFAULT_ASSIGNMENT_REPO);
  const sourceWorkdir = path.resolve(options.sourceWorkdir ?? path.join(workBase, sourceRun));
  const targetWorkdir = path.resolve(options.targetWorkdir ?? path.join(workBase, targetRun));
  const sourceConfigPath = path.resolve(options.sourceConfig ?? path.join(workBase, `${sourceRun}.config.json`));
  const targetConfigPath = path.resolve(options.targetConfig ?? path.join(workBase, `${targetRun}.config.json`));
  const sourcePromptPath = path.resolve(options.sourcePrompt ?? path.join(workBase, `${sourceRun}.default.md`));
  const targetPromptPath = path.resolve(options.targetPrompt ?? path.join(workBase, `${targetRun}.default.md`));
  const sourceRef = options.sourceRef ?? "main";
  const remoteUrl = options.remote ?? null;
  const push = options.push ?? Boolean(remoteUrl);
  const runTest = options.test ?? true;
  const updateAssignments = options.updateAssignments ?? true;

  await assertMissing(targetWorkdir, "target workdir");
  await assertMissing(targetConfigPath, "target config");
  await assertDirectory(sourceWorkdir, "source workdir");
  await assertDirectory(assignmentRepo, "assignment repo");

  if (updateAssignments) {
    await run(["git", "fetch", "origin"], { cwd: assignmentRepo, label: "fetch assignment repo" });
    await run(["git", "pull", "--ff-only"], { cwd: assignmentRepo, label: "update assignment repo" });
  }

  const sourceConfig = await readJsonIfExists(sourceConfigPath);
  const targetConfig = buildTargetConfig({
    sourceConfig,
    targetRun,
    targetWorkdir,
    workBase,
  });
  const runName = buildRunName({
    name: targetConfig.name,
    model: targetConfig.model,
    reasoningEffort: targetConfig.reasoningEffort,
  });
  const stateBaseDir = path.resolve(targetConfig.stateBaseDir ?? path.join(workBase, ".ralph"));
  const stateDir = path.join(stateBaseDir, runName);

  await run(["git", "clone", assignmentRepo, targetWorkdir], { label: "clone assignment repo" });
  if (remoteUrl) {
    await run(["git", "remote", "set-url", "origin", remoteUrl], {
      cwd: targetWorkdir,
      label: "set target origin",
    });
  }

  await run(["git", "remote", "add", "fork-source", sourceWorkdir], {
    cwd: targetWorkdir,
    label: "add source remote",
  });
  await run(["git", "fetch", "fork-source"], { cwd: targetWorkdir, label: "fetch source run" });

  const targetBase = await gitOutput(["rev-parse", "HEAD"], targetWorkdir);
  const sourceFullRef = `fork-source/${sourceRef}`;
  const sourceTip = await gitOutput(["rev-parse", sourceFullRef], targetWorkdir);
  const base = await gitOutput(["merge-base", targetBase, sourceTip], targetWorkdir);
  const boundaryCommit = options.throughRef
    ? await gitOutput(["rev-parse", options.throughRef], targetWorkdir)
    : await findBoundaryCommit({
        cwd: targetWorkdir,
        base,
        sourceFullRef,
        throughStage,
      });

  log(`assignment base: ${targetBase}`);
  log(`source tip:      ${sourceTip}`);
  log(`merge base:      ${base}`);
  log(`boundary commit: ${boundaryCommit} (${throughStage})`);

  await run(["git", "cherry-pick", `${base}..${boundaryCommit}`], {
    cwd: targetWorkdir,
    label: `cherry-pick through ${throughStage}`,
  });
  await run(["git", "remote", "remove", "fork-source"], {
    cwd: targetWorkdir,
    label: "remove source remote",
  });

  const primaryCheckCommandTemplate = getPrimaryCheckCommandTemplate(targetConfig);
  const renderedTestCommand = renderTestCommand(primaryCheckCommandTemplate, throughStage);
  let testSummary = {
    stageNames: buildStageNames(stageNumber(throughStage)),
    testsPassed: 0,
    testsTotal: 0,
  };
  if (runTest) {
    const result = await runShell(renderedTestCommand, {
      cwd: targetWorkdir,
      label: renderedTestCommand,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      process.stdout.write(result.output);
      throw new Error(`${renderedTestCommand} failed with exit code ${result.exitCode}`);
    }
    process.stdout.write(result.output);
    testSummary = parsePassingTestOutput(result.output, throughStage);
  }

  await fs.writeFile(targetConfigPath, `${JSON.stringify(targetConfig, null, 2)}\n`, "utf8");
  await copyPromptIfNeeded(sourcePromptPath, targetPromptPath);
  await copySidecarTemplates(sourceConfigPath, targetConfigPath);
  await writeSeedState({
    stateDir,
    throughStage,
    targetConfig,
    primaryCheckCommandTemplate,
    renderedTestCommand,
    testSummary,
  });

  if (push) {
    await run(["git", "push", "-u", "origin", "main"], { cwd: targetWorkdir, label: "push target run" });
  }

  log(`created ${targetWorkdir}`);
  log(`wrote ${targetConfigPath}`);
  log(`seeded ${path.join(stateDir, "state.json")} with activeStage=${nextStage(throughStage)}`);
}

function parseArgs(argv) {
  const options = {};
  const keyMap = {
    "--source-run": "sourceRun",
    "--target-run": "targetRun",
    "--through": "through",
    "--remote": "remote",
    "--work-base": "workBase",
    "--assignment-repo": "assignmentRepo",
    "--source-workdir": "sourceWorkdir",
    "--target-workdir": "targetWorkdir",
    "--source-config": "sourceConfig",
    "--target-config": "targetConfig",
    "--source-prompt": "sourcePrompt",
    "--target-prompt": "targetPrompt",
    "--source-ref": "sourceRef",
    "--through-ref": "throughRef",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--push") {
      options.push = true;
      continue;
    }
    if (arg === "--no-push") {
      options.push = false;
      continue;
    }
    if (arg === "--no-test") {
      options.test = false;
      continue;
    }
    if (arg === "--no-update-assignments") {
      options.updateAssignments = false;
      continue;
    }

    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = keyMap[rawKey];
    if (!key) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`${rawKey} requires a value`);
    }
    if (inlineValue == null) {
      index += 1;
    }
    options[key] = value;
  }

  return options;
}

function printUsage() {
  process.stdout.write(`Usage:
  npm run fork-run -- \\
    --source-run arch-2026-05-15 \\
    --target-run arch2-2026-05-15 \\
    --through pa8 \\
    --remote git@github.com:vishvananda/cppgm-run-arch2.git

Options:
  --source-run NAME          Existing run directory name under --work-base.
  --target-run NAME          New run directory/config name under --work-base.
  --through paN              Include source commits through this PA boundary.
  --remote URL               Set target origin to this URL. Implies --push.
  --through-ref REF          Use an exact source commit/ref instead of commit-message PA detection.
  --assignment-repo PATH     Source assignment repository. Default: ${DEFAULT_ASSIGNMENT_REPO}
  --work-base PATH           Work directory base. Default: ${DEFAULT_WORK_BASE}
  --source-ref REF           Source branch fetched from the source run. Default: main
  --no-test                  Skip the boundary test before seeding state.
  --no-push                  Do not push even when --remote is supplied.
  --no-update-assignments    Do not fetch/pull the assignment repo before cloning.
`);
}

function required(value, flag) {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function buildTargetConfig({ sourceConfig, targetRun, targetWorkdir, workBase }) {
  return {
    ...sourceConfig,
    baseDir: sourceConfig.baseDir ?? workBase,
    workdir: targetWorkdir,
    useExistingWorkdir: true,
    name: targetRun,
    testCommand: sourceConfig.testCommand ?? DEFAULT_TEST_COMMAND,
    maxTurns: sourceConfig.maxTurns ?? 30,
    stateBaseDir: sourceConfig.stateBaseDir ?? path.join(workBase, ".ralph"),
    model: sourceConfig.model ?? DEFAULT_MODEL,
    reasoningEffort: sourceConfig.reasoningEffort ?? DEFAULT_REASONING,
    sandboxMode: sourceConfig.sandboxMode ?? "danger-full-access",
    approvalPolicy: sourceConfig.approvalPolicy ?? "never",
    networkAccessEnabled: sourceConfig.networkAccessEnabled ?? true,
    webSearchEnabled: sourceConfig.webSearchEnabled ?? true,
    additionalDirectories: sourceConfig.additionalDirectories ?? [],
    outputTailChars: sourceConfig.outputTailChars ?? 20000,
    codexPath: sourceConfig.codexPath ?? "/usr/local/bin/codex",
    loopGoalsEnabled: sourceConfig.loopGoalsEnabled ?? true,
    goalTokenBudget: sourceConfig.goalTokenBudget ?? null,
  };
}

async function findBoundaryCommit({ cwd, base, sourceFullRef, throughStage }) {
  const logOutput = await gitOutput(["log", "--reverse", "--format=%H%x00%s", `${base}..${sourceFullRef}`], cwd);
  const stage = throughStage.toLowerCase();
  let match = null;
  for (const line of logOutput.split("\n").filter(Boolean)) {
    const [hash, subject] = line.split("\0");
    if (new RegExp(`\\b${stage}\\b`, "i").test(subject ?? "")) {
      match = hash;
    }
  }
  if (!match) {
    throw new Error(`Could not find a source commit whose subject mentions ${throughStage}; pass --through-ref`);
  }
  return match;
}

async function copyPromptIfNeeded(sourcePromptPath, targetPromptPath) {
  if (await pathExists(targetPromptPath)) {
    log(`kept existing prompt ${targetPromptPath}`);
    return;
  }
  if (!(await pathExists(sourcePromptPath))) {
    log(`no source prompt found at ${sourcePromptPath}`);
    return;
  }
  await fs.copyFile(sourcePromptPath, targetPromptPath);
  log(`copied prompt ${sourcePromptPath} -> ${targetPromptPath}`);
}

async function copySidecarTemplates(sourceConfigPath, targetConfigPath) {
  const sourceBase = buildSidecarTemplateBasePath(sourceConfigPath);
  const targetBase = buildSidecarTemplateBasePath(targetConfigPath);
  const sourceDir = path.dirname(sourceBase);
  const sourcePrefix = `${path.basename(sourceBase)}.`;

  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(sourcePrefix) || !entry.name.endsWith(".md")) {
      continue;
    }
    const suffix = entry.name.slice(sourcePrefix.length);
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = `${targetBase}.${suffix}`;
    if (await pathExists(targetPath)) {
      log(`kept existing sidecar ${targetPath}`);
      continue;
    }
    await fs.copyFile(sourcePath, targetPath);
    log(`copied sidecar ${sourcePath} -> ${targetPath}`);
  }
}

function buildSidecarTemplateBasePath(configPath) {
  const directory = path.dirname(configPath);
  const basename = path.basename(configPath);
  const stem = basename.endsWith(".config.json")
    ? basename.slice(0, -".config.json".length)
    : basename.endsWith(".json")
      ? basename.slice(0, -".json".length)
      : basename;
  return path.join(directory, stem);
}

async function writeSeedState({
  stateDir,
  throughStage,
  targetConfig,
  primaryCheckCommandTemplate,
  renderedTestCommand,
  testSummary,
}) {
  await fs.mkdir(path.join(stateDir, "events"), { recursive: true });
  const stages = testSummary.stageNames.map((stageName) => ({
    name: stageName,
    status: "pass",
    passed: 0,
    total: 0,
    failed: 0,
    timeouts: 0,
    timeoutExpectations: 0,
    targets: [],
  }));
  const state = {
    threadId: null,
    eventLogPath: null,
    turnsCompleted: stageNumber(throughStage),
    lastExitCode: 0,
    lastTestStatus: {
      recordedAt: new Date().toISOString(),
      command: renderedTestCommand,
      commandTemplate: primaryCheckCommandTemplate,
      targetStage: throughStage,
      usesStageTemplate: hasStagePlaceholder(primaryCheckCommandTemplate),
      exitCode: 0,
      allTestsPassed: true,
      stageCount: stages.length,
      stagesPassed: stages.length,
      testsPassed: testSummary.testsPassed,
      testsTotal: testSummary.testsTotal,
      failingStage: null,
      passingThrough: throughStage,
      firstFailureLine: null,
      firstFailureKind: null,
      timeoutFailures: 0,
      timeoutExpectationFailures: 0,
      regressions: [],
      stages,
    },
    activeStage: nextStage(throughStage),
    activePhase: getFirstPhaseName(targetConfig),
    phaseAttempted: false,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getPrimaryCheckCommandTemplate(config) {
  const checks = normalizeCheckEntries(config.checks);
  if (checks.length === 0) {
    return config.testCommand ?? DEFAULT_TEST_COMMAND;
  }
  const primary =
    checks.find((check) => check.primary) ??
    checks.find((check) => check.name === "tests") ??
    checks[0];
  return primary.command ?? config.testCommand ?? DEFAULT_TEST_COMMAND;
}

function normalizeCheckEntries(rawChecks) {
  if (!rawChecks) {
    return [];
  }
  if (Array.isArray(rawChecks)) {
    return rawChecks
      .map((entry, index) => typeof entry === "string"
        ? { name: index === 0 ? "tests" : `check${index + 1}`, command: entry }
        : { name: entry?.name ?? (index === 0 ? "tests" : `check${index + 1}`), ...entry })
      .filter((entry) => entry?.command);
  }
  if (typeof rawChecks === "object") {
    return Object.entries(rawChecks)
      .map(([name, definition]) => typeof definition === "string"
        ? { name, command: definition }
        : { name, ...definition })
      .filter((entry) => entry?.command);
  }
  return [];
}

function getFirstPhaseName(config) {
  if (Array.isArray(config.phases) && config.phases.length > 0) {
    return config.phases[0]?.name ?? "phase1";
  }
  return "default";
}

function parsePassingTestOutput(output, throughStage) {
  const stageNames = [...output.matchAll(/^===== (pa\d+) =====$/gm)].map((match) => match[1]);
  const allPassed = output.match(/^===== ALL TESTS PASSED SUCCESSFULLY!(?: \((\d+)\s*\/\s*(\d+)\))? =====$/m);
  if (!allPassed) {
    throw new Error("Boundary test succeeded but did not print ALL TESTS PASSED summary");
  }
  const testsPassed = parseOptionalInt(allPassed[1]);
  const testsTotal = parseOptionalInt(allPassed[2]);
  return {
    stageNames: stageNames.length ? stageNames : buildStageNames(stageNumber(throughStage)),
    testsPassed: testsPassed ?? testsTotal ?? 0,
    testsTotal: testsTotal ?? testsPassed ?? 0,
  };
}

function renderTestCommand(command, stageName) {
  const stageNumberText = String(stageName).replace(/^pa/i, "");
  return command
    .replace(/\bpaX\b/g, stageName)
    .replace(/\{\{\s*(?:stage|pa|paStage|testStage|failingStage)\s*\}\}/g, stageName)
    .replace(/\{\{\s*stageNumber\s*\}\}/g, stageNumberText)
    .replace(/\{(?:stage|pa|paStage|testStage|failingStage)\}/g, stageName);
}

function hasStagePlaceholder(command) {
  return /\bpaX\b/.test(command) ||
    /\{\{\s*(?:stage|pa|paStage|testStage|failingStage)\s*\}\}/.test(command) ||
    /\{\{\s*stageNumber\s*\}\}/.test(command) ||
    /\{(?:stage|pa|paStage|testStage|failingStage)\}/.test(command);
}

function buildRunName({ name, model, reasoningEffort }) {
  return [name, model, reasoningEffort].map((part) => sanitizeRunNamePart(part)).join("-");
}

function sanitizeRunNamePart(value) {
  const sanitized = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error("Run name parts must not be empty");
  }
  return sanitized;
}

function normalizeStage(value) {
  const match = String(value ?? "").trim().match(/^(?:pa)?(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid PA stage: ${value}`);
  }
  return `pa${Number.parseInt(match[1], 10)}`;
}

function stageNumber(stageName) {
  const match = stageName.match(/^pa(\d+)$/);
  if (!match) {
    throw new Error(`Invalid PA stage: ${stageName}`);
  }
  return Number.parseInt(match[1], 10);
}

function nextStage(stageName) {
  return `pa${stageNumber(stageName) + 1}`;
}

function buildStageNames(count) {
  return Array.from({ length: count }, (_value, index) => `pa${index + 1}`);
}

function parseOptionalInt(value) {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function gitOutput(args, cwd) {
  const result = await run(["git", ...args], { cwd, label: `git ${args.join(" ")}`, capture: true });
  return result.output.trim();
}

async function assertDirectory(filePath, label) {
  const stat = await fs.stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
    throw error;
  });
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${filePath}`);
  }
}

async function assertMissing(filePath, label) {
  if (await pathExists(filePath)) {
    throw new Error(`${label} already exists: ${filePath}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runShell(command, options = {}) {
  return run(["bash", "-lc", command], options);
}

async function run(command, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  log(`${options.label ?? command.join(" ")}${cwd ? ` (${cwd})` : ""}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (!options.capture) {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (!options.capture) {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const result = { exitCode, output };
      if (exitCode === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`${options.label ?? command.join(" ")} failed with exit code ${exitCode}`));
      }
    });
  });
}

function log(message) {
  process.stdout.write(`[fork-run] ${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`[fork-run] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
