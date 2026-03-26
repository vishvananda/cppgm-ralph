#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Codex } from "@openai/codex-sdk";

const DEFAULT_PROMPT = `Read AGENTS.md and follow it exactly. Starting from the current repository
state which has stubs of the desired compiler implementation. 
Follow the checked-in tests and assignment instructions, even when they differ from newer-standard behavior.
Work on assignment pa1, when completed, update pa1/RETRO.md, commit your changes.`

const DEFAULT_CONFIG = {
  baseDir: "/work",
  name: "cppgm",
  testCommand: "make test",
  maxTurns: 1000,
  stateBaseDir: ".ralph",
  model: "gpt-5.3-codex",
  reasoningEffort: "high",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
  webSearchEnabled: false,
  additionalDirectories: [],
  outputTailChars: 20000,
};
const DEFAULT_REPO_URL = "git@github.com:anotherjesse/cppgm.git";
const DEFAULT_BASE_BRANCH = "main";

const CONFIG_PATH = path.resolve(process.cwd(), process.env.RALPH_CONFIG ?? "ralph.config.json");

let CONFIG = null;
let STATE_PATH = null;
let TEST_LOG_PATH = null;
let EVENTS_DIR_PATH = null;

async function main() {
  CONFIG = await loadConfig();
  STATE_PATH = path.join(CONFIG.stateDir, "state.json");
  TEST_LOG_PATH = path.join(CONFIG.stateDir, "last-test.log");
  EVENTS_DIR_PATH = path.join(CONFIG.stateDir, "events");

  await fs.mkdir(CONFIG.stateDir, { recursive: true });
  await fs.mkdir(EVENTS_DIR_PATH, { recursive: true });
  const state = await loadState();
  const startingFreshRun =
    !state.threadId &&
    state.turnsCompleted === 0 &&
    state.lastExitCode == null &&
    state.lastTestStatus == null;

  if (startingFreshRun) {
    await initializeRunRepository({
      workdir: CONFIG.workdir,
      branchName: CONFIG.runName,
    });
  } else {
    await assertDirectoryExists(CONFIG.workdir);
  }

  log(
    `Config: model=${CONFIG.model} reasoning=${CONFIG.reasoningEffort} ` +
      `workdir=${CONFIG.workdir} branch=${CONFIG.runName}`,
  );
  const threadOptions = {
    workingDirectory: CONFIG.workdir,
    sandboxMode: CONFIG.sandboxMode,
    approvalPolicy: CONFIG.approvalPolicy,
    networkAccessEnabled: CONFIG.networkAccessEnabled,
    webSearchEnabled: CONFIG.webSearchEnabled,
    ...(CONFIG.model ? { model: CONFIG.model } : {}),
    ...(CONFIG.reasoningEffort
      ? { modelReasoningEffort: CONFIG.reasoningEffort }
      : {}),
    ...(CONFIG.additionalDirectories.length > 0
      ? { additionalDirectories: CONFIG.additionalDirectories }
      : {}),
  };

  let activeThreadId = process.env.RALPH_THREAD_ID ?? state.threadId ?? null;
  let codex = null;
  let thread = null;

  for (let turnNumber = state.turnsCompleted; turnNumber < CONFIG.maxTurns; turnNumber += 1) {
    const testRun = await runCommand(CONFIG.testCommand, CONFIG.workdir);
    await fs.writeFile(TEST_LOG_PATH, testRun.output, "utf8");
    const gitStatus = await getGitStatus(CONFIG.workdir);
    const testStatus = analyzeTestProgress(testRun.output, state.lastTestStatus, {
      exitCode: testRun.exitCode,
    });
    log(`Latest test output: ${previewText(testRun.output)}`);
    log(`Test status: ${formatTestStatusSummary(testStatus)}`);
    if (testStatus.stages.length > 0) {
      log(`Stage breakdown: ${formatStageBreakdown(testStatus)}`);
    }
    if (!gitStatus.clean) {
      log(`Git status: ${previewText(gitStatus.output)}`);
    }

    if (testRun.exitCode === 0 && gitStatus.clean) {
      const finalThreadId = activeThreadId ?? state.threadId ?? null;
      await appendRalphEventRecord(
        buildRalphTestStatusEventRecord({
          testStatus,
          threadId: finalThreadId,
          turnNumber,
        }),
      );
      if (activeThreadId || state.threadId || state.turnsCompleted > 0) {
        await saveState({
          threadId: finalThreadId,
          eventLogPath: buildEventLogPath(finalThreadId),
          turnsCompleted: turnNumber,
          lastExitCode: 0,
          lastTestStatus: testStatus,
          updatedAt: new Date().toISOString(),
        });
      }
      state.threadId = finalThreadId;
      state.lastExitCode = 0;
      state.lastTestStatus = testStatus;
      state.turnsCompleted = turnNumber;
      log("`make test` passed. Exiting.");
      return;
    }

    if (!thread) {
      codex = new Codex();
      thread = activeThreadId
        ? codex.resumeThread(activeThreadId, threadOptions)
        : codex.startThread(threadOptions);
      if (activeThreadId) {
        log(`Resuming Codex thread ${activeThreadId}`);
      } else {
        log("Starting a new Codex thread");
      }
    }

    log(
      `Test run failed with exit code ${testRun.exitCode}. Handing control back to Codex ` +
        `(turn ${turnNumber + 1}/${CONFIG.maxTurns}).`,
    );

    const prompt =
      testRun.exitCode === 0 && !gitStatus.clean
        ? buildCleanWorktreePrompt(gitStatus, testStatus)
        : turnNumber === 0 && !activeThreadId
          ? buildInitialPrompt(testStatus, gitStatus)
          : buildContinuePrompt(testStatus, gitStatus);

    log(`Ralph prompt: ${previewText(prompt)}`);
    const { events } = await thread.runStreamed(prompt);
    const turn = await collectStreamedTurn(events, {
      prompt,
      preTurnEventRecords: [
        buildRalphTestStatusEventRecord({
          testStatus,
          threadId: thread.id ?? activeThreadId,
          turnNumber,
        }),
      ],
      threadId: thread.id ?? activeThreadId,
      turnNumber: turnNumber + 1,
    });
    activeThreadId = thread.id ?? turn.threadId ?? activeThreadId;

    await saveState({
      threadId: activeThreadId,
      eventLogPath: buildEventLogPath(activeThreadId),
      turnsCompleted: turnNumber + 1,
      lastExitCode: testRun.exitCode,
      lastTestStatus: testStatus,
      updatedAt: new Date().toISOString(),
    });
    state.threadId = activeThreadId;
    state.lastExitCode = testRun.exitCode;
    state.lastTestStatus = testStatus;
    state.turnsCompleted = turnNumber + 1;
    await pushCurrentBranch(CONFIG.workdir);

    if (activeThreadId) {
      log(`Active thread id: ${activeThreadId}`);
    }
    if (turn.usage) {
      log(`Token usage: ${formatUsage(turn.usage)}`);
    }
    if (turn.finalResponse.trim()) {
      log(`Codex response: ${previewText(turn.finalResponse)}`);
    }
  }

  throw new Error(
    `Hit the max turn limit (${CONFIG.maxTurns}) and \`${CONFIG.testCommand}\` still fails.`,
  );
}

