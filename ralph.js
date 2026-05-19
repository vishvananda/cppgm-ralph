#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const RALPH_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const CODEX_TASK_COMPLETE_SETTLE_MS = 2000;
const DEFAULT_TEMPLATE_DIR = path.join(RALPH_DIR, "templates");
const PARTIAL_TEMPLATE_KINDS = {
  defaultPrompt: {
    fileSuffix: "default",
    defaultFileName: "default.md",
  },
};

const DEFAULT_PROMPT = `Read AGENTS.md and follow it exactly. Starting from the current repository state which has stubs of the desired compiler implementation.
Follow the checked-in tests and assignment instructions, even when they differ from newer-standard behavior.

Ralph is using \`{{testCommand}}\` as the test command for this loop. The configured command template is \`{{testCommandTemplate}}\`.
For assignment-specific work, get \`{{testCommand}}\` to fully pass before returning.

## Current State

{{currentState}}

Make the implementation efficient. Minimize duplicated code. Put shared code in \`dev/src/\` and reuse it as much as practical.

Commit cohesive progress as you go rather than waiting for a single end-of-assignment commit. Before handing control back, ensure intended work is committed and \`git status --short\` is empty.`;

const DEFAULT_CONFIG = {
  baseDir: "/work",
  name: "cppgm",
  provider: "codex",
  testCommand: "make test",
  checks: null,
  phases: null,
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
  codexPath: "codex",
  antigravityPython: "python3",
  antigravityScriptPath: path.join(RALPH_DIR, "scripts", "antigravity-turn.py"),
  antigravitySdkPath: null,
  antigravityHarnessPath: null,
  antigravitySaveDir: null,
  antigravityAppDataDir: null,
  antigravitySkillsPaths: [],
  antigravityAllowAll: true,
  antigravityStructuredFinish: true,
  antigravityMockResponse: null,
  antigravityDefaultModel: "gemini-3.5-flash",
  antigravityRequestDelayMs: 0,
  loopGoalsEnabled: true,
  goalTokenBudget: null,
  useExistingWorkdir: false,
};
const DEFAULT_REPO_URL = "git@github.com:anotherjesse/cppgm.git";
const DEFAULT_BASE_BRANCH = "main";

const CONFIG_PATH = path.resolve(process.cwd(), process.env.RALPH_CONFIG ?? "ralph.config.json");

let CONFIG = null;
let STATE_PATH = null;
let TEST_LOG_PATH = null;
let CHECK_LOG_DIR_PATH = null;
let EVENTS_DIR_PATH = null;
let PROMPT_PARTIALS = {};
let TEST_STAGE_NAMES = [];
let STAGE_COUNT_HINTS = new Map();

