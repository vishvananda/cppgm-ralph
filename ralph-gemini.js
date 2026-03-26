#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_PROMPT = `Read AGENTS.md and follow it exactly. Starting from the current repository
state which has stubs of the desired compiler implementation. 
Follow the checked-in tests and assignment instructions, even when they differ from newer-standard behavior.
Work on assignment pa1, when completed, update pa1/RETRO.md, commit your changes.`;

const DEFAULT_INSTRUCTIONS = [
  "You are Ralph's Gemini backend operating inside the current repository checkout.",
  "Follow the user's prompt exactly.",
  "Before handing control back, commit intended changes and leave the worktree clean.",
].join("\n");

const DEFAULT_CONFIG = {
  baseDir: "/work",
  name: "cppgm",
  testCommand: "make test",
  maxTurns: 1000,
  stateBaseDir: ".ralph",
  model: null,
  debug: false,
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
  const GeminiCliAgent = await loadGeminiAgentClass();

  CONFIG = await loadConfig();
  STATE_PATH = path.join(CONFIG.stateDir, "state.json");
  TEST_LOG_PATH = path.join(CONFIG.stateDir, "last-test.log");
  EVENTS_DIR_PATH = path.join(CONFIG.stateDir, "events");

  await fs.mkdir(CONFIG.stateDir, { recursive: true });
  await fs.mkdir(EVENTS_DIR_PATH, { recursive: true });
  const state = await loadState();
  const startingFreshRun =
    !state.sessionId &&
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
    `Config: provider=gemini model=${CONFIG.modelLabel} ` +
      `workdir=${CONFIG.workdir} branch=${CONFIG.runName}`,
  );
  if (CONFIG.ignoredLegacyModel) {
    log(
      `Ignoring non-Gemini model from config (${CONFIG.ignoredLegacyModel}); using Gemini default routing.`,
    );
  }

  const agentOptions = {
    cwd: CONFIG.workdir,
    instructions: DEFAULT_INSTRUCTIONS,
    ...(CONFIG.model ? { model: CONFIG.model } : {}),
    ...(CONFIG.debug ? { debug: true } : {}),
  };

  let activeSessionId =
    process.env.RALPH_SESSION_ID ??
    process.env.RALPH_THREAD_ID ??
    state.sessionId ??
    null;
  let agent = null;
  let session = null;

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
      const finalSessionId = activeSessionId ?? state.sessionId ?? null;
      await appendRalphEventRecord(
        buildRalphTestStatusEventRecord({
          testStatus,
          sessionId: finalSessionId,
          turnNumber,
        }),
      );
      if (finalSessionId || state.turnsCompleted > 0) {
        await saveState({
          sessionId: finalSessionId,
          threadId: finalSessionId,
          eventLogPath: buildEventLogPath(finalSessionId),
          turnsCompleted: turnNumber,
          lastExitCode: 0,
          lastTestStatus: testStatus,
          updatedAt: new Date().toISOString(),
        });
      }
      state.sessionId = finalSessionId;
      state.threadId = finalSessionId;
      state.lastExitCode = 0;
      state.lastTestStatus = testStatus;
      state.turnsCompleted = turnNumber;
      log("`make test` passed. Exiting.");
      return;
    }

    const hadExistingSession = Boolean(activeSessionId);

    if (!session) {
      agent = new GeminiCliAgent(agentOptions);
      session = activeSessionId
        ? await agent.resumeSession(activeSessionId)
        : agent.session();
      activeSessionId = session.id ?? activeSessionId;
      if (hadExistingSession && activeSessionId) {
        log(`Using Gemini session ${activeSessionId}`);
      } else {
        log("Starting a new Gemini session");
      }
    }

    log(
      `Test run failed with exit code ${testRun.exitCode}. Handing control back to Gemini ` +
        `(turn ${turnNumber + 1}/${CONFIG.maxTurns}).`,
    );

    const prompt =
      testRun.exitCode === 0 && !gitStatus.clean
        ? buildCleanWorktreePrompt(gitStatus, testStatus)
        : turnNumber === 0 && !hadExistingSession
          ? buildInitialPrompt(testStatus, gitStatus)
          : buildContinuePrompt(testStatus, gitStatus);

    log(`Ralph prompt: ${previewText(prompt)}`);
    const turn = await collectStreamedTurn(session.sendStream(prompt), {
      prompt,
      preTurnEventRecords: [
        buildRalphTestStatusEventRecord({
          testStatus,
          sessionId: activeSessionId,
          turnNumber,
        }),
      ],
      sessionId: activeSessionId,
      turnNumber: turnNumber + 1,
    });
    activeSessionId = session.id ?? turn.sessionId ?? activeSessionId;

    await saveState({
      sessionId: activeSessionId,
      threadId: activeSessionId,
      eventLogPath: buildEventLogPath(activeSessionId),
      turnsCompleted: turnNumber + 1,
      lastExitCode: testRun.exitCode,
      lastTestStatus: testStatus,
      updatedAt: new Date().toISOString(),
    });
    state.sessionId = activeSessionId;
    state.threadId = activeSessionId;
    state.lastExitCode = testRun.exitCode;
    state.lastTestStatus = testStatus;
    state.turnsCompleted = turnNumber + 1;
    await pushCurrentBranch(CONFIG.workdir);

    if (activeSessionId) {
      log(`Active session id: ${activeSessionId}`);
    }
    if (turn.usage) {
      log(`Token usage: ${formatUsage(turn.usage)}`);
    }
    if (turn.finalResponse.trim()) {
      log(`Gemini response: ${previewText(turn.finalResponse)}`);
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
  let finalResponse = "";
  let usage = null;
  let streamError = null;
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  const sessionId = options.sessionId ?? null;
  const turnNumber = options.turnNumber ?? null;
  const eventLogPath = buildEventLogPath(sessionId);
  const pendingEventRecords = Array.isArray(options.preTurnEventRecords)
    ? options.preTurnEventRecords.filter(Boolean)
    : [];

  const promptEventRecord = buildRalphPromptEventRecord({
    prompt,
    sessionId,
    turnNumber,
  });
  if (promptEventRecord) {
    pendingEventRecords.push(promptEventRecord);
  }

  for await (const event of events) {
    const eventRecord = {
      recordedAt: new Date().toISOString(),
      threadId: sessionId,
      sessionId,
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

    log(`Gemini event: ${summarizeEvent(event)}`);
    switch (event.type) {
      case "content":
        finalResponse += event.value ?? "";
        break;
      case "finished":
        usage = event.value?.usageMetadata ?? null;
        break;
      case "error":
        streamError = extractGeminiErrorMessage(event.value?.error);
        break;
      case "agent_execution_blocked":
        streamError = event.value?.systemMessage?.trim() || event.value?.reason || "Agent execution blocked";
        break;
      case "context_window_will_overflow":
        streamError =
          `Context window will overflow (estimated=${event.value?.estimatedRequestTokenCount ?? "unknown"} ` +
          `remaining=${event.value?.remainingTokenCount ?? "unknown"})`;
        break;
      case "invalid_stream":
        streamError = "Gemini returned an invalid stream.";
        break;
      case "max_session_turns":
        streamError = "Gemini hit its internal max session turn limit.";
        break;
      case "user_cancelled":
        streamError = "Gemini session was cancelled.";
        break;
      default:
        break;
    }
    if (streamError) {
      break;
    }
  }

  await flushEventLogBuffer(eventLogPath, pendingEventRecords);

  if (streamError) {
    throw new Error(streamError);
  }

  return { finalResponse, usage, sessionId };
}

function combineOutput(stdout, stderr) {
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`.trim();
  }
  return (stdout || stderr).trim();
}