function buildInitialPrompt(testStatus, gitStatus) {
  return [
    DEFAULT_PROMPT,
    "",
    ...buildFailureSummaryLines(testStatus),
    "",
    ...buildGitStatusLines(gitStatus),
  ].join("\n");
}

function buildContinuePrompt(testStatus, gitStatus) {
  const objectiveLines = buildContinueObjectiveLines(testStatus);
  const failureSummaryLines = buildFailureSummaryLines(testStatus);

  return [
    ...objectiveLines,
    gitStatus.clean
      ? "The worktree is currently clean."
      : "Your previous turn left a dirty worktree. Commit intended changes before returning control.",
    "",
    ...buildGitStatusLines(gitStatus),
    "",
    ...failureSummaryLines,
  ].join("\n");
}

function buildCleanWorktreePrompt(gitStatus, testStatus) {
  return [
    "The tests now pass, but the worktree is not clean yet.",
    "Commit the intended changes now so `git status --short` is empty before handing control back.",
    "Do not discard intended work. Create the appropriate commit(s) and leave the repository clean.",
    "",
    ...buildTestStatusLines(testStatus),
    "",
    ...buildGitStatusLines(gitStatus),
  ].join("\n");
}

function buildGitStatusLines(gitStatus) {
  return gitStatus.clean
    ? ["Current `git status --short`: empty"]
    : ["Current `git status --short`:", trimmedOutput(gitStatus.output)];
}