async function main() {
  CONFIG = await loadConfig();
  PROMPT_PARTIALS = await loadPromptPartials();
  STATE_PATH = path.join(CONFIG.stateDir, "state.json");
  TEST_LOG_PATH = path.join(CONFIG.stateDir, "last-test.log");
  CHECK_LOG_DIR_PATH = path.join(CONFIG.stateDir, "checks");
  EVENTS_DIR_PATH = path.join(CONFIG.stateDir, "events");

  await fs.mkdir(CONFIG.stateDir, { recursive: true });
  await fs.mkdir(CHECK_LOG_DIR_PATH, { recursive: true });
  await fs.mkdir(EVENTS_DIR_PATH, { recursive: true });
  const state = await loadState();
  const startingFreshRun =
    !state.threadId &&
    state.turnsCompleted === 0 &&
    state.lastExitCode == null &&
    state.lastTestStatus == null;

  if (startingFreshRun) {
    if (CONFIG.useExistingWorkdir) {
      await assertDirectoryExists(CONFIG.workdir);
      log(`Using existing repository at ${CONFIG.workdir}`);
    } else {
      await initializeRunRepository({
        workdir: CONFIG.workdir,
        branchName: CONFIG.runName,
      });
    }
  } else {
    await assertDirectoryExists(CONFIG.workdir);
  }
  TEST_STAGE_NAMES = await discoverStageNames(CONFIG.workdir);
  if (TEST_STAGE_NAMES.length > 0) {
    log(`Discovered test stages: ${TEST_STAGE_NAMES.join(", ")}`);
  }
  STAGE_COUNT_HINTS = await loadStageCountHints(state);

  log(
    `Config: provider=${CONFIG.provider} model=${CONFIG.model} reasoning=${CONFIG.reasoningEffort} ` +
      `workdir=${CONFIG.workdir} branch=${CONFIG.runName} ` +
      `loopGoals=${CONFIG.loopGoalsEnabled ? "on" : "off"} ` +
      `phases=${CONFIG.phases.map((phase) => phase.name).join(",")}`,
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
  let backend = null;
  let thread = null;
  const providerLabel = formatProviderLabel(CONFIG.provider);

  let turnNumber = state.turnsCompleted;
  while (turnNumber < CONFIG.maxTurns) {
    const hadExistingThread = Boolean(activeThreadId);
    const phase = resolveActivePhase(state);
    const phaseStatus = await runPhaseChecks(state, phase);
    const testStatus = phaseStatus.testStatus;
    const gitStatus = await getGitStatus(CONFIG.workdir);
    const shouldRunRequiredPhaseTurn = shouldRunPhaseTurn({ phase, phaseStatus, gitStatus, state });
    const cleanupOnlyTurn = phaseStatus.allRequiredPassed && !gitStatus.clean;
    log(`Phase check status: ${formatPhaseCheckResults(phaseStatus)}`);
    log(`Primary test status: ${formatTestStatusSummary(testStatus)}`);
    if (testStatus.stages.length > 0) {
      log(`Stage breakdown: ${formatStageBreakdown(testStatus)}`);
    }
    if (!gitStatus.clean) {
      log(`Git status: ${previewText(gitStatus.output)}`);
    }

    if (
      phaseStatus.allRequiredPassed &&
      gitStatus.clean &&
      !shouldRunRequiredPhaseTurn
    ) {
      const threadId = activeThreadId ?? state.threadId ?? null;
      await appendRalphEventRecord(
        buildRalphPhaseStatusEventRecord({
          phaseStatus,
          threadId,
          turnNumber,
          action: "checked",
        }),
      );
      await appendRalphEventRecord(
        buildRalphTestStatusEventRecord({
          testStatus,
          threadId,
          turnNumber,
        }),
      );
      await completeLoopGoalIfPresent(threadId, testStatus, turnNumber);
      const nextPhase = getNextPhase(phase);
      if (nextPhase) {
        await saveState({
          threadId,
          eventLogPath: buildEventLogPath(threadId),
          turnsCompleted: turnNumber,
          lastExitCode: 0,
          lastTestStatus: testStatus,
          activeStage: getStateActiveStageAfterTest(testStatus),
          activePhase: nextPhase.name,
          phaseAttempted: false,
          updatedAt: new Date().toISOString(),
        });
        state.threadId = threadId;
        state.lastExitCode = 0;
        state.lastTestStatus = testStatus;
        state.activeStage = getStateActiveStageAfterTest(testStatus);
        state.activePhase = nextPhase.name;
        state.phaseAttempted = false;
        log(`Phase ${phase.name} completed. Advancing to phase ${nextPhase.name}.`);
        continue;
      }

      const nextStage = getNextStageAfterCompletedPhase(testStatus);
      if (nextStage) {
        const firstPhase = CONFIG.phases[0];
        await saveState({
          threadId,
          eventLogPath: buildEventLogPath(threadId),
          turnsCompleted: turnNumber,
          lastExitCode: 0,
          lastTestStatus: testStatus,
          activeStage: nextStage,
          activePhase: firstPhase.name,
          phaseAttempted: false,
          updatedAt: new Date().toISOString(),
        });
        state.threadId = threadId;
        state.lastExitCode = 0;
        state.lastTestStatus = testStatus;
        state.activeStage = nextStage;
        state.activePhase = firstPhase.name;
        state.phaseAttempted = false;
        log(`Phase ${phase.name} completed for ${testStatus.targetStage}. Advancing to ${nextStage}.`);
        continue;
      }

      await saveState({
        threadId,
        eventLogPath: buildEventLogPath(threadId),
        turnsCompleted: turnNumber,
        lastExitCode: 0,
        lastTestStatus: testStatus,
        activeStage: null,
        activePhase: null,
        phaseAttempted: false,
        updatedAt: new Date().toISOString(),
      });
      state.threadId = threadId;
      state.lastExitCode = 0;
      state.lastTestStatus = testStatus;
      state.activeStage = null;
      state.activePhase = null;
      state.phaseAttempted = false;
      state.turnsCompleted = turnNumber;
      log(`All required checks passed for final phase ${phase.name}. Exiting.`);
      return;
    }

    if (shouldRunRequiredPhaseTurn) {
      log(
        `Required checks pass; handing control to ${providerLabel} for phase ${phase.name} ` +
          `(turn ${turnNumber + 1}/${CONFIG.maxTurns}).`,
      );
    } else {
      log(
        `Required phase checks are not complete. Handing control back to ${providerLabel} ` +
          `(turn ${turnNumber + 1}/${CONFIG.maxTurns}).`,
      );
    }

    PROMPT_PARTIALS = await loadPromptPartials();
    const prompt =
      cleanupOnlyTurn
        ? buildCleanWorktreePrompt(gitStatus, testStatus, turnNumber + 1, phase, phaseStatus)
        : turnNumber === 0 && !hadExistingThread
          ? buildInitialPrompt(testStatus, gitStatus, turnNumber + 1, phase, phaseStatus)
          : buildContinuePrompt(testStatus, gitStatus, turnNumber + 1, phase, phaseStatus);

    let loopGoalEventRecord = null;
    if (CONFIG.loopGoalsEnabled) {
      const preparedGoal = await prepareLoopGoalForTurn({
        threadId: activeThreadId,
        testStatus,
        gitStatus,
        phase,
        phaseStatus,
        turnNumber: turnNumber + 1,
      });
      activeThreadId = preparedGoal.threadId;
      state.threadId = activeThreadId;
      loopGoalEventRecord = buildRalphGoalEventRecord({
        action: "set",
        goal: preparedGoal.goal,
        threadId: activeThreadId,
        turnNumber: turnNumber + 1,
      });
      if (preparedGoal.startedThread) {
        await saveState({
          threadId: activeThreadId,
          eventLogPath: buildEventLogPath(activeThreadId),
          turnsCompleted: turnNumber,
          lastExitCode: phaseStatus.allRequiredPassed ? 0 : phaseStatus.failedRequiredChecks[0]?.exitCode ?? testStatus.exitCode,
          lastTestStatus: testStatus,
          activeStage: getStateActiveStageAfterTest(testStatus),
          activePhase: phase.name,
          phaseAttempted: state.phaseAttempted === true,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (!thread) {
      backend = createAgentBackend();
      thread = activeThreadId
        ? backend.resumeThread(activeThreadId, threadOptions)
        : backend.startThread(threadOptions);
      if (activeThreadId) {
        log(`Resuming ${providerLabel} thread ${activeThreadId}`);
      } else {
        log(`Starting a new ${providerLabel} thread`);
      }
    }

    const turnPrompt = attachPortableGoalPrompt(prompt, loopGoalEventRecord?.event?.goal);
    log(`Ralph prompt: ${previewText(turnPrompt)}`);
    const { events } = await thread.runStreamed(turnPrompt);
    const turn = await collectStreamedTurn(events, {
      prompt: turnPrompt,
      preTurnEventRecords: [
        buildRalphPhaseStatusEventRecord({
          phaseStatus,
          threadId: thread.id ?? activeThreadId,
          turnNumber: turnNumber + 1,
          action: "turn-start",
        }),
        buildRalphTestStatusEventRecord({
          testStatus,
          threadId: thread.id ?? activeThreadId,
          turnNumber,
        }),
        loopGoalEventRecord,
      ],
      threadId: thread.id ?? activeThreadId,
      turnNumber: turnNumber + 1,
    });
    activeThreadId = thread.id ?? turn.threadId ?? activeThreadId;

    const phaseAttemptedAfterTurn = cleanupOnlyTurn ? state.phaseAttempted === true : true;
    await saveState({
      threadId: activeThreadId,
      eventLogPath: buildEventLogPath(activeThreadId),
      turnsCompleted: turnNumber + 1,
      lastExitCode: phaseStatus.allRequiredPassed ? 0 : phaseStatus.failedRequiredChecks[0]?.exitCode ?? testStatus.exitCode,
      lastTestStatus: testStatus,
      activeStage: getStateActiveStageAfterTest(testStatus),
      activePhase: phase.name,
      phaseAttempted: phaseAttemptedAfterTurn,
      updatedAt: new Date().toISOString(),
    });
    state.threadId = activeThreadId;
    state.lastExitCode = phaseStatus.allRequiredPassed ? 0 : phaseStatus.failedRequiredChecks[0]?.exitCode ?? testStatus.exitCode;
    state.lastTestStatus = testStatus;
    state.activeStage = getStateActiveStageAfterTest(testStatus);
    state.activePhase = phase.name;
    state.phaseAttempted = phaseAttemptedAfterTurn;
    turnNumber += 1;
    state.turnsCompleted = turnNumber;
    try {
      await pushCurrentBranch(CONFIG.workdir);
    } catch (error) {
      log(`Failed to push branch after turn ${turnNumber}: ${formatErrorMessage(error)}`);
    }

    if (activeThreadId) {
      log(`Active thread id: ${activeThreadId}`);
    }
    if (turn.usage) {
      log(`Token usage: ${formatUsage(turn.usage)}`);
    }
    if (turn.finalResponse.trim()) {
      log(`${providerLabel} response: ${previewText(turn.finalResponse)}`);
    }
  }

  throw new Error(
    `Hit the max turn limit (${CONFIG.maxTurns}) and required phase checks still fail.`,
  );
}

function buildInitialPrompt(testStatus, gitStatus, turnNumber = null, phase = null, phaseStatus = null) {
  const defaultPrompt = buildDefaultPrompt({ testStatus, gitStatus, turnNumber, phase, phaseStatus });
  if (defaultPromptHasCurrentState(phase)) {
    return defaultPrompt;
  }

  return [
    defaultPrompt,
    "",
    ...buildFailureSummaryLines(testStatus, phaseStatus),
    "",
    ...buildGitStatusLines(gitStatus),
  ].join("\n");
}

function buildContinuePrompt(testStatus, gitStatus, turnNumber = null, phase = null, phaseStatus = null) {
  const defaultPrompt = buildDefaultPrompt({ testStatus, gitStatus, turnNumber, phase, phaseStatus });
  if (defaultPromptHasCurrentState(phase)) {
    return defaultPrompt;
  }

  const objectiveLines = buildContinueObjectiveLines(testStatus, phase, phaseStatus);
  const failureSummaryLines = buildFailureSummaryLines(testStatus, phaseStatus);

  return [
    defaultPrompt,
    "",
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

function buildCleanWorktreePrompt(gitStatus, testStatus, turnNumber = null, phase = null, phaseStatus = null) {
  const defaultPrompt = buildDefaultPrompt({ testStatus, gitStatus, turnNumber, phase, phaseStatus });
  if (defaultPromptHasCurrentState(phase)) {
    return defaultPrompt;
  }

  return [
    defaultPrompt,
    "",
    "The required checks now pass, but the worktree is not clean yet.",
    "Commit the intended changes now so `git status --short` is empty before handing control back.",
    "Do not discard intended work. Create the appropriate commit(s) and leave the repository clean.",
    "",
    ...buildTestStatusLines(testStatus),
    ...buildCheckResultLines(phaseStatus),
    "",
    ...buildGitStatusLines(gitStatus),
  ].join("\n");
}

function buildGitStatusLines(gitStatus) {
  return gitStatus.clean
    ? ["Current `git status --short`: empty"]
    : ["Current `git status --short`:", trimmedOutput(gitStatus.output)];
}

function buildContinueObjectiveLines(testStatus, phase = null, phaseStatus = null) {
  const lines = [];
  const targetStage = getObjectiveTargetStage(testStatus);
  const reportTarget = targetStage
    ? buildTestCommandForStage(targetStage)
    : getTestStatusCommand(testStatus);

  if (phaseStatus?.allRequiredPassed && phase?.runWhenChecksPass) {
    lines.push(
      `All required checks currently pass for phase \`${phase.name}\`. Complete the phase work described in the prompt before returning.`,
    );
    return lines;
  }

  if (phaseStatus?.failedRequiredChecks?.length > 0) {
    const failedChecks = phaseStatus.failedRequiredChecks
      .map((check) => `\`${check.name}\``)
      .join(", ");
    lines.push(`Required check(s) ${failedChecks} are failing and must pass before this phase can complete.`);
  }

  if (testStatus.regressions.length > 0) {
    lines.push(
      `Latest commit(s) caused regressions in ${formatStageList(testStatus.regressions)}. ` +
        `Fix them as blockers for the current target \`${reportTarget}\`.`,
    );
  }

  if (testStatus?.passingThrough && testStatus?.failingStage) {
    lines.push(
      `Assignments through \`${testStatus.passingThrough}\` already pass.`,
      `Your task for this turn is to implement the code required to make ` +
        `\`${reportTarget}\` fully pass before returning, without causing regressions for previous ` +
        "assignments.",
    );
    return lines;
  }

  if (testStatus?.failingStage) {
    lines.push(
      `\`${reportTarget}\` is still failing, continue work on that stage until it fully passes.`,
    );
    return lines;
  }

  lines.push(
    `I reran \`${getTestStatusCommand(testStatus)}\` from the repository root and it still fails.`,
    `Latest exit code: ${testStatus.exitCode}`,
  );
  return lines;
}

function buildFailureSummaryLines(testStatus, phaseStatus = null) {
  const lines = [`Latest exit code: ${testStatus.exitCode}`];

  lines.push(...buildTestStatusLines(testStatus));
  if (phaseStatus) {
    lines.push(...buildCheckResultLines(phaseStatus));
  }

  if (testStatus.regressions.length > 0) {
    lines.push(`Regression summary: ${formatStageList(testStatus.regressions)} regressed.`);
  }

  const firstBlockerLine = formatFirstBlockerLine(testStatus);
  if (firstBlockerLine) {
    lines.push(firstBlockerLine);
  }
  lines.push(...buildTimeoutGuidanceLines(testStatus));

  lines.push(
    `Full primary check output is in \`${path.join(CONFIG.stateDir, "last-test.log")}\` if you need more detail.`,
    "After the current blocker is fixed, rerun the required command and keep going until Ralph's configured success condition passes.",
  );

  return lines;
}

function buildDefaultPrompt({ testStatus, gitStatus, turnNumber = null, phase = null, phaseStatus = null }) {
  const template = getDefaultPromptTemplate(phase);
  return renderTemplateContent(
    template,
    buildTemplateContext({ testStatus, gitStatus, turnNumber, phase, phaseStatus }),
  );
}

function getDefaultPromptTemplate(phase = null) {
  return phase && PROMPT_PARTIALS.phasePrompts?.[phase.name]?.content
    ? PROMPT_PARTIALS.phasePrompts[phase.name].content
    : PROMPT_PARTIALS.defaultPrompt?.content ?? DEFAULT_PROMPT;
}

function defaultPromptHasCurrentState(phase = null) {
  return /\{\{\s*currentState\s*\}\}/.test(getDefaultPromptTemplate(phase));
}

function buildTemplateContext({ testStatus, gitStatus, turnNumber = null, phase = null, phaseStatus = null }) {
  phase = phase ?? CONFIG.phases[0];
  const primaryCheck = phaseStatus?.primaryCheck ?? { command: getTestStatusCommand(testStatus), name: getPrimaryCheck().name };
  const activeStage = phaseStatus?.stage ?? testStatus?.targetStage ?? resolveActiveTestStage({
    activeStage: testStatus?.targetStage,
    lastTestStatus: testStatus,
  });
  const testStatusLines = buildTestStatusLines(testStatus);
  const checkResultLines = phaseStatus ? buildCheckResultLines(phaseStatus) : [];
  const gitStatusLines = buildGitStatusLines(gitStatus);
  const continueObjectiveLines = buildContinueObjectiveLines(testStatus, phase, phaseStatus);
  const failureSummaryLines = buildFailureSummaryLines(testStatus, phaseStatus);
  const goalTaskLines = buildLoopGoalTaskLines({ testStatus, gitStatus, phase, phaseStatus });
  const currentStateLines = buildCurrentStateLines({
    testStatus,
    gitStatus,
    turnNumber,
    phase,
    phaseStatus,
    continueObjectiveLines,
    failureSummaryLines,
    gitStatusLines,
  });

  return {
    defaultPrompt: DEFAULT_PROMPT,
    runName: CONFIG.runName,
    name: CONFIG.name,
    workdir: CONFIG.workdir,
    stateDir: CONFIG.stateDir,
    phaseName: phase.name,
    activePhase: phase.name,
    phaseChecks: formatPhaseChecksForTemplate(phase, activeStage),
    checkResults: checkResultLines.join("\n"),
    checkResultsBlock: checkResultLines.join("\n"),
    checkResultsJson: JSON.stringify(phaseStatus ?? null, null, 2),
    primaryCheckName: primaryCheck.name ?? "",
    primaryCheckCommand: primaryCheck.command ?? getTestStatusCommand(testStatus),
    testCommand: primaryCheck.command ?? getTestStatusCommand(testStatus),
    testCommandTemplate: primaryCheck.commandTemplate ?? CONFIG.testCommand,
    testStage: activeStage ?? "",
    stageNumber: activeStage?.slice(2) ?? "",
    turnNumber: turnNumber == null ? "" : String(turnNumber),
    exitCode: String(testStatus?.exitCode ?? ""),
    failingStage: testStatus?.failingStage ?? "",
    passingThrough: testStatus?.passingThrough ?? "",
    firstFailureLine: testStatus?.firstFailureLine ?? "",
    firstFailureBlocker: formatFirstBlockerLine(testStatus),
    firstFailureKind: testStatus?.firstFailureKind ?? "",
    timeoutGuidance: buildTimeoutGuidanceLines(testStatus).join("\n"),
    regressions: formatStageList(testStatus?.regressions ?? []),
    testStatusSummary: formatTestStatusSummary(testStatus),
    stageBreakdown: testStatus?.stages?.length ? formatStageBreakdown(testStatus) : "",
    testStatusBlock: testStatusLines.join("\n"),
    testStatusJson: JSON.stringify(testStatus, null, 2),
    gitStatus: gitStatusLines.join("\n"),
    gitStatusBlock: gitStatusLines.join("\n"),
    gitStatusOutput: gitStatus.clean ? "empty" : trimmedOutput(gitStatus.output),
    currentState: currentStateLines.join("\n"),
    worktreeHandoff: gitStatus.clean
      ? "The worktree is currently clean."
      : "Your previous turn left a dirty worktree. Commit intended changes before returning control.",
    continueObjective: continueObjectiveLines.join("\n"),
    failureSummary: failureSummaryLines.join("\n"),
    lastTestLogPath: path.join(CONFIG.stateDir, "last-test.log"),
    goalTask: goalTaskLines.join("\n"),
    goalHandoffRequirement:
      phaseStatus?.allRequiredPassed && !gitStatus.clean
        ? ""
        : "Commit cohesive progress as you go; before handing control back, ensure all intended work is committed and `git status --short` is empty.",
  };
}

function renderTemplateContent(template, context) {
  return normalizeRenderedPrompt(
    template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) =>
      context[key] == null ? "" : String(context[key]),
    ),
  );
}

function buildCurrentStateLines({
  testStatus,
  gitStatus,
  turnNumber = null,
  phase = null,
  phaseStatus = null,
  continueObjectiveLines = null,
  failureSummaryLines = null,
  gitStatusLines = null,
}) {
  const lines = [];
  const objectiveLines = continueObjectiveLines ?? buildContinueObjectiveLines(testStatus, phase, phaseStatus);
  const summaryLines = failureSummaryLines ?? buildFailureSummaryLines(testStatus, phaseStatus);
  const statusLines = gitStatusLines ?? buildGitStatusLines(gitStatus);

  if (turnNumber != null) {
    lines.push(`- Ralph turn: ${turnNumber}`);
  }
  lines.push(
    `- Run: ${CONFIG.runName}`,
    `- Workdir: \`${CONFIG.workdir}\``,
  );
  if (phase?.name) {
    lines.push(`- Current phase: \`${phase.name}\``);
  }
  if (testStatus?.targetStage) {
    lines.push(`- Current stage: \`${testStatus.targetStage}\``);
  }
  lines.push("", "Required checks:");
  if (phaseStatus?.checks?.length) {
    for (const check of phaseStatus.checks) {
      lines.push(
        `- ${check.name}: \`${check.command}\` (${check.required ? "required" : "optional"})`,
      );
    }
  } else if (phase) {
    lines.push(...formatPhaseChecksForTemplate(phase, testStatus?.targetStage).split("\n"));
  } else {
    lines.push(`- ${getPrimaryCheck().name}: \`${getTestStatusCommand(testStatus)}\` (required, primary)`);
  }

  if (objectiveLines.length > 0) {
    lines.push("", "Current task:", ...objectiveLines.map((line) => `- ${line}`));
  }

  lines.push(
    "",
    `Latest test status: ${formatTestStatusSummary(testStatus)}`,
  );
  if (testStatus?.stages?.length) {
    lines.push(`Stage breakdown: ${formatStageBreakdown(testStatus)}`);
  }
  if (phaseStatus?.checks?.length) {
    lines.push(...buildCheckResultLines(phaseStatus));
  }
  const firstBlockerLine = formatFirstBlockerLine(testStatus);
  if (firstBlockerLine) {
    lines.push(firstBlockerLine);
  }
  lines.push(...buildTimeoutGuidanceLines(testStatus));
  if (testStatus?.regressions?.length) {
    lines.push(`Regressions: ${formatStageList(testStatus.regressions)}`);
  }

  lines.push(
    `Last full test output: \`${path.join(CONFIG.stateDir, "last-test.log")}\``,
    "",
    "Repository status:",
    ...statusLines,
  );

  if (summaryLines.length > 0) {
    lines.push("", "Detailed latest state:", ...summaryLines);
  }

  return lines;
}

function normalizeRenderedPrompt(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attachPortableGoalPrompt(prompt, goal) {
  if (!goal || CONFIG.provider === "codex") {
    return prompt;
  }

  return normalizeRenderedPrompt([
    prompt,
    "",
    "## Ralph Portable Goal",
    "",
    "This is the active Ralph loop goal. Treat it as mandatory state for this turn.",
    "Use `get_ralph_goal` if you need the current goal repeated. Use `report_ralph_progress` for notable progress. Call `complete_ralph_goal` only when you believe the goal is ready for Ralph's external checks; Ralph will still verify with real commands before advancing.",
    "",
    goal.objective,
  ].join("\n"));
}

function analyzeTestProgress(output, previousStatus = null, options = {}) {
  const normalizedOutput = typeof output === "string" ? output : "";
  const stagePattern = /^===== (pa\d+) =====$/gm;
  const stageHeaders = [...normalizedOutput.matchAll(stagePattern)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  const firstFailureLine = findFirstFailureLine(normalizedOutput);

  const stages = stageHeaders.map((stage, index) => {
    const start = stage.index;
    const end = index + 1 < stageHeaders.length ? stageHeaders[index + 1].index : normalizedOutput.length;
    return parseStageStatus(stage.name, normalizedOutput.slice(start, end));
  });
  const reportSummary = parseReportSummary(normalizedOutput);
  applyReportSummaryToStages(stages, previousStatus, reportSummary);

  const failingIndex = stages.findIndex((stage) => stage.status === "fail");
  const failingStage = failingIndex >= 0 ? stages[failingIndex].name : null;
  const stageNames = stages.map((stage) => stage.name);
  const canInferPassingThrough = isContiguousStagePrefix(stageNames);
  const passingThrough =
    canInferPassingThrough && failingIndex > 0
      ? stages[failingIndex - 1].name
      : canInferPassingThrough &&
          failingIndex < 0 &&
          stages.length > 0 &&
          stages.every((stage) => stage.status === "pass")
        ? stages[stages.length - 1].name
        : null;

  const previousPassingStages = new Set(
    (previousStatus?.stages ?? [])
      .filter((stage) => stage?.status === "pass" && typeof stage.name === "string")
      .map((stage) => stage.name),
  );
  const regressions = stages
    .filter((stage) => previousPassingStages.has(stage.name) && stage.status === "fail")
    .map((stage) => stage.name);

  const testsPassed = reportSummary?.passed ?? stages.reduce((sum, stage) => sum + stage.passed, 0);
  const testsTotal = reportSummary?.total ?? stages.reduce((sum, stage) => sum + stage.total, 0);
  const stagesPassed = stages.filter((stage) => stage.status === "pass").length;
  const timeoutFailures = stages.reduce((sum, stage) => sum + (stage.timeouts ?? 0), 0);
  const timeoutExpectationFailures = stages.reduce(
    (sum, stage) => sum + (stage.timeoutExpectations ?? 0),
    0,
  );

  return {
    recordedAt: new Date().toISOString(),
    command: options.command ?? getPrimaryCheck().command,
    commandTemplate: options.commandTemplate ?? getPrimaryCheck().command,
    targetStage: options.targetStage ?? null,
    usesStageTemplate: Boolean(options.usesStageTemplate),
    exitCode: options.exitCode ?? null,
    allTestsPassed:
      reportSummary?.allPassed ||
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
    firstFailureKind: classifyFailureLine(firstFailureLine),
    timeoutFailures,
    timeoutExpectationFailures,
    regressions,
    stages,
  };
}

function parseReportSummary(output) {
  const allPassedMatch = output.match(
    /^===== ALL TESTS PASSED SUCCESSFULLY!(?: \((\d+)\s*\/\s*(\d+)\))? =====$/m,
  );
  if (allPassedMatch) {
    return {
      allPassed: true,
      passed: parseOptionalCount(allPassedMatch[1]),
      total: parseOptionalCount(allPassedMatch[2]),
    };
  }

  const summaryMatch = output.match(/^===== TEST SUMMARY: (\d+)\s*\/\s*(\d+) TESTS PASSED =====$/m);
  if (summaryMatch) {
    return {
      allPassed: false,
      passed: Number.parseInt(summaryMatch[1], 10),
      total: Number.parseInt(summaryMatch[2], 10),
    };
  }

  return null;
}

function parseOptionalCount(value) {
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

function applyReportSummaryToStages(stages, previousStatus, reportSummary) {
  if (!reportSummary || stages.length === 0) {
    return;
  }

  const previousStages = new Map(
    (previousStatus?.stages ?? [])
      .filter((stage) => stage?.name)
      .map((stage) => [stage.name, stage]),
  );
  applyPreviousStageCounts(stages, previousStages, reportSummary);
  for (const stage of stages) {
    const previous = previousStages.get(stage.name);
    const hint = getStageCountHint(stage.name);
    if (stage.status === "unknown" && previous?.status === "pass" && hasStageCounts(previous)) {
      setStageStatus(stage, "pass", previous.passed, previous.total);
    } else if (
      stage.status === "fail" &&
      !hasStageCounts(stage) &&
      previous?.status === "pass" &&
      hasStageCounts(previous) &&
      Number.isFinite(stage.failed)
    ) {
      setStageStatus(stage, "fail", Math.max(0, previous.total - stage.failed), previous.total);
    } else if (
      stage.status === "fail" &&
      !hasStageCounts(stage) &&
      hint &&
      Number.isFinite(stage.failed)
    ) {
      setStageStatus(stage, "fail", Math.max(0, hint.total - stage.failed), hint.total);
    }
  }
  inferEmptyReportStagesPassed(stages);

  if (reportSummary.allPassed) {
    inferAllStagesPassed(stages, reportSummary);
    return;
  }

  const failingIndex = stages.findIndex((stage) => stage.status === "fail");
  if (failingIndex < 0) {
    return;
  }

  if (stageCountsMatchReportSummary(stages, reportSummary)) {
    return;
  }

  inferPreviousStagesPassed(stages.slice(0, failingIndex), reportSummary.passed);

  const failingStage = stages[failingIndex];
  if (hasStageCounts(failingStage)) {
    return;
  }

  const canAllocateFailingCounts =
    failingIndex === 0 || stages.slice(0, failingIndex).every((stage) => hasStageCounts(stage));
  if (!canAllocateFailingCounts) {
    setStageStatus(failingStage, "fail", failingStage.passed, failingStage.total);
    return;
  }

  const passedBefore = stages
    .slice(0, failingIndex)
    .reduce((sum, stage) => sum + (stage.passed ?? 0), 0);
  const totalBefore = stages
    .slice(0, failingIndex)
    .reduce((sum, stage) => sum + (stage.total ?? 0), 0);
  const failingPassed =
    reportSummary.passed == null
      ? failingStage.passed
      : Math.max(0, reportSummary.passed - passedBefore);
  const failingTotal =
    reportSummary.total == null
      ? Math.max(failingStage.total, failingPassed)
      : Math.max(failingPassed, reportSummary.total - totalBefore);
  setStageStatus(failingStage, "fail", failingPassed, failingTotal);
}

function inferEmptyReportStagesPassed(stages) {
  for (const stage of stages) {
    if (isEmptyUnknownStageReport(stage)) {
      const hint = getStageCountHint(stage.name);
      setStageStatus(stage, "pass", hint?.passed ?? stage.passed, hint?.total ?? stage.total);
    }
  }
}

function isEmptyUnknownStageReport(stage) {
  return stage?.status === "unknown" &&
    (stage.failed ?? 0) === 0 &&
    (stage.timeouts ?? 0) === 0 &&
    (stage.timeoutExpectations ?? 0) === 0 &&
    (stage.targets?.length ?? 0) === 0;
}

function getStageCountHint(stageName) {
  const hint = STAGE_COUNT_HINTS.get(stageName);
  return hasStageCounts(hint) ? hint : null;
}

function applyPreviousStageCounts(stages, previousStages, reportSummary) {
  const snapshots = stages.map((stage) => ({
    stage,
    status: stage.status,
    passed: stage.passed,
    total: stage.total,
  }));

  for (const stage of stages) {
    const previous = previousStages.get(stage.name);
    if (hasStageCounts(stage) || !hasStageCounts(previous)) {
      continue;
    }

    if (stage.status === "fail") {
      const failed = Number.isFinite(stage.failed) ? stage.failed : 0;
      setStageStatus(stage, "fail", Math.max(0, previous.total - failed), previous.total);
    } else if (stage.status === "unknown") {
      setStageStatus(stage, "pass", previous.total, previous.total);
    }
  }

  if (reportSummary?.passed == null || reportSummary?.total == null) {
    return;
  }
  if (stageCountsMatchReportSummary(stages, reportSummary)) {
    return;
  }

  for (const snapshot of snapshots) {
    snapshot.stage.status = snapshot.status;
    snapshot.stage.passed = snapshot.passed;
    snapshot.stage.total = snapshot.total;
  }
}

function stageCountsMatchReportSummary(stages, reportSummary) {
  if (reportSummary?.passed == null || reportSummary?.total == null) {
    return false;
  }
  if (!stages.every((stage) => hasStageCounts(stage))) {
    return false;
  }
  const passed = stages.reduce((sum, stage) => sum + stage.passed, 0);
  const total = stages.reduce((sum, stage) => sum + stage.total, 0);
  return passed === reportSummary.passed && total === reportSummary.total;
}

function inferAllStagesPassed(stages, reportSummary) {
  const unresolved = stages.filter((stage) => stage.status !== "pass" || !hasStageCounts(stage));
  const knownTotal = stages
    .filter((stage) => !unresolved.includes(stage))
    .reduce((sum, stage) => sum + (stage.total ?? 0), 0);
  const remaining =
    reportSummary.total == null ? null : Math.max(0, reportSummary.total - knownTotal);

  for (const stage of unresolved) {
    if (unresolved.length === 1 && remaining != null) {
      setStageStatus(stage, "pass", remaining, remaining);
    } else {
      setStageStatus(stage, "pass", stage.passed, stage.total);
    }
  }
}

function inferPreviousStagesPassed(stages, passedCount) {
  const unresolved = stages.filter((stage) => stage.status !== "pass" || !hasStageCounts(stage));
  const knownTotal = stages
    .filter((stage) => !unresolved.includes(stage))
    .reduce((sum, stage) => sum + (stage.total ?? 0), 0);
  const remaining = passedCount == null ? null : Math.max(0, passedCount - knownTotal);

  for (const stage of unresolved) {
    if (unresolved.length === 1 && remaining != null) {
      setStageStatus(stage, "pass", remaining, remaining);
    } else {
      setStageStatus(stage, "pass", stage.passed, stage.total);
    }
  }
}

function hasStageCounts(stage) {
  return Number.isFinite(stage?.passed) && Number.isFinite(stage?.total) && stage.total > 0;
}

function setStageStatus(stage, status, passed, total) {
  stage.status = status;
  stage.passed = Number.isFinite(passed) ? passed : 0;
  stage.total = Number.isFinite(total) ? total : 0;
}

function parseStageStatus(stageName, body) {
  const targets = new Map();
  const failureLines = [];

  for (const line of body.split(/\r?\n/)) {
    if (isTestFailureLine(line)) {
      failureLines.push(line);
    }

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
  const timeouts = failureLines.filter((line) => classifyFailureLine(line) === "timeout").length;
  const timeoutExpectations = failureLines.filter(
    (line) => classifyFailureLine(line) === "timeout_expected",
  ).length;
  const targetFailureCount = stageTargets.reduce((sum, target) => {
    if (target.status !== "fail" || !Number.isFinite(target.total) || !Number.isFinite(target.passed)) {
      return sum;
    }
    return sum + Math.max(0, target.total - target.passed);
  }, 0);
  const failed = Math.max(failureLines.length, targetFailureCount);
  const hasFailureMarker = failed > 0 || /\bFAIL\b|ERROR:/.test(body);
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
    failed,
    timeouts,
    timeoutExpectations,
    targets: stageTargets,
  };
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

function buildCheckResultLines(phaseStatus) {
  if (!phaseStatus?.checks?.length) {
    return [];
  }
  const lines = [
    `Phase checks (${phaseStatus.phase}): ${formatPhaseCheckResults(phaseStatus)}`,
  ];
  for (const check of phaseStatus.failedRequiredChecks ?? []) {
    lines.push(
      `Required check \`${check.name}\` failed with exit ${check.exitCode}; output: \`${check.outputPath}\``,
    );
  }
  return lines;
}

function formatPhaseCheckResults(phaseStatus) {
  return phaseStatus.checks
    .map((check) =>
      `${check.name} ${check.passed ? "pass" : "fail"} (${check.exitCode})`,
    )
    .join("; ");
}

function formatPhaseChecksForTemplate(phase, stage) {
  return phase.checks
    .map((name) => {
      const check = getCheckByName(name);
      const required = check.required ? "required" : "optional";
      const primary = check.primary ? ", primary" : "";
      return `- ${check.name}: \`${buildCheckCommandForStage(check, stage)}\` (${required}${primary})`;
    })
    .join("\n");
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

  const timeoutSummary = formatTimeoutStatusSummary(testStatus);
  if (timeoutSummary) {
    parts.push(timeoutSummary);
  }

  return parts.join("; ");
}

function formatStageBreakdown(testStatus) {
  return testStatus.stages.map((stage) => formatSingleStageBreakdown(stage)).join("; ");
}

function formatSingleStageBreakdown(stage) {
  const targetSummary = stage.targets
    .map((target) => {
      if (!Number.isFinite(target.total) || target.total <= 0) {
        return `${target.name} ${target.status}`;
      }
      return `${target.name} ${target.passed ?? 0}/${target.total}`;
    })
    .join(", ");
  const stageSummary = hasStageCounts(stage)
    ? `${stage.name} ${stage.passed}/${stage.total} ${stage.status}`
    : `${stage.name} ${stage.status}`;
  const failureSummary = Number.isFinite(stage.failed) && stage.failed > 0
    ? `${stage.failed} failing`
    : "";
  const timeoutSummary = formatStageTimeoutSummary(stage);
  const details = [failureSummary, timeoutSummary, targetSummary].filter(Boolean).join(", ");
  return details ? `${stageSummary} (${details})` : stageSummary;
}

function formatTimeoutStatusSummary(testStatus) {
  const timeoutFailures = testStatus?.timeoutFailures ?? 0;
  const timeoutExpectationFailures = testStatus?.timeoutExpectationFailures ?? 0;
  const parts = [];
  if (timeoutFailures > 0) {
    parts.push(formatCount(timeoutFailures, "timeout failure"));
  }
  if (timeoutExpectationFailures > 0) {
    parts.push(formatCount(timeoutExpectationFailures, "timeout expectation mismatch", "timeout expectation mismatches"));
  }
  return parts.join(", ");
}

function formatStageTimeoutSummary(stage) {
  const parts = [];
  if ((stage?.timeouts ?? 0) > 0) {
    parts.push(formatCount(stage.timeouts, "timeout"));
  }
  if ((stage?.timeoutExpectations ?? 0) > 0) {
    parts.push(formatCount(stage.timeoutExpectations, "timeout expectation mismatch", "timeout expectation mismatches"));
  }
  return parts.join(", ");
}

function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatFirstBlockerLine(testStatus) {
  if (!testStatus?.firstFailureLine) {
    return "";
  }
  if (testStatus.firstFailureKind === "timeout") {
    return `First reported blocker is a timeout: ${testStatus.firstFailureLine}`;
  }
  if (testStatus.firstFailureKind === "timeout_expected") {
    return `First reported blocker is a timeout expectation mismatch: ${testStatus.firstFailureLine}`;
  }
  return `First reported blocker: ${testStatus.firstFailureLine}`;
}

function buildTimeoutGuidanceLines(testStatus) {
  if (!testStatus) {
    return [];
  }
  if (testStatus.firstFailureKind === "timeout" || (testStatus.timeoutFailures ?? 0) > 0) {
    return [
      "Timeout guidance: tests can run concurrently, so code that barely beats the timeout can still be flaky. Treat this as a root-cause performance or termination bug; redesign inefficient work rather than increasing timeouts, skipping tests, or special-casing inputs.",
    ];
  }
  if (
    testStatus.firstFailureKind === "timeout_expected" ||
    (testStatus.timeoutExpectationFailures ?? 0) > 0
  ) {
    return [
      "Timeout guidance: preserve the expected timeout behavior and fix the semantic/status mismatch rather than bypassing the test.",
    ];
  }
  return [];
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

async function runPhaseChecks(state, phase) {
  const stage = resolveActiveTestStage(state);
  const checks = phase.checks.map((name) => getCheckByName(name));
  const results = [];
  let primaryTestStatus = null;
  let previousTestStatus = state.lastTestStatus;

  for (const check of checks) {
    const context = buildCheckCommandContext(check, stage);
    log(`Running ${phase.name} check ${check.name}: ${context.command}`);
    const run = await runCommand(context.command, CONFIG.workdir);
    const outputPath = await writeCheckLog(check.name, run.output);
    const result = {
      name: check.name,
      kind: check.kind,
      required: check.required,
      primary: check.primary,
      command: context.command,
      commandTemplate: context.template,
      usesStageTemplate: context.usesStageTemplate,
      targetStage: context.stage,
      exitCode: run.exitCode,
      passed: run.exitCode === 0,
      outputPath,
      outputPreview: previewText(run.output),
    };

    if (check.primary || check.kind === "test") {
      const testStatus = analyzeTestProgress(run.output, previousTestStatus, {
        command: context.command,
        commandTemplate: context.template,
        exitCode: run.exitCode,
        targetStage: context.stage,
        usesStageTemplate: context.usesStageTemplate,
      });
      result.testStatus = testStatus;
      previousTestStatus = testStatus;
      if (check.primary || !primaryTestStatus) {
        primaryTestStatus = testStatus;
        await fs.writeFile(TEST_LOG_PATH, run.output, "utf8");
      }
    }

    results.push(result);
  }

  const required = results.filter((result) => result.required);
  const failedRequired = required.filter((result) => !result.passed);
  return {
    phase: phase.name,
    stage,
    checks: results,
    primaryCheck: results.find((result) => result.primary) ?? results[0] ?? null,
    testStatus: primaryTestStatus ?? buildGenericTestStatus(results[0], stage),
    allRequiredPassed: failedRequired.length === 0,
    failedRequiredChecks: failedRequired,
  };
}

async function writeCheckLog(checkName, output) {
  await fs.mkdir(CHECK_LOG_DIR_PATH, { recursive: true });
  const safeName = sanitizeIdentifier(checkName, "check log name");
  const filePath = path.join(CHECK_LOG_DIR_PATH, `last-${safeName}.log`);
  await fs.writeFile(filePath, output, "utf8");
  return filePath;
}

function buildGenericTestStatus(result, stage) {
  return {
    recordedAt: new Date().toISOString(),
    command: result?.command ?? "",
    commandTemplate: result?.commandTemplate ?? "",
    targetStage: stage ?? null,
    usesStageTemplate: Boolean(result?.usesStageTemplate),
    exitCode: result?.exitCode ?? null,
    allTestsPassed: Boolean(result?.passed),
    stageCount: 0,
    stagesPassed: 0,
    testsPassed: result?.passed ? 1 : 0,
    testsTotal: 1,
    failingStage: null,
    passingThrough: null,
    firstFailureLine: result?.passed ? null : `${result?.name ?? "check"} failed`,
    firstFailureKind: null,
    timeoutFailures: 0,
    timeoutExpectationFailures: 0,
    regressions: [],
    stages: [],
  };
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

async function prepareLoopGoalForTurn({ threadId, testStatus, gitStatus, turnNumber, phase, phaseStatus }) {
  if (CONFIG.provider !== "codex") {
    return preparePortableLoopGoalForTurn({ threadId, testStatus, gitStatus, turnNumber, phase, phaseStatus });
  }

  return withCodexAppServer(async (client) => {
    let activeThreadId = threadId;
    let startedThread = false;

    if (!activeThreadId) {
      const response = await client.request("thread/start", buildAppServerThreadStartParams());
      activeThreadId = response?.thread?.id ?? null;
      if (!activeThreadId) {
        throw new Error(`thread/start did not return a thread id: ${JSON.stringify(response)}`);
      }
      startedThread = true;
      log(`Pre-created Codex thread ${activeThreadId} for loop goals`);
    }

    await client.request("thread/goal/clear", { threadId: activeThreadId });

    const params = {
      threadId: activeThreadId,
      objective: buildLoopGoalObjective({ testStatus, gitStatus, turnNumber, phase, phaseStatus }),
      status: "active",
    };
    if (CONFIG.goalTokenBudget != null) {
      params.tokenBudget = CONFIG.goalTokenBudget;
    }

    const response = await client.request("thread/goal/set", params);
    if (!response?.goal) {
      throw new Error(`thread/goal/set did not return a goal: ${JSON.stringify(response)}`);
    }
    log(`Set Codex loop goal: ${previewText(response.goal.objective)}`);
    return { threadId: activeThreadId, goal: response.goal, startedThread };
  });
}

async function completeLoopGoalIfPresent(threadId, testStatus, turnNumber) {
  if (!CONFIG.loopGoalsEnabled || !threadId) {
    return;
  }

  if (CONFIG.provider !== "codex") {
    await completePortableLoopGoalIfPresent(threadId, testStatus, turnNumber);
    return;
  }

  try {
    await withCodexAppServer(async (client) => {
      const current = await client.request("thread/goal/get", { threadId });
      if (!current?.goal || current.goal.status === "complete") {
        return;
      }

      const response = await client.request("thread/goal/set", {
        threadId,
        status: "complete",
      });
      const record = buildRalphGoalEventRecord({
        action: "complete",
        goal: response.goal,
        threadId,
        turnNumber,
        testStatus,
      });
      await appendRalphEventRecord(record);
      log(`Marked Codex loop goal complete: ${previewText(response.goal.objective)}`);
    });
  } catch (error) {
    log(`Failed to mark Codex loop goal complete: ${formatErrorMessage(error)}`);
  }
}

async function preparePortableLoopGoalForTurn({ threadId, testStatus, gitStatus, turnNumber, phase, phaseStatus }) {
  const activeThreadId = threadId ?? (CONFIG.provider === "antigravity" ? null : generateProviderThreadId(CONFIG.provider));
  const startedThread = !threadId;
  const now = new Date().toISOString();
  const goal = {
    id: `ralph-goal-${turnNumber}`,
    provider: "ralph-portable",
    threadId: activeThreadId,
    objective: buildLoopGoalObjective({ testStatus, gitStatus, turnNumber, phase, phaseStatus }),
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...(CONFIG.goalTokenBudget != null ? { tokenBudget: CONFIG.goalTokenBudget } : {}),
  };
  await writePortableGoalState(goal);
  log(`Set portable loop goal: ${previewText(goal.objective)}`);
  return { threadId: activeThreadId, goal, startedThread };
}

async function completePortableLoopGoalIfPresent(threadId, testStatus, turnNumber) {
  try {
    const goal = await readPortableGoalState(threadId);
    if (!goal || goal.status === "complete") {
      return;
    }
    const completedGoal = {
      ...goal,
      threadId: goal.threadId ?? threadId,
      status: "complete",
      updatedAt: new Date().toISOString(),
    };
    await writePortableGoalState(completedGoal);
    await appendRalphEventRecord(buildRalphGoalEventRecord({
      action: "complete",
      goal: completedGoal,
      threadId,
      turnNumber,
      testStatus,
    }));
    log(`Marked portable loop goal complete: ${previewText(completedGoal.objective)}`);
  } catch (error) {
    log(`Failed to mark portable loop goal complete: ${formatErrorMessage(error)}`);
  }
}

async function writePortableGoalState(goal) {
  await fs.mkdir(CONFIG.stateDir, { recursive: true });
  await fs.writeFile(getPortableGoalPath(), JSON.stringify(goal, null, 2), "utf8");
}

async function readPortableGoalState(threadId) {
  try {
    const raw = await fs.readFile(getPortableGoalPath(), "utf8");
    const goal = JSON.parse(raw);
    if (goal?.threadId && threadId && goal.threadId !== threadId) {
      return null;
    }
    return goal;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function getPortableGoalPath() {
  return path.join(CONFIG.stateDir, "current-goal.json");
}

function buildLoopGoalObjective({ testStatus, gitStatus, turnNumber, phase = null, phaseStatus = null }) {
  phase = phase ?? CONFIG.phases[0];
  const goalTemplate = phase ? PROMPT_PARTIALS.phaseGoals?.[phase.name]?.content : null;
  if (goalTemplate) {
    return truncateGoalObjective(renderTemplateContent(
      goalTemplate,
      buildTemplateContext({ testStatus, gitStatus, turnNumber, phase, phaseStatus }),
    ));
  }

  const stage = getObjectiveTargetStage(testStatus) ?? "";
  const primaryCommand = phaseStatus?.primaryCheck?.command ??
    (stage ? buildTestCommandForStage(stage) : getTestStatusCommand(testStatus));
  const lines = [
    `Ralph loop ${turnNumber} ${phase.name} phase for ${CONFIG.runName}.`,
    "",
    "This goal is the completion gate. The accompanying turn prompt is mandatory, not advisory: every explicit implementation, design, validation, cleanup, documentation, and handoff instruction in that prompt is part of this goal.",
    "",
  ];

  if (stage) {
    lines.push(`Current stage: ${stage}.`);
  }
  lines.push(`Current phase: ${phase.name}.`);

  lines.push("Completion criteria:");
  if (phaseStatus?.allRequiredPassed && !gitStatus.clean) {
    lines.push(
      "- All required phase checks remain passing.",
      "- All explicit requirements in the accompanying turn prompt are satisfied.",
      "- File-size, audit, and architecture requirements are satisfied in substance, not bypassed; pre-existing or newly discovered violations and audit blind spots are fixed as current work.",
      "- Intended changes are committed.",
      "- `git status --short` is empty before handing control back.",
    );
  } else {
    lines.push(
      "- All required phase checks pass:",
      ...formatPhaseChecksForTemplate(phase, stage).split("\n").map((line) => `  ${line}`),
      `- Primary verification command: \`${primaryCommand}\`.`,
      "- Previous stages do not regress.",
      "- All explicit requirements in the accompanying turn prompt are satisfied, including any requested planning, review, cleanup, documentation, or retrospective work.",
      "- No required prompt item is skipped, weakened into a note, or deferred after the test gate passes.",
      "- File-size, audit, and architecture requirements are satisfied in substance, not bypassed; pre-existing or newly discovered violations and audit blind spots are fixed as current work.",
      "- Intended changes are committed.",
      "- `git status --short` is empty before handing control back.",
    );
  }

  return truncateGoalObjective(lines.join("\n"));
}

function buildLoopGoalTaskLines({ testStatus, gitStatus, phase = null, phaseStatus = null }) {
  const lines = [];

  if (phaseStatus?.allRequiredPassed && !gitStatus.clean) {
    lines.push(
      "All required phase checks now pass, but the worktree is dirty.",
      "Commit intended changes now as cohesive progress commits and leave `git status --short` empty before handing control back.",
    );
    return lines;
  }

  if (phaseStatus?.failedRequiredChecks?.length > 0) {
    const failedChecks = phaseStatus.failedRequiredChecks
      .map((check) => `\`${check.name}\``)
      .join(", ");
    lines.push(`Required phase check(s) ${failedChecks} are failing.`);
  }

  if (phaseStatus?.allRequiredPassed && phase?.runWhenChecksPass) {
    lines.push(`All required checks pass; complete the required \`${phase.name}\` phase work before returning.`);
    return lines;
  }

  if (testStatus.regressions.length > 0) {
    lines.push(
      `Regressions found in ${formatStageList(testStatus.regressions)}; fix them as blockers while keeping the current target.`,
    );
  }

  if (testStatus.passingThrough && testStatus.failingStage) {
    const targetStage = getObjectiveTargetStage(testStatus);
    const reportTarget = targetStage
      ? buildTestCommandForStage(targetStage)
      : getTestStatusCommand(testStatus);
    lines.push(
      `Assignments through \`${testStatus.passingThrough}\` pass.`,
      `Make \`${reportTarget}\` fully pass before returning, without regressing previous assignments.`,
    );
    if (testStatus.regressions.length > 0 && testStatus.failingStage !== targetStage) {
      lines.push(`The first blocking regression is in \`${testStatus.failingStage}\`.`);
    }
  } else if (testStatus.failingStage) {
    const reportTarget = buildTestCommandForStage(testStatus.failingStage);
    lines.push(`Make \`${reportTarget}\` fully pass before returning and continue toward the full suite.`);
  } else {
    lines.push(
      `Fix the current \`${getTestStatusCommand(testStatus)}\` failure.`,
      `Latest exit code: ${testStatus.exitCode}`,
    );
  }

  const firstBlockerLine = formatFirstBlockerLine(testStatus);
  if (firstBlockerLine) {
    lines.push(firstBlockerLine);
  }

  return lines;
}

function getTestStatusCommand(testStatus) {
  return testStatus?.command ?? getPrimaryCheck().command;
}

function buildTestCommandForStage(stageName) {
  return buildCheckCommandForStage(getPrimaryCheck(), stageName);
}

function buildCheckCommandForStage(check, stageName) {
  const normalizedStage = normalizeStageName(stageName);
  if (normalizedStage && hasTestCommandStagePlaceholder(check.command)) {
    return renderTestCommandTemplate(check.command, normalizedStage);
  }
  return check.command;
}

function buildTestCommandContext(state) {
  return buildCheckCommandContext(getPrimaryCheck(), resolveActiveTestStage(state));
}

function buildCheckCommandContext(check, activeStage) {
  const usesStageTemplate = hasTestCommandStagePlaceholder(check.command);
  const stage = usesStageTemplate ? normalizeStageName(activeStage) : null;
  return {
    checkName: check.name,
    template: check.command,
    command: usesStageTemplate
      ? renderTestCommandTemplate(check.command, stage)
      : check.command,
    stage,
    usesStageTemplate,
  };
}

function getPrimaryCheck() {
  return CONFIG.checks.find((check) => check.primary) ?? CONFIG.checks[0];
}

function getCheckByName(name) {
  const check = CONFIG.checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`Unknown check ${name}`);
  }
  return check;
}

function hasTestCommandStagePlaceholder(command) {
  return /\bpaX\b/.test(command) ||
    /\{\{\s*(?:stage|pa|paStage|testStage|failingStage)\s*\}\}/.test(command) ||
    /\{\{\s*stageNumber\s*\}\}/.test(command) ||
    /\{(?:stage|pa|paStage|testStage|failingStage)\}/.test(command);
}

function renderTestCommandTemplate(command, stageName) {
  const normalizedStage = normalizeStageName(stageName);
  if (!normalizedStage) {
    throw new Error(`Cannot render test command template without a pa stage: ${command}`);
  }

  const stageNumberText = normalizedStage.slice(2);
  return command
    .replace(/\bpaX\b/g, normalizedStage)
    .replace(/\{\{\s*(?:stage|pa|paStage|testStage|failingStage)\s*\}\}/g, normalizedStage)
    .replace(/\{\{\s*stageNumber\s*\}\}/g, stageNumberText)
    .replace(/\{(?:stage|pa|paStage|testStage|failingStage)\}/g, normalizedStage);
}

function resolveActiveTestStage(state) {
  const savedStage = normalizeStageName(state?.activeStage);
  if (savedStage) {
    return savedStage;
  }
  const failingStage = normalizeStageName(state?.lastTestStatus?.failingStage);
  if (failingStage) {
    return failingStage;
  }
  const lastPassingStage = normalizeStageName(state?.lastTestStatus?.passingThrough);
  if (state?.lastExitCode === 0 && lastPassingStage && !getNextStageName(lastPassingStage)) {
    return lastPassingStage;
  }
  const nextStage = getNextStageName(state?.lastTestStatus?.passingThrough);
  if (nextStage) {
    return nextStage;
  }
  return getFirstStageName();
}

function resolveActivePhase(state) {
  const savedPhase = CONFIG.phases.find((phase) => phase.name === state?.activePhase);
  return savedPhase ?? CONFIG.phases[0];
}

function getNextPhase(phase) {
  const index = CONFIG.phases.findIndex((candidate) => candidate.name === phase?.name);
  return index >= 0 && index + 1 < CONFIG.phases.length
    ? CONFIG.phases[index + 1]
    : null;
}

function shouldRunPhaseTurn({ phase, phaseStatus, gitStatus, state }) {
  return phase.runWhenChecksPass &&
    phaseStatus.allRequiredPassed &&
    gitStatus.clean &&
    state.phaseAttempted !== true;
}

function getNextStageAfterPassingCommand(testStatus, gitStatus) {
  if (!testStatus?.usesStageTemplate || testStatus.exitCode !== 0 || !gitStatus.clean) {
    return null;
  }
  const completedStage =
    normalizeStageName(testStatus.passingThrough) ?? normalizeStageName(testStatus.targetStage);
  return getNextStageName(completedStage);
}

function getNextStageAfterCompletedPhase(testStatus) {
  if (!testStatus?.usesStageTemplate || testStatus.exitCode !== 0) {
    return null;
  }
  const completedStage =
    normalizeStageName(testStatus.passingThrough) ?? normalizeStageName(testStatus.targetStage);
  return getNextStageName(completedStage);
}

function getStateActiveStageAfterTest(testStatus) {
  if (!testStatus?.usesStageTemplate) {
    return null;
  }
  return (
    normalizeStageName(testStatus.targetStage) ??
    normalizeStageName(testStatus.failingStage) ??
    getNextStageName(testStatus.passingThrough)
  );
}

function getObjectiveTargetStage(testStatus) {
  return (
    normalizeStageName(testStatus?.targetStage) ??
    normalizeStageName(testStatus?.failingStage) ??
    getNextStageName(testStatus?.passingThrough)
  );
}

function getFirstStageName() {
  return TEST_STAGE_NAMES[0] ?? "pa1";
}

function getNextStageName(stageName) {
  const normalizedStage = normalizeStageName(stageName);
  if (!normalizedStage || TEST_STAGE_NAMES.length === 0) {
    return null;
  }
  const index = TEST_STAGE_NAMES.indexOf(normalizedStage);
  return index >= 0 && index + 1 < TEST_STAGE_NAMES.length
    ? TEST_STAGE_NAMES[index + 1]
    : null;
}

function normalizeStageName(stageName) {
  return typeof stageName === "string" && /^pa\d+$/.test(stageName) ? stageName : null;
}

function truncateGoalObjective(objective) {
  const maxChars = 4000;
  const chars = Array.from(objective.trim());
  if (chars.length <= maxChars) {
    return objective.trim();
  }
  return `${chars.slice(0, maxChars - 80).join("")}\n[goal objective truncated by Ralph]`;
}

function buildAppServerThreadStartParams() {
  const config = {
    features: { goals: true },
  };

  if (CONFIG.reasoningEffort) {
    config.model_reasoning_effort = CONFIG.reasoningEffort;
  }
  if (CONFIG.networkAccessEnabled != null) {
    config.sandbox_workspace_write = { network_access: CONFIG.networkAccessEnabled };
  }
  if (CONFIG.webSearchEnabled != null) {
    config.web_search = CONFIG.webSearchEnabled ? "live" : "disabled";
  }

  return {
    ...(CONFIG.model ? { model: CONFIG.model } : {}),
    cwd: CONFIG.workdir,
    approvalPolicy: CONFIG.approvalPolicy,
    sandbox: CONFIG.sandboxMode,
    config,
    serviceName: "ralph",
    threadSource: "user",
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };
}

function buildCodexOptions() {
  return {
    ...(CONFIG.codexPath ? { codexPathOverride: CONFIG.codexPath } : {}),
    ...(CONFIG.loopGoalsEnabled ? { config: { features: { goals: true } } } : {}),
  };
}

function createAgentBackend() {
  if (CONFIG.provider === "codex") {
    return new Codex(buildCodexOptions());
  }
  if (CONFIG.provider === "antigravity") {
    return new Antigravity(buildAntigravityOptions());
  }
  throw new Error(`Unsupported provider ${CONFIG.provider}`);
}

function buildAntigravityOptions() {
  return {
    pythonPath: CONFIG.antigravityPython,
    scriptPath: CONFIG.antigravityScriptPath,
    sdkPath: CONFIG.antigravitySdkPath,
    harnessPath: CONFIG.antigravityHarnessPath,
    saveDir: CONFIG.antigravitySaveDir,
    appDataDir: CONFIG.antigravityAppDataDir,
    skillsPaths: CONFIG.antigravitySkillsPaths,
    allowAll: CONFIG.antigravityAllowAll,
    structuredFinish: CONFIG.antigravityStructuredFinish,
    mockResponse: CONFIG.antigravityMockResponse,
    requestDelayMs: CONFIG.antigravityRequestDelayMs,
  };
}

class Codex {
  constructor(options = {}) {
    this.options = options;
    this.exec = new CodexExec({
      codexPath: options.codexPathOverride,
      configOverrides: options.config,
      env: options.env,
    });
  }

  startThread(options = {}) {
    return new CodexThread(this.exec, this.options, options);
  }

  resumeThread(id, options = {}) {
    return new CodexThread(this.exec, this.options, options, id);
  }
}

class CodexThread {
  constructor(exec, codexOptions, threadOptions, id = null) {
    this.exec = exec;
    this.codexOptions = codexOptions;
    this.threadOptions = threadOptions;
    this._id = id;
  }

  get id() {
    return this._id;
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }

  async *runStreamedInternal(input, turnOptions = {}) {
    const { prompt, images } = normalizeCodexInput(input);
    const events = this.exec.run({
      input: prompt,
      baseUrl: this.codexOptions.baseUrl,
      apiKey: this.codexOptions.apiKey,
      threadId: this._id,
      images,
      model: this.threadOptions.model,
      sandboxMode: this.threadOptions.sandboxMode,
      workingDirectory: this.threadOptions.workingDirectory,
      skipGitRepoCheck: this.threadOptions.skipGitRepoCheck,
      modelReasoningEffort: this.threadOptions.modelReasoningEffort,
      networkAccessEnabled: this.threadOptions.networkAccessEnabled,
      webSearchMode: this.threadOptions.webSearchMode,
      webSearchEnabled: this.threadOptions.webSearchEnabled,
      approvalPolicy: this.threadOptions.approvalPolicy,
      additionalDirectories: this.threadOptions.additionalDirectories,
      signal: turnOptions.signal,
    });

    for await (const line of events) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse Codex JSON event: ${line}`, { cause: error });
      }
      if (event.type === "thread.started") {
        this._id = event.thread_id;
      }
      yield event;
    }
  }
}

class CodexExec {
  constructor({ codexPath, configOverrides, env }) {
    this.codexPath = codexPath || "codex";
    this.configOverrides = configOverrides;
    this.envOverride = env;
  }

  async *run(args) {
    const commandArgs = ["exec", "--json"];
    appendSerializedConfigOverrides(commandArgs, this.configOverrides);
    if (args.baseUrl) {
      commandArgs.push("--config", `openai_base_url=${toTomlValue(args.baseUrl, "openai_base_url")}`);
    }
    if (args.model) {
      commandArgs.push("--model", args.model);
    }
    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }
    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }
    if (args.additionalDirectories?.length) {
      for (const directory of args.additionalDirectories) {
        commandArgs.push("--add-dir", directory);
      }
    }
    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }
    if (args.modelReasoningEffort) {
      commandArgs.push(
        "--config",
        `model_reasoning_effort=${toTomlValue(args.modelReasoningEffort, "model_reasoning_effort")}`,
      );
    }
    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${toTomlValue(
          args.networkAccessEnabled,
          "sandbox_workspace_write.network_access",
        )}`,
      );
    }
    if (args.webSearchMode) {
      commandArgs.push("--config", `web_search=${toTomlValue(args.webSearchMode, "web_search")}`);
    } else if (args.webSearchEnabled === true) {
      commandArgs.push("--config", `web_search=${toTomlValue("live", "web_search")}`);
    } else if (args.webSearchEnabled === false) {
      commandArgs.push("--config", `web_search=${toTomlValue("disabled", "web_search")}`);
    }
    if (args.approvalPolicy) {
      commandArgs.push(
        "--config",
        `approval_policy=${toTomlValue(args.approvalPolicy, "approval_policy")}`,
      );
    }
    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }
    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }

    const env = buildCodexExecEnv(this.envOverride, args.apiKey);
    const child = spawn(this.codexPath, commandArgs, {
      env,
      signal: args.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAtMs = Date.now();
    let expectedTaskCompleteTermination = false;
    const stopTaskCompleteWatcher = args.threadId
      ? watchCodexSessionTaskComplete(args.threadId, startedAtMs, () => {
          expectedTaskCompleteTermination = true;
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        })
      : null;
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("Codex exec did not expose stdio pipes");
    }

    const stderrChunks = [];
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 40) {
        stderrChunks.splice(0, stderrChunks.length - 40);
      }
    });

    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    child.stdin.write(args.input ?? "");
    child.stdin.end();

    try {
      for await (const line of rl) {
        if (line.trim()) {
          yield line;
        }
      }
      if (spawnError) {
        throw spawnError;
      }
      const { code, signal } = await exitPromise;
      if ((code !== 0 || signal) && !expectedTaskCompleteTermination) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Codex exec exited with ${detail}: ${Buffer.concat(stderrChunks).toString("utf8")}`);
      }
    } finally {
      stopTaskCompleteWatcher?.();
      rl.close();
      child.removeAllListeners();
      if (!child.killed) {
        child.kill();
      }
    }
  }
}

class Antigravity {
  constructor(options = {}) {
    this.options = options;
    this.exec = new AntigravityExec(options);
  }

  startThread(options = {}) {
    return new AntigravityThread(this.exec, this.options, options);
  }

  resumeThread(id, options = {}) {
    return new AntigravityThread(this.exec, this.options, options, id);
  }
}

class AntigravityThread {
  constructor(exec, antigravityOptions, threadOptions, id = null) {
    this.exec = exec;
    this.antigravityOptions = antigravityOptions;
    this.threadOptions = threadOptions;
    this._id = id;
  }

  get id() {
    return this._id;
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }

  async *runStreamedInternal(input, turnOptions = {}) {
    const { prompt } = normalizeCodexInput(input);
    const events = this.exec.run({
      input: prompt,
      threadId: this._id,
      model: this.threadOptions.model,
      workingDirectory: this.threadOptions.workingDirectory,
      additionalDirectories: this.threadOptions.additionalDirectories,
      signal: turnOptions.signal,
    });

    for await (const line of events) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse Antigravity JSON event: ${line}`, { cause: error });
      }
      if (event.type === "thread.started") {
        this._id = event.thread_id;
      }
      yield event;
    }
  }
}

class AntigravityExec {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || "python3";
    this.scriptPath = options.scriptPath || path.join(RALPH_DIR, "scripts", "antigravity-turn.py");
    this.options = options;
  }

  async *run(args) {
    const workspaces = [
      args.workingDirectory,
      ...(args.additionalDirectories ?? []),
    ].filter(Boolean);
    const config = {
      provider: "antigravity",
      conversationId: args.threadId,
      model: args.model,
      workdir: args.workingDirectory,
      workspaces,
      stateDir: CONFIG.stateDir,
      runName: CONFIG.runName,
      goalPath: getPortableGoalPath(),
      goalProgressPath: path.join(CONFIG.stateDir, "goal-progress.jsonl"),
      saveDir: this.options.saveDir,
      appDataDir: this.options.appDataDir,
      skillsPaths: this.options.skillsPaths ?? [],
      allowAll: this.options.allowAll !== false,
      structuredFinish: this.options.structuredFinish !== false,
      sdkPath: this.options.sdkPath,
      harnessPath: this.options.harnessPath,
      mockResponse: this.options.mockResponse,
      requestDelayMs: this.options.requestDelayMs,
    };

    const env = buildAntigravityExecEnv(this.options, config);
    const child = spawn(this.pythonPath, [this.scriptPath], {
      cwd: args.workingDirectory || process.cwd(),
      env,
      signal: args.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("Antigravity bridge did not expose stdio pipes");
    }

    const stderrChunks = [];
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 40) {
        stderrChunks.splice(0, stderrChunks.length - 40);
      }
    });

    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    child.stdin.write(args.input ?? "");
    child.stdin.end();

    try {
      for await (const line of rl) {
        if (line.trim()) {
          yield line;
        }
      }
      if (spawnError) {
        throw spawnError;
      }
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Antigravity bridge exited with ${detail}: ${Buffer.concat(stderrChunks).toString("utf8")}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      if (!child.killed) {
        child.kill();
      }
    }
  }
}