async function loadConfig() {
  const fileConfig = await loadConfigFile();
  const explicitModel = process.env.RALPH_MODEL ?? process.env.RALPH_GEMINI_MODEL ?? null;
  const fileGeminiModel =
    typeof fileConfig.geminiModel === "string" && fileConfig.geminiModel.trim()
      ? fileConfig.geminiModel.trim()
      : null;
  const legacyModel =
    typeof fileConfig.model === "string" && fileConfig.model.trim()
      ? fileConfig.model.trim()
      : null;
  const resolvedModel = explicitModel ?? fileGeminiModel ?? deriveGeminiModel(legacyModel) ?? DEFAULT_CONFIG.model;
  const modelLabel = resolvedModel ?? "auto";
  const ignoredLegacyModel =
    !explicitModel && !fileGeminiModel && legacyModel && !deriveGeminiModel(legacyModel)
      ? legacyModel
      : null;
  const name =
    process.env.RALPH_NAME ??
    fileConfig.name ??
    deriveLegacyName(fileConfig.workdir) ??
    DEFAULT_CONFIG.name;
  const runName = buildRunName({ name, provider: "gemini", model: modelLabel });
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
    model: resolvedModel,
    modelLabel,
    ignoredLegacyModel,
    debug: parseBoolean(
      process.env.RALPH_DEBUG ?? fileConfig.debug,
      DEFAULT_CONFIG.debug,
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
  switch (event.type) {
    case "model_info":
      return `model_info ${event.value}`;
    case "content":
      return `content ${previewText(event.value)}`;
    case "thought":
      return `thought ${previewText(event.value?.description ?? "")}`;
    case "tool_call_request":
      return `tool_call_request ${event.value?.name ?? "unknown"}`;
    case "tool_call_response":
      return `tool_call_response ${event.value?.toolName ?? event.value?.name ?? "unknown"}`;
    case "tool_call_confirmation":
      return `tool_call_confirmation ${event.value?.request?.name ?? "unknown"}`;
    case "finished":
      return `finished ${formatUsage(event.value?.usageMetadata ?? null)}`;
    case "error":
      return `error ${previewText(extractGeminiErrorMessage(event.value?.error))}`;
    case "agent_execution_blocked":
      return `agent_execution_blocked ${previewText(event.value?.systemMessage ?? event.value?.reason ?? "")}`;
    case "agent_execution_stopped":
      return `agent_execution_stopped ${previewText(event.value?.systemMessage ?? event.value?.reason ?? "")}`;
    case "citation":
      return `citation ${previewText(event.value)}`;
    case "context_window_will_overflow":
      return "context_window_will_overflow";
    case "invalid_stream":
    case "loop_detected":
    case "max_session_turns":
    case "retry":
    case "chat_compressed":
    case "user_cancelled":
      return event.type;
    default:
      return previewText(JSON.stringify(event));
  }
}

function buildRalphPromptEventRecord({ prompt, sessionId, turnNumber }) {
  if (!prompt) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId: sessionId,
    sessionId,
    turnNumber,
    eventType: "ralph.prompt",
    event: {
      type: "ralph.prompt",
      sender: "ralph",
      prompt,
    },
  };
}