function buildContinueObjectiveLines(testStatus) {
  const lines = [];

  if (testStatus.regressions.length > 0) {
    lines.push(
      `Latest commit(s) caused regressions in ${formatStageList(testStatus.regressions)}. ` +
        "Address those regressions before moving forward.",
    );
  }

  if (testStatus?.passingThrough && testStatus?.failingStage) {
    lines.push(
      `Assignments through \`${testStatus.passingThrough}\` already pass.`,
      `Your task for this turn is to implement the code required to make ` +
        `\`make ${testStatus.failingStage}\` pass without causing regressions for previous ` +
        `assignments: \`make test-through-${testStatus.passingThrough}\``,
    );
    return lines;
  }

  if (testStatus?.failingStage) {
    lines.push(
      `\`make ${testStatus.failingStage}\` is still failing, continue work on stage until it passes.`,
    );
    return lines;
  }

  lines.push(
    `I reran \`${CONFIG.testCommand}\` from the repository root and it still fails.`,
    `Latest exit code: ${testStatus.exitCode}`,
  );
  return lines;
}

function buildFailureSummaryLines(testStatus) {
  const lines = [`Latest exit code: ${testStatus.exitCode}`];

  lines.push(...buildTestStatusLines(testStatus));

  if (testStatus.regressions.length > 0) {
    lines.push(`Regression summary: ${formatStageList(testStatus.regressions)} regressed.`);
  }

  if (testStatus?.firstFailureLine) {
    lines.push(`First reported blocker: ${testStatus.firstFailureLine}`);
  }

  lines.push(
    `Full test output is in \`${path.join(CONFIG.stateDir, "last-test.log")}\` if you need more detail.`,
    "After `make` passes for the current blocking assignment, keep going until the full suite passes.",
  );

  return lines;
}