function buildAntigravityExecEnv(options, config) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.RALPH_ANTIGRAVITY_CONFIG_JSON = JSON.stringify(config);
  if (options.sdkPath) {
    env.PYTHONPATH = env.PYTHONPATH ? `${options.sdkPath}:${env.PYTHONPATH}` : options.sdkPath;
  }
  if (options.harnessPath) {
    env.ANTIGRAVITY_HARNESS_PATH = options.harnessPath;
  }
  return env;
}

function watchCodexSessionTaskComplete(threadId, startedAtMs, onComplete) {
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      if (await hasCodexSessionTaskComplete(threadId, startedAtMs)) {
        stopped = true;
        clearInterval(timer);
        onComplete();
      }
    } catch (_) {
      // Session files are best-effort; stdout remains the primary stream.
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(poll, 1000);
  timer.unref?.();
  poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function hasCodexSessionTaskComplete(threadId, startedAtMs) {
  const files = await findCodexSessionFiles(threadId);
  let latestLifecycleEvent = null;
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
      const eventType = record?.payload?.type;
      if (
        record?.type !== "event_msg" ||
        (eventType !== "task_complete" && eventType !== "task_started")
      ) {
        continue;
      }
      const timestampMs = Date.parse(record.timestamp ?? "");
      if (!Number.isFinite(timestampMs) || timestampMs >= startedAtMs - 5000) {
        latestLifecycleEvent = {
          type: eventType,
          timestampMs,
        };
      }
    }
  }

  if (latestLifecycleEvent?.type !== "task_complete") {
    return false;
  }
  if (
    Number.isFinite(latestLifecycleEvent.timestampMs) &&
    Date.now() - latestLifecycleEvent.timestampMs < CODEX_TASK_COMPLETE_SETTLE_MS
  ) {
    return false;
  }
  return true;
}