function buildRalphTestStatusEventRecord({ testStatus, sessionId, turnNumber }) {
  if (!testStatus) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId: sessionId,
    sessionId,
    turnNumber,
    eventType: "ralph.test-status",
    event: {
      type: "ralph.test-status",
      sender: "ralph",
      testStatus,
    },
  };
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return "unknown";
  }

  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const total = usage.totalTokenCount ?? input + output;
  const parts = [
    `total=${total}`,
    `input=${input}`,
    `output=${output}`,
    `cached=${cached}`,
  ];
  if (thoughts > 0) {
    parts.push(`thoughts=${thoughts}`);
  }
  return parts.join(" ");
}

function previewText(text) {
  const normalized = String(text ?? "");
  const firstLine = normalized
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

function buildEventLogPath(sessionId) {
  if (!sessionId) {
    return null;
  }
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(EVENTS_DIR_PATH, `${safeSessionId}.jsonl`);
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
  const sessionId = record?.sessionId ?? record?.threadId ?? null;
  if (!sessionId) {
    return;
  }

  await appendJsonLine(buildEventLogPath(sessionId), record);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const sessionId =
      typeof parsed.sessionId === "string"
        ? parsed.sessionId
        : typeof parsed.threadId === "string"
          ? parsed.threadId
          : null;
    return {
      sessionId,
      threadId: sessionId,
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
        sessionId: null,
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

function buildRunName({ name, provider, model }) {
  const parts = [
    sanitizeRunNamePart(name, "name"),
    sanitizeRunNamePart(provider, "provider"),
    sanitizeRunNamePart(model, "model"),
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

function deriveGeminiModel(model) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return /gemini/i.test(trimmed) ? trimmed : null;
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
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function extractGeminiErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error ?? "Unknown Gemini error");
}

async function loadGeminiAgentClass() {
  try {
    const mod = await import("@google/gemini-cli-sdk");
    if (typeof mod.GeminiCliAgent !== "function") {
      throw new Error("`@google/gemini-cli-sdk` did not export `GeminiCliAgent`.");
    }
    return mod.GeminiCliAgent;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "Unable to load `@google/gemini-cli-sdk`. Install that package before running `ralph-gemini.js`.",
      );
    }
    throw error;
  }
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