function analyzeTestProgress(output, previousStatus = null, options = {}) {
  const normalizedOutput = typeof output === "string" ? output : "";
  const stagePattern = /^===== (pa\d+) =====$/gm;
  const stageHeaders = [...normalizedOutput.matchAll(stagePattern)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  const firstFailureLine = normalizedOutput
    .split(/\r?\n/)
    .find((line) => /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match/.test(line));

  const stages = stageHeaders.map((stage, index) => {
    const start = stage.index;
    const end = index + 1 < stageHeaders.length ? stageHeaders[index + 1].index : normalizedOutput.length;
    return parseStageStatus(stage.name, normalizedOutput.slice(start, end));
  });

  const failingIndex = stages.findIndex((stage) => stage.status === "fail");
  const failingStage = failingIndex >= 0 ? stages[failingIndex].name : null;
  const passingThrough =
    failingIndex > 0
      ? stages[failingIndex - 1].name
      : failingIndex < 0 && stages.length > 0 && stages.every((stage) => stage.status === "pass")
        ? stages[stages.length - 1].name
        : null;

  const previousPassingStages = new Set(
    (previousStatus?.stages ?? [])
      .filter((stage) => stage?.status === "pass" && typeof stage.name === "string")
      .map((stage) => stage.name),
  );
  const regressions = stages
    .filter((stage) => previousPassingStages.has(stage.name) && stage.status !== "pass")
    .map((stage) => stage.name);

  const testsPassed = stages.reduce((sum, stage) => sum + stage.passed, 0);
  const testsTotal = stages.reduce((sum, stage) => sum + stage.total, 0);
  const stagesPassed = stages.filter((stage) => stage.status === "pass").length;

  return {
    recordedAt: new Date().toISOString(),
    command: CONFIG.testCommand,
    exitCode: options.exitCode ?? null,
    allTestsPassed:
      /===== ALL TESTS PASSED SUCCESSFULLY! =====/.test(normalizedOutput) ||
      (stages.length > 0 &&
        stagesPassed === stages.length &&
        stages.every((stage) => stage.status === "pass") &&
        (options.exitCode ?? 1) === 0),
    stageCount: stages.length,
    stagesPassed,
    testsPassed,
    testsTotal,
    failingStage,
    passingThrough,
    firstFailureLine: firstFailureLine ?? null,
    regressions,
    stages,
  };
}

function parseStageStatus(stageName, body) {
  const targets = new Map();

  for (const line of body.split(/\r?\n/)) {
    let match = line.match(/^(.+?): running (\d+) tests$/);
    if (match) {
      const target = ensureStageTarget(targets, match[1]);
      target.total = Number.parseInt(match[2], 10);
      continue;
    }

    match = line.match(/^(.+?): PASS \((\d+)\/(\d+)\)$/);
    if (match) {
      const target = ensureStageTarget(targets, match[1]);
      target.status = "pass";
      target.passed = Number.parseInt(match[2], 10);
      target.total = Number.parseInt(match[3], 10);
      continue;
    }

    match = line.match(/^(.+?): FAIL \((\d+)\/(\d+)\)$/);
    if (match) {
      const target = ensureStageTarget(targets, match[1]);
      target.status = "fail";
      target.passed = Number.parseInt(match[2], 10);
      target.total = Number.parseInt(match[3], 10);
      continue;
    }

    match = line.match(/^(.+?): FAIL after (\d+)\/(\d+) passed$/);
    if (match) {
      const target = ensureStageTarget(targets, match[1]);
      target.status = "fail";
      target.passed = Number.parseInt(match[2], 10);
      target.total = Number.parseInt(match[3], 10);
    }
  }

  const stageTargets = Array.from(targets.values());
  const hasFailureMarker = /\bFAIL\b|ERROR:/.test(body);
  const status = stageTargets.some((target) => target.status === "fail") || hasFailureMarker
    ? "fail"
    : stageTargets.length > 0 && stageTargets.every((target) => target.status === "pass")
      ? "pass"
      : "unknown";
  const passed = stageTargets.reduce((sum, target) => sum + (target.passed ?? 0), 0);
  const total = stageTargets.reduce((sum, target) => sum + (target.total ?? 0), 0);

  return {
    name: stageName,
    status,
    passed,
    total,
    targets: stageTargets,
  };
}

function ensureStageTarget(targets, targetName) {
  if (!targets.has(targetName)) {
    targets.set(targetName, {
      name: targetName,
      status: "unknown",
      passed: null,
      total: null,
    });
  }
  return targets.get(targetName);
}

function buildTestStatusLines(testStatus) {
  if (!testStatus || testStatus.stages.length === 0) {
    return [];
  }

  return [
    `Test status: ${formatTestStatusSummary(testStatus)}`,
    `Stage breakdown: ${formatStageBreakdown(testStatus)}`,
  ];
}

function formatTestStatusSummary(testStatus) {
  if (!testStatus || testStatus.stages.length === 0) {
    return `exit ${testStatus?.exitCode ?? "unknown"}`;
  }

  const parts = [
    `${testStatus.testsPassed}/${testStatus.testsTotal} tests passing`,
    `${testStatus.stagesPassed}/${testStatus.stageCount} stages passing`,
  ];

  if (testStatus.failingStage) {
    parts.push(`first failing stage: ${testStatus.failingStage}`);
  } else if (testStatus.allTestsPassed) {
    parts.push("all tracked stages passing");
  }

  if (testStatus.regressions.length > 0) {
    parts.push(`regressions: ${formatStageList(testStatus.regressions)}`);
  }

  return parts.join("; ");
}

function formatStageBreakdown(testStatus) {
  return testStatus.stages.map((stage) => formatSingleStageBreakdown(stage)).join("; ");
}

function formatSingleStageBreakdown(stage) {
  const targetSummary = stage.targets
    .map((target) => {
      if (target.total == null) {
        return `${target.name} ${target.status}`;
      }
      return `${target.name} ${target.passed ?? 0}/${target.total}`;
    })
    .join(", ");
  const stageSummary = `${stage.name} ${stage.passed}/${stage.total} ${stage.status}`;
  return targetSummary ? `${stageSummary} (${targetSummary})` : stageSummary;
}

function formatStageList(stageNames) {
  return stageNames.map((stage) => `\`${stage}\``).join(", ");
}

function trimmedOutput(output) {
  if (output.length <= CONFIG.outputTailChars) {
    return output;
  }

  return [
    `[output truncated to last ${CONFIG.outputTailChars} characters]`,
    output.slice(-CONFIG.outputTailChars),
  ].join("\n");
}

async function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: combineOutput(stdout, stderr),
      });
    });
  });
}