async function findCodexSessionFiles(threadId) {
  const sessionsDir = path.join(CODEX_DIR, "sessions");
  const matches = [];
  await walkCodexSessionFiles(sessionsDir, matches, threadId, 0);
  return matches.sort();
}

async function walkCodexSessionFiles(directory, matches, threadId, depth) {
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
      await walkCodexSessionFiles(entryPath, matches, threadId, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
      matches.push(entryPath);
    }
  }
}

function normalizeCodexInput(input) {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }

  const promptParts = [];
  const images = [];
  for (const item of input ?? []) {
    if (item?.type === "text") {
      promptParts.push(item.text ?? "");
    } else if (item?.type === "local_image") {
      images.push(item.path);
    }
  }
  return { prompt: promptParts.join("\n\n"), images };
}

function buildCodexExecEnv(envOverride, apiKey) {
  const env = {};
  if (envOverride) {
    Object.assign(env, envOverride);
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "ralph";
  }
  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }
  return env;
}

function appendSerializedConfigOverrides(args, configOverrides) {
  for (const override of serializeConfigOverrides(configOverrides)) {
    args.push("--config", override);
  }
}

function serializeConfigOverrides(configOverrides) {
  const overrides = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}

function flattenConfigOverrides(value, prefix, overrides) {
  if (!isPlainObject(value)) {
    if (!prefix) {
      return;
    }
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, pathKey, overrides);
    } else {
      overrides.push(`${pathKey}=${toTomlValue(child, pathKey)}`);
    }
  }
}

function toTomlValue(value, valuePath) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${valuePath}[${index}]`)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child, `${valuePath}.${key}`)}`)
      .join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${valuePath}`);
}

function formatTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withCodexAppServer(callback) {
  const client = new CodexAppServerClient({
    codexPath: CONFIG.codexPath,
  });
  try {
    await client.initialize();
    return await callback(client);
  } finally {
    await client.close();
  }
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

    log(`${formatProviderLabel(CONFIG.provider)} event: ${summarizeEvent(event)}`);
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
  const provider = normalizeProvider(process.env.RALPH_PROVIDER ?? fileConfig.provider ?? DEFAULT_CONFIG.provider);
  const model =
    process.env.RALPH_MODEL ??
    fileConfig.model ??
    (provider === "antigravity" ? DEFAULT_CONFIG.antigravityDefaultModel : DEFAULT_CONFIG.model);
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
  const explicitWorkdir = process.env.RALPH_WORKDIR ?? fileConfig.workdir;
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
  const stateDir = explicitStateDir
    ? path.resolve(process.cwd(), explicitStateDir)
    : path.join(stateBaseDir, runName);

  const configuredTestCommand =
    process.env.RALPH_TEST_COMMAND ?? fileConfig.testCommand ?? DEFAULT_CONFIG.testCommand;
  const checks = normalizeCheckConfig(fileConfig.checks, configuredTestCommand);
  const phases = normalizePhaseConfig(fileConfig.phases, checks);
  const primaryCheck = checks.find((check) => check.primary) ?? checks[0];
  const antigravityScriptPath = path.resolve(
    process.cwd(),
    process.env.RALPH_ANTIGRAVITY_SCRIPT_PATH ??
      fileConfig.antigravityScriptPath ??
      DEFAULT_CONFIG.antigravityScriptPath,
  );

  return {
    provider,
    baseDir,
    name,
    runName,
    workdir: explicitWorkdir
      ? path.resolve(process.cwd(), explicitWorkdir)
      : path.join(baseDir, runName),
    testCommand: primaryCheck?.command ?? configuredTestCommand,
    checks,
    phases,
    maxTurns: parsePositiveInt(
      process.env.RALPH_MAX_TURNS ?? fileConfig.maxTurns,
      DEFAULT_CONFIG.maxTurns,
    ),
    stateBaseDir,
    stateDir,
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
    codexPath: process.env.RALPH_CODEX_PATH ?? fileConfig.codexPath ?? DEFAULT_CONFIG.codexPath,
    antigravityPython:
      process.env.RALPH_ANTIGRAVITY_PYTHON ??
      fileConfig.antigravityPython ??
      DEFAULT_CONFIG.antigravityPython,
    antigravityScriptPath,
    antigravitySdkPath: resolveOptionalPath(
      process.env.RALPH_ANTIGRAVITY_SDK_PATH ?? fileConfig.antigravitySdkPath ?? DEFAULT_CONFIG.antigravitySdkPath,
    ),
    antigravityHarnessPath: resolveOptionalPath(
      process.env.RALPH_ANTIGRAVITY_HARNESS_PATH ??
        fileConfig.antigravityHarnessPath ??
        DEFAULT_CONFIG.antigravityHarnessPath,
    ),
    antigravitySaveDir: resolveOptionalPath(
      process.env.RALPH_ANTIGRAVITY_SAVE_DIR ??
        fileConfig.antigravitySaveDir ??
        path.join(stateDir, "antigravity-save"),
    ),
    antigravityAppDataDir: resolveOptionalPath(
      process.env.RALPH_ANTIGRAVITY_APP_DATA_DIR ??
        fileConfig.antigravityAppDataDir ??
        path.join(stateDir, "antigravity-app-data"),
    ),
    antigravitySkillsPaths: parsePathList(
      process.env.RALPH_ANTIGRAVITY_SKILLS_PATHS ?? fileConfig.antigravitySkillsPaths,
    ),
    antigravityAllowAll: parseBoolean(
      process.env.RALPH_ANTIGRAVITY_ALLOW_ALL ?? fileConfig.antigravityAllowAll,
      DEFAULT_CONFIG.antigravityAllowAll,
    ),
    antigravityStructuredFinish: parseBoolean(
      process.env.RALPH_ANTIGRAVITY_STRUCTURED_FINISH ?? fileConfig.antigravityStructuredFinish,
      DEFAULT_CONFIG.antigravityStructuredFinish,
    ),
    antigravityMockResponse:
      process.env.RALPH_ANTIGRAVITY_MOCK_RESPONSE ??
      fileConfig.antigravityMockResponse ??
      DEFAULT_CONFIG.antigravityMockResponse,
    antigravityRequestDelayMs: parseNonNegativeInt(
      process.env.RALPH_ANTIGRAVITY_REQUEST_DELAY_MS ?? fileConfig.antigravityRequestDelayMs,
      DEFAULT_CONFIG.antigravityRequestDelayMs,
    ),
    loopGoalsEnabled: parseBoolean(
      process.env.RALPH_LOOP_GOALS ?? fileConfig.loopGoalsEnabled,
      DEFAULT_CONFIG.loopGoalsEnabled,
    ),
    goalTokenBudget: parseOptionalPositiveInt(
      process.env.RALPH_GOAL_TOKEN_BUDGET ?? fileConfig.goalTokenBudget,
      DEFAULT_CONFIG.goalTokenBudget,
    ),
    useExistingWorkdir: parseBoolean(
      process.env.RALPH_USE_EXISTING_WORKDIR ?? fileConfig.useExistingWorkdir,
      DEFAULT_CONFIG.useExistingWorkdir,
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

async function loadPromptPartials() {
  const partials = {};
  const sidecarBasePath = buildSidecarTemplateBasePath(CONFIG_PATH);

  for (const [kind, definition] of Object.entries(PARTIAL_TEMPLATE_KINDS)) {
    const candidates = [
      `${sidecarBasePath}.${definition.fileSuffix}.md`,
      path.join(DEFAULT_TEMPLATE_DIR, definition.defaultFileName),
    ];
    const loaded = await readFirstExistingFile(candidates);
    if (loaded) {
      partials[kind] = loaded;
    }
  }

  partials.phasePrompts = {};
  partials.phaseGoals = {};
  for (const phase of CONFIG.phases ?? []) {
    if (phase.promptTemplate) {
      const loaded = await readFirstExistingFile([
        `${sidecarBasePath}.${phase.promptTemplate}.md`,
        ...(phase.promptTemplate === "default" ? [] : [`${sidecarBasePath}.default.md`]),
        path.join(DEFAULT_TEMPLATE_DIR, "default.md"),
      ]);
      if (loaded) {
        partials.phasePrompts[phase.name] = loaded;
      }
    }
    if (phase.goalTemplate) {
      const loaded = await readFirstExistingFile([
        `${sidecarBasePath}.${phase.goalTemplate}.md`,
        path.join(DEFAULT_TEMPLATE_DIR, `${phase.goalTemplate}.md`),
      ]);
      if (loaded) {
        partials.phaseGoals[phase.name] = loaded;
      }
    }
  }

  return partials;
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

async function readFirstExistingFile(filePaths) {
  for (const filePath of filePaths) {
    try {
      return {
        path: filePath,
        content: await fs.readFile(filePath, "utf8"),
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return null;
}

class CodexAppServerClient {
  constructor({ codexPath }) {
    this.codexPath = codexPath || "codex";
    this.child = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stderrChunks = [];
    this.closing = false;
  }

  async initialize() {
    this.start();
    await this.request("initialize", {
      clientInfo: {
        name: "ralph",
        title: "Ralph Runner",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  start() {
    if (this.child) {
      return;
    }

    const child = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(chunk.toString());
      if (this.stderrChunks.length > 40) {
        this.stderrChunks.splice(0, this.stderrChunks.length - 40);
      }
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      if (!this.closing) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        this.rejectAll(new Error(`codex app-server exited with ${detail}: ${this.stderrTail()}`));
      }
    });

    this.readline = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.readLoop();
  }

  readLoop() {
    (async () => {
      for await (const line of this.readline) {
        if (!line.trim()) {
          continue;
        }
        this.handleMessage(JSON.parse(line));
      }
    })().catch((error) => this.rejectAll(error));
  }

  handleMessage(message) {
    if (!message || typeof message !== "object" || message.id == null) {
      return;
    }

    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    this.pending.delete(key);

    if (message.error) {
      pending.reject(new Error(formatJsonRpcError(pending.method, message.error)));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  request(method, params = {}) {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = String(id);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out waiting for codex app-server`));
      }, 60000);
      this.pending.set(key, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    try {
      this.writeMessage({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      pending?.reject(error);
    }

    return promise;
  }

  notify(method, params = {}) {
    this.writeMessage({ method, params });
  }

  writeMessage(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error(`codex app-server stdin is not writable: ${this.stderrTail()}`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    const child = this.child;
    if (!child) {
      return;
    }

    this.closing = true;
    this.child = null;
    this.readline?.close();
    if (child.stdin?.writable) {
      child.stdin.end();
    }
    child.kill();

    await new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve();
        return;
      }
      const timeout = setTimeout(resolve, 1000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  rejectAll(error) {
    for (const [key, pending] of this.pending.entries()) {
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  stderrTail() {
    return this.stderrChunks.join("").trim();
  }
}

function formatJsonRpcError(method, error) {
  if (!error || typeof error !== "object") {
    return `${method} failed: ${String(error)}`;
  }
  const code = error.code == null ? "unknown" : error.code;
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  return `${method} failed (${code}): ${message}`;
}

function summarizeEvent(event) {
  if (event.type === "thread.started") {
    return `thread.started ${event.thread_id}`;
  }
  if (event.type === "turn.started") {
    return "turn.started";
  }
  if (event.type === "turn.completed") {
    return `turn.completed ${formatUsage(event.usage ?? {})}`;
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

function buildRalphPhaseStatusEventRecord({ phaseStatus, threadId, turnNumber, action = "checked" }) {
  if (!phaseStatus) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId,
    turnNumber,
    eventType: "ralph.phase-status",
    event: {
      type: "ralph.phase-status",
      sender: "ralph",
      action,
      phaseStatus,
    },
  };
}

function buildRalphGoalEventRecord({ action, goal, threadId, turnNumber, testStatus = null }) {
  if (!goal) {
    return null;
  }

  return {
    recordedAt: new Date().toISOString(),
    threadId,
    turnNumber,
    eventType: "ralph.goal",
    event: {
      type: "ralph.goal",
      sender: "ralph",
      action,
      goal,
      ...(testStatus ? { testStatus } : {}),
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
  const input = usage.input_tokens ?? usage.promptTokenCount ?? usage.prompt_token_count ?? 0;
  const output = usage.output_tokens ?? usage.candidatesTokenCount ?? usage.candidates_token_count ?? 0;
  const reasoning = usage.reasoning_output_tokens ?? usage.thoughtsTokenCount ?? usage.thoughts_token_count ?? 0;
  const total = usage.total_tokens ?? usage.totalTokenCount ?? usage.total_token_count ?? input + output + reasoning;
  const cached = usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? usage.cached_content_token_count ?? 0;
  return [
    `total=${total}`,
    `input=${input}`,
    `output=${output}`,
    `cached=${cached}`,
    ...(reasoning ? [`reasoning=${reasoning}`] : []),
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

async function loadStageCountHints(state) {
  const hints = new Map();
  addStageCountHintsFromTestStatus(hints, state?.lastTestStatus);

  let files = [];
  try {
    files = await fs.readdir(EVENTS_DIR_PATH, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return hints;
    }
    throw error;
  }

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(EVENTS_DIR_PATH, file.name);
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      for (const testStatus of extractTestStatusesFromEventRecord(record)) {
        addStageCountHintsFromTestStatus(hints, testStatus);
      }
    }
  }

  return hints;
}

function extractTestStatusesFromEventRecord(record) {
  const event = record?.event;
  const statuses = [];
  if (event?.testStatus) {
    statuses.push(event.testStatus);
  }
  if (event?.phaseStatus?.testStatus) {
    statuses.push(event.phaseStatus.testStatus);
  }
  for (const check of event?.phaseStatus?.checks ?? []) {
    if (check?.testStatus) {
      statuses.push(check.testStatus);
    }
  }
  return statuses;
}

function addStageCountHintsFromTestStatus(hints, testStatus) {
  for (const stage of testStatus?.stages ?? []) {
    if (stage?.status !== "pass" || !hasStageCounts(stage) || stage.passed !== stage.total) {
      continue;
    }
    const previous = hints.get(stage.name);
    if (!previous || stage.total > previous.total) {
      hints.set(stage.name, {
        name: stage.name,
        status: "pass",
        passed: stage.total,
        total: stage.total,
      });
    }
  }
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
      activeStage: normalizeStageName(parsed.activeStage),
      activePhase: typeof parsed.activePhase === "string" ? parsed.activePhase : null,
      phaseAttempted: parsed.phaseAttempted === true,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        threadId: null,
        eventLogPath: null,
        turnsCompleted: 0,
        lastExitCode: null,
        lastTestStatus: null,
        activeStage: null,
        activePhase: null,
        phaseAttempted: false,
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

async function discoverStageNames(workdir) {
  const entries = await fs.readdir(workdir, { withFileTypes: true });
  const stages = entries
    .filter((entry) => entry.isDirectory() && /^pa\d+$/.test(entry.name))
    .map((entry) => entry.name);
  const experimentalStages = await readExperimentalStageNames(workdir);
  return stages
    .filter((stage) => !experimentalStages.has(stage))
    .sort(compareStageNames);
}

async function readExperimentalStageNames(workdir) {
  try {
    const makefile = await fs.readFile(path.join(workdir, "Makefile"), "utf8");
    const match = makefile.match(/^EXPERIMENTAL_PAS\s*\?=\s*(.+)$/m);
    if (!match) {
      return new Set();
    }
    return new Set(match[1].split(/\s+/).map((entry) => entry.trim()).filter(Boolean));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

function compareStageNames(left, right) {
  return Number.parseInt(left.slice(2), 10) - Number.parseInt(right.slice(2), 10);
}

function buildRunName({ name, model, reasoningEffort }) {
  const parts = [
    sanitizeRunNamePart(name, "name"),
    sanitizeRunNamePart(model, "model"),
    sanitizeRunNamePart(reasoningEffort, "reasoningEffort"),
  ];
  return parts.join("-");
}

function generateProviderThreadId(provider) {
  return `${provider}-${randomUUID()}`;
}

function formatProviderLabel(provider) {
  if (provider === "codex") {
    return "Codex";
  }
  if (provider === "antigravity") {
    return "Antigravity";
  }
  return provider;
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

function normalizeCheckConfig(rawChecks, legacyTestCommand) {
  const checks = [];
  if (!rawChecks) {
    checks.push(normalizeCheckDefinition("tests", {
      command: legacyTestCommand,
      required: true,
      primary: true,
      kind: "test",
    }));
  } else if (Array.isArray(rawChecks)) {
    rawChecks.forEach((entry, index) => {
      const name = typeof entry === "string"
        ? entry
        : entry?.name ?? (index === 0 ? "tests" : `check${index + 1}`);
      const definition = typeof entry === "string" ? { command: entry } : entry;
      checks.push(normalizeCheckDefinition(name, definition));
    });
  } else if (typeof rawChecks === "object") {
    for (const [name, definition] of Object.entries(rawChecks)) {
      checks.push(normalizeCheckDefinition(name, definition));
    }
  } else {
    throw new Error("Config checks must be an object or array");
  }

  if (checks.length === 0) {
    throw new Error("Config checks must define at least one check");
  }

  let primaryIndex = checks.findIndex((check) => check.primary);
  if (primaryIndex < 0) {
    primaryIndex = checks.findIndex((check) => check.name === "tests");
  }
  if (primaryIndex < 0) {
    primaryIndex = 0;
  }
  return checks.map((check, index) => ({
    ...check,
    primary: index === primaryIndex,
    kind: check.kind ?? (index === primaryIndex ? "test" : "generic"),
  }));
}

function normalizeCheckDefinition(name, definition) {
  const value = typeof definition === "string" ? { command: definition } : definition;
  if (!value || typeof value !== "object") {
    throw new Error(`Config check ${name} must be an object or command string`);
  }
  const normalizedName = sanitizeIdentifier(name, "check name");
  const command = String(value.command ?? "").trim();
  if (!command) {
    throw new Error(`Config check ${normalizedName} must define a command`);
  }
  return {
    name: normalizedName,
    command,
    required: parseBoolean(value.required, true),
    primary: parseBoolean(value.primary, false),
    kind: typeof value.kind === "string" ? value.kind : null,
  };
}

function normalizePhaseConfig(rawPhases, checks) {
  if (!rawPhases) {
    const primary = checks.find((check) => check.primary) ?? checks[0];
    return [
      normalizePhaseDefinition({
        name: "default",
        promptTemplate: "default",
        checks: [primary.name],
      }, checks),
    ];
  }
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    throw new Error("Config phases must be a non-empty array");
  }
  return rawPhases.map((phase, index) =>
    normalizePhaseDefinition({
      name: phase?.name ?? `phase${index + 1}`,
      ...phase,
    }, checks),
  );
}

function normalizePhaseDefinition(phase, checks) {
  if (!phase || typeof phase !== "object") {
    throw new Error("Config phase must be an object");
  }
  const checkNames = new Set(checks.map((check) => check.name));
  const normalizedChecks = (Array.isArray(phase.checks) && phase.checks.length > 0
    ? phase.checks
    : checks.map((check) => check.name))
    .map((entry) => typeof entry === "string" ? entry : entry?.name)
    .filter(Boolean)
    .map((name) => sanitizeIdentifier(name, "phase check name"));
  for (const name of normalizedChecks) {
    if (!checkNames.has(name)) {
      throw new Error(`Config phase ${phase.name} references unknown check ${name}`);
    }
  }
  if (normalizedChecks.length === 0) {
    throw new Error(`Config phase ${phase.name} must include at least one check`);
  }
  const name = sanitizeIdentifier(phase.name, "phase name");
  return {
    name,
    promptTemplate: sanitizeOptionalTemplateName(phase.promptTemplate ?? name),
    goalTemplate: sanitizeOptionalTemplateName(phase.goalTemplate ?? `${name}-goal`),
    checks: normalizedChecks,
    runWhenChecksPass: parseBoolean(phase.runWhenChecksPass, false),
  };
}

function sanitizeIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`Config ${label} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return text;
}

function sanitizeOptionalTemplateName(value) {
  if (value == null || value === "") {
    return null;
  }
  return sanitizeIdentifier(value, "template name");
}

function normalizeProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "codex" || provider === "antigravity") {
    return provider;
  }
  throw new Error("Config provider must be `codex` or `antigravity`");
}

function resolveOptionalPath(value) {
  if (value == null || value === "") {
    return null;
  }
  return path.resolve(process.cwd(), String(value));
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

function parseOptionalPositiveInt(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  return parsePathList(value);
}

function parsePathList(value) {
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

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