async function initializeRunRepository({ workdir, branchName }) {
  await assertPathDoesNotExist(workdir);
  await assertRemoteBranchDoesNotExist(branchName);
  await cloneRunRepository(workdir);
  await runGitCommand(["checkout", DEFAULT_BASE_BRANCH], workdir);
  await runGitCommand(["pull", "--ff-only", "origin", DEFAULT_BASE_BRANCH], workdir);
  await runGitCommand(["branch", branchName, `origin/${DEFAULT_BASE_BRANCH}`], workdir);
  await runGitCommand(["checkout", branchName], workdir);
  await runGitCommand(["push", "--set-upstream", "origin", branchName], workdir);
  log(`Initialized ${workdir} on branch ${branchName} from origin/${DEFAULT_BASE_BRANCH}`);
}

async function assertPathDoesNotExist(targetPath) {
  if (await pathExists(targetPath)) {
    throw new Error(`${targetPath} already exists`);
  }
}

async function cloneRunRepository(workdir) {
  if (await pathExists(workdir)) {
    const stat = await fs.stat(workdir);
    if (!stat.isDirectory()) {
      throw new Error(`${workdir} already exists`);
    }
  } else {
    await fs.mkdir(path.dirname(workdir), { recursive: true });
  }

  const cloneResult = await runCommand(
    `git clone --single-branch --branch ${shellEscape(DEFAULT_BASE_BRANCH)} ` +
      `${shellEscape(DEFAULT_REPO_URL)} ${shellEscape(workdir)}`,
    process.cwd(),
  );
  if (cloneResult.exitCode !== 0) {
    throw new Error(`Failed to clone ${DEFAULT_REPO_URL} into ${workdir}:\n${cloneResult.output}`);
  }
  log(`Cloned ${DEFAULT_REPO_URL} (${DEFAULT_BASE_BRANCH} only) into ${workdir}`);
}

async function assertRemoteBranchDoesNotExist(branchName) {
  const remoteResult = await runCommand(
    `git ls-remote --exit-code --heads ${shellEscape(DEFAULT_REPO_URL)} ${shellEscape(branchName)}`,
    process.cwd(),
  );
  if (remoteResult.exitCode === 0) {
    throw new Error(`Remote branch origin/${branchName} already exists`);
  }
  if (remoteResult.exitCode !== 2) {
    throw new Error(`Failed to inspect remote branch origin/${branchName}`);
  }
}

async function pushCurrentBranch(workdir) {
  const branchNameResult = await runGitCommand(["branch", "--show-current"], workdir);
  const branchName = branchNameResult.output.trim();
  if (!branchName) {
    throw new Error(`No current git branch is checked out in ${workdir}`);
  }
  await runGitCommand(["push", "origin", branchName], workdir);
  log(`Pushed branch ${branchName} to origin`);
}

async function runGitCommand(args, cwd) {
  const result = await runCommand(
    `git ${args.map((arg) => shellEscape(arg)).join(" ")}`,
    cwd,
  );
  if (result.exitCode !== 0) {
    const description = args.join(" ");
    throw new Error(`Git command failed in ${cwd}: git ${description}\n${result.output}`);
  }
  return result;
}

async function getGitStatus(cwd) {
  const result = await runCommand("git status --short", cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to run git status in ${cwd}`);
  }
  return {
    clean: result.output.trim() === "",
    output: result.output,
  };
}

async function collectStreamedTurn(events, options = {}) {
  const items = [];
  let finalResponse = "";
  let usage = null;
  let turnFailure = null;
  let streamError = null;
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  let threadId = options.threadId ?? null;
  const turnNumber = options.turnNumber ?? null;
  let eventLogPath = buildEventLogPath(threadId);
  const pendingEventRecords = Array.isArray(options.preTurnEventRecords)
    ? options.preTurnEventRecords.filter(Boolean)
    : [];

  const promptEventRecord = buildRalphPromptEventRecord({
    prompt,
    threadId,
    turnNumber,
  });
  if (promptEventRecord) {
    pendingEventRecords.push(promptEventRecord);
  }

  for await (const event of events) {
    threadId = threadId ?? getEventThreadId(event);
    eventLogPath = eventLogPath ?? buildEventLogPath(threadId);
    applyThreadIdToPendingRecords(pendingEventRecords, threadId);
    const eventRecord = {
      recordedAt: new Date().toISOString(),
      threadId,
      turnNumber,
      eventType: event.type,
      event,
    };
    if (eventLogPath) {
      await flushEventLogBuffer(eventLogPath, pendingEventRecords);
      await appendJsonLine(eventLogPath, eventRecord);
    } else {
      pendingEventRecords.push(eventRecord);
    }

    log(`Codex event: ${summarizeEvent(event)}`);
    if (event.type === "item.completed") {
      items.push(event.item);
      if (event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
    } else if (event.type === "turn.completed") {
      usage = event.usage;
    } else if (event.type === "turn.failed") {
      turnFailure = event.error;
      break;
    } else if (event.type === "error") {
      streamError = event.message;
      break;
    }
  }

  if (turnFailure) {
    throw new Error(turnFailure.message);
  }
  if (streamError) {
    throw new Error(streamError);
  }

  await flushEventLogBuffer(eventLogPath, pendingEventRecords);

  return { items, finalResponse, usage, threadId };
}

function combineOutput(stdout, stderr) {
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`.trim();
  }
  return (stdout || stderr).trim();
}

async function loadConfig() {
  const fileConfig = await loadConfigFile();
  const model = process.env.RALPH_MODEL ?? fileConfig.model ?? DEFAULT_CONFIG.model;
  const reasoningEffort =
    process.env.RALPH_REASONING_EFFORT ??
    fileConfig.reasoningEffort ??
    DEFAULT_CONFIG.reasoningEffort;
  const name =
    process.env.RALPH_NAME ??
    fileConfig.name ??
    deriveLegacyName(fileConfig.workdir) ??
    DEFAULT_CONFIG.name;
  const runName = buildRunName({ name, model, reasoningEffort });
  const explicitWorkdir = process.env.RALPH_WORKDIR;
  const explicitStateDir = process.env.RALPH_STATE_DIR;
  const baseDir = path.resolve(
    process.cwd(),
    process.env.RALPH_BASE_DIR ??
      fileConfig.baseDir ??
      deriveLegacyBaseDir(fileConfig.workdir) ??
      DEFAULT_CONFIG.baseDir,
  );
  const stateBaseDir = path.resolve(
    process.cwd(),
    process.env.RALPH_STATE_BASE_DIR ??
      fileConfig.stateBaseDir ??
      deriveLegacyStateBaseDir(fileConfig.stateDir) ??
      DEFAULT_CONFIG.stateBaseDir,
  );

  return {
    baseDir,
    name,
    runName,
    workdir: explicitWorkdir
      ? path.resolve(process.cwd(), explicitWorkdir)
      : path.join(baseDir, runName),
    testCommand:
      process.env.RALPH_TEST_COMMAND ?? fileConfig.testCommand ?? DEFAULT_CONFIG.testCommand,
    maxTurns: parsePositiveInt(
      process.env.RALPH_MAX_TURNS ?? fileConfig.maxTurns,
      DEFAULT_CONFIG.maxTurns,
    ),
    stateBaseDir,
    stateDir: explicitStateDir
      ? path.resolve(process.cwd(), explicitStateDir)
      : path.join(stateBaseDir, runName),
    model,
    reasoningEffort,
    sandboxMode:
      process.env.RALPH_SANDBOX_MODE ??
      fileConfig.sandboxMode ??
      DEFAULT_CONFIG.sandboxMode,
    approvalPolicy:
      process.env.RALPH_APPROVAL_POLICY ??
      fileConfig.approvalPolicy ??
      DEFAULT_CONFIG.approvalPolicy,
    networkAccessEnabled: parseBoolean(
      process.env.RALPH_NETWORK_ACCESS ?? fileConfig.networkAccessEnabled,
      DEFAULT_CONFIG.networkAccessEnabled,
    ),
    webSearchEnabled: parseBoolean(
      process.env.RALPH_WEB_SEARCH_ENABLED ?? fileConfig.webSearchEnabled,
      DEFAULT_CONFIG.webSearchEnabled,
    ),
    additionalDirectories: parseAdditionalDirectories(
      process.env.RALPH_ADDITIONAL_DIRECTORIES ?? fileConfig.additionalDirectories,
    ),
    outputTailChars: parsePositiveInt(
      process.env.RALPH_OUTPUT_TAIL_CHARS ?? fileConfig.outputTailChars,
      DEFAULT_CONFIG.outputTailChars,
    ),
  };
}

async function loadConfigFile() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function summarizeEvent(event) {
  if (event.type === "thread.started") {
    return `thread.started ${event.thread_id}`;
  }
  if (event.type === "turn.started") {
    return "turn.started";
  }
  if (event.type === "turn.completed") {
    return `turn.completed in=${event.usage.input_tokens} out=${event.usage.output_tokens}`;
  }
  if (event.type === "turn.failed") {
    return `turn.failed ${previewText(event.error.message)}`;
  }
  if (event.type === "error") {
    return `error ${previewText(event.message)}`;
  }
  return `${event.type} ${summarizeItem(event.item)}`;
}

function buildRalphPromptEventRecord({ prompt, threadId, turnNumber }) {
  if (!prompt) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId,
    turnNumber,
    eventType: "ralph.prompt",
    event: {
      type: "ralph.prompt",
      sender: "ralph",
      prompt,
    },
  };
}

function buildRalphTestStatusEventRecord({ testStatus, threadId, turnNumber }) {
  if (!testStatus) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId,
    turnNumber,
    eventType: "ralph.test-status",
    event: {
      type: "ralph.test-status",
      sender: "ralph",
      testStatus,
    },
  };
}

function applyThreadIdToPendingRecords(eventRecords, threadId) {
  if (!threadId) {
    return;
  }

  for (const record of eventRecords) {
    if (!record.threadId) {
      record.threadId = threadId;
    }
  }
}

function summarizeItem(item) {
  if (item.type === "agent_message") {
    return `agent_message ${previewText(item.text)}`;
  }
  if (item.type === "reasoning") {
    return `reasoning ${previewText(item.text)}`;
  }
  if (item.type === "command_execution") {
    const status = item.exit_code == null ? item.status : `${item.status} exit=${item.exit_code}`;
    const detail = item.aggregated_output ? previewText(item.aggregated_output) : item.command;
    return `command_execution ${status} ${previewText(detail)}`;
  }
  if (item.type === "file_change") {
    const changes = item.changes.map((change) => `${change.kind}:${change.path}`).join(", ");
    return `file_change ${item.status} ${previewText(changes)}`;
  }
  if (item.type === "mcp_tool_call") {
    const detail = item.error?.message ?? `${item.server}/${item.tool}`;
    return `mcp_tool_call ${item.status} ${previewText(detail)}`;
  }
  if (item.type === "web_search") {
    return `web_search ${previewText(item.query)}`;
  }
  if (item.type === "todo_list") {
    const todos = item.items
      .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
      .join("; ");
    return `todo_list ${previewText(todos)}`;
  }
  if (item.type === "error") {
    return `error ${previewText(item.message)}`;
  }
  return previewText(JSON.stringify(item));
}

function formatUsage(usage) {
  return [
    `total=${usage.input_tokens + usage.output_tokens}`,
    `input=${usage.input_tokens}`,
    `output=${usage.output_tokens}`,
    `cached=${usage.cached_input_tokens}`,
  ].join(" ");
}

function previewText(text) {
  const firstLine = text
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (!firstLine) {
    return "[no output]";
  }
  if (firstLine.length <= 80) {
    return firstLine;
  }
  return `${firstLine.slice(0, 80)}...`;
}

function getEventThreadId(event) {
  return typeof event.thread_id === "string" ? event.thread_id : null;
}

function buildEventLogPath(threadId) {
  if (!threadId) {
    return null;
  }
  const safeThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(EVENTS_DIR_PATH, `${safeThreadId}.jsonl`);
}

async function flushEventLogBuffer(eventLogPath, eventRecords) {
  if (!eventLogPath || eventRecords.length === 0) {
    return;
  }
  const payload = eventRecords.map((record) => JSON.stringify(record)).join("\n");
  eventRecords.length = 0;
  await fs.appendFile(eventLogPath, `${payload}\n`, "utf8");
}

async function appendJsonLine(filePath, record) {
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function appendRalphEventRecord(record) {
  if (!record?.threadId) {
    return;
  }

  await appendJsonLine(buildEventLogPath(record.threadId), record);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      eventLogPath: typeof parsed.eventLogPath === "string" ? parsed.eventLogPath : null,
      turnsCompleted: Number.isInteger(parsed.turnsCompleted)
        ? parsed.turnsCompleted
        : 0,
      lastExitCode: Number.isInteger(parsed.lastExitCode) ? parsed.lastExitCode : null,
      lastTestStatus:
        parsed.lastTestStatus && typeof parsed.lastTestStatus === "object"
          ? parsed.lastTestStatus
          : null,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        threadId: null,
        eventLogPath: null,
        turnsCompleted: 0,
        lastExitCode: null,
        lastTestStatus: null,
      };
    }
    throw error;
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function assertDirectoryExists(directoryPath) {
  const stat = await fs.stat(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`${directoryPath} is not a directory`);
  }
}

function buildRunName({ name, model, reasoningEffort }) {
  const parts = [
    sanitizeRunNamePart(name, "name"),
    sanitizeRunNamePart(model, "model"),
    sanitizeRunNamePart(reasoningEffort, "reasoningEffort"),
  ];
  return parts.join("-");
}

function sanitizeRunNamePart(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error(`Config ${label} must be set`);
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(`Config ${label} must contain at least one valid branch/directory character`);
  }
  return sanitized;
}

function deriveLegacyName(workdir) {
  if (!workdir) {
    return null;
  }
  return path.basename(path.resolve(process.cwd(), String(workdir)));
}

function deriveLegacyBaseDir(workdir) {
  if (!workdir) {
    return null;
  }
  return path.dirname(path.resolve(process.cwd(), String(workdir)));
}

function deriveLegacyStateBaseDir(stateDir) {
  if (!stateDir) {
    return null;
  }
  const resolved = path.resolve(process.cwd(), String(stateDir));
  const leaf = path.basename(resolved);
  return leaf.startsWith(".") ? resolved : path.dirname(resolved);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseAdditionalDirectories(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function log(message) {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
