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
  workdir: "/work/cppgm",
  testCommand: "make test",
  maxTurns: 1000,
  stateDir: ".ralph",
  model: "gpt-5.3-codex",
  reasoningEffort: "high",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
  webSearchEnabled: false,
  additionalDirectories: [],
  outputTailChars: 20000,
};

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
  await assertDirectoryExists(CONFIG.workdir);
  log(
    `Config: model=${CONFIG.model} reasoning=${CONFIG.reasoningEffort} ` +
      `workdir=${CONFIG.workdir}`,
  );

  const state = await loadState();
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
    log(`Latest test output: ${previewText(testRun.output)}`);
    const gitStatus = await getGitStatus(CONFIG.workdir);
    if (!gitStatus.clean) {
      log(`Git status: ${previewText(gitStatus.output)}`);
    }

    if (testRun.exitCode === 0 && gitStatus.clean) {
      if (activeThreadId || state.threadId || state.turnsCompleted > 0) {
        await saveState({
          threadId: activeThreadId,
          eventLogPath: buildEventLogPath(activeThreadId),
          turnsCompleted: turnNumber,
          lastExitCode: 0,
          updatedAt: new Date().toISOString(),
        });
      }
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
        ? buildCleanWorktreePrompt(gitStatus)
        : turnNumber === 0 && !activeThreadId
          ? buildInitialPrompt(testRun, gitStatus)
          : buildContinuePrompt(testRun, gitStatus);

    log(`Ralph prompt: ${previewText(prompt)}`);
    const { events } = await thread.runStreamed(prompt);
    const turn = await collectStreamedTurn(events, {
      prompt,
      threadId: thread.id ?? activeThreadId,
      turnNumber: turnNumber + 1,
    });
    activeThreadId = thread.id ?? turn.threadId ?? activeThreadId;

    await saveState({
      threadId: activeThreadId,
      eventLogPath: buildEventLogPath(activeThreadId),
      turnsCompleted: turnNumber + 1,
      lastExitCode: testRun.exitCode,
      updatedAt: new Date().toISOString(),
    });

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

function buildInitialPrompt(testRun, gitStatus) {
  return DEFAULT_PROMPT;
}

function buildContinuePrompt(testRun, gitStatus) {
  const progress = analyzeTestProgress(testRun.output);
  const objectiveLines = buildContinueObjectiveLines(progress, testRun);
  const failureSummaryLines = buildFailureSummaryLines(progress, testRun);

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

function buildCleanWorktreePrompt(gitStatus) {
  return [
    "The tests now pass, but the worktree is not clean yet.",
    "Commit the intended changes now so `git status --short` is empty before handing control back.",
    "Do not discard intended work. Create the appropriate commit(s) and leave the repository clean.",
    "",
    ...buildGitStatusLines(gitStatus),
  ].join("\n");
}

function buildGitStatusLines(gitStatus) {
  return gitStatus.clean
    ? ["Current `git status --short`: empty"]
    : ["Current `git status --short`:", trimmedOutput(gitStatus.output)];
}

function buildContinueObjectiveLines(progress, testRun) {
  if (progress?.passingThrough && progress?.failingStage) {
    return [
      `Assignments through \`${progress.passingThrough}\` already pass.`,
      `Your task for this turn is to implement the code required to make \`make ${progress.failingStage}\` pass without causing regressions for previous assignments: \`make test-through-${progress.passingThrough}\``,
    ];
  }

  if (progress?.failingStage) {
    return [
      `\`make ${progress.failingStage}\` is still failing, continue work on stage until it passes.`,
    ];
  }

  return [
    `I reran \`${CONFIG.testCommand}\` from the repository root and it still fails.`,
    `Latest exit code: ${testRun.exitCode}`,
  ];
}

function buildFailureSummaryLines(progress, testRun) {
  const lines = [`Latest exit code: ${testRun.exitCode}`];

  if (progress?.firstFailureLine) {
    lines.push(`First reported blocker: ${progress.firstFailureLine}`);
  }

  lines.push(
    `Full test output is in \`${path.join(CONFIG.stateDir, "last-test.log")}\` if you need more detail.`,
    "After `make` passes for the current blocking assignment, keep going until the full suite passes.",
  );

  return lines;
}

function analyzeTestProgress(output) {
  const stagePattern = /^===== (pa\d+) =====$/gm;
  const stages = [...output.matchAll(stagePattern)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
    header: match[0],
  }));

  const firstFailureLine = output
    .split(/\r?\n/)
    .find((line) => /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match/.test(line));

  if (stages.length === 0) {
    return { firstFailureLine: firstFailureLine ?? null };
  }

  const stageBlocks = stages.map((stage, index) => {
    const start = stage.index;
    const end = index + 1 < stages.length ? stages[index + 1].index : output.length;
    return {
      name: stage.name,
      body: output.slice(start, end),
    };
  });

  const failingIndex = stageBlocks.findIndex((stage) => /\bFAIL\b|ERROR:/.test(stage.body));
  const failingStage = failingIndex >= 0 ? stageBlocks[failingIndex].name : null;
  const passingThrough = failingIndex > 0 ? stageBlocks[failingIndex - 1].name : null;

  return {
    failingStage,
    passingThrough,
    firstFailureLine: firstFailureLine ?? null,
  };
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
  const pendingEventRecords = [];

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

  return {
    workdir: path.resolve(
      process.cwd(),
      process.env.RALPH_WORKDIR ?? fileConfig.workdir ?? DEFAULT_CONFIG.workdir,
    ),
    testCommand:
      process.env.RALPH_TEST_COMMAND ?? fileConfig.testCommand ?? DEFAULT_CONFIG.testCommand,
    maxTurns: parsePositiveInt(
      process.env.RALPH_MAX_TURNS ?? fileConfig.maxTurns,
      DEFAULT_CONFIG.maxTurns,
    ),
    stateDir: path.resolve(
      process.cwd(),
      process.env.RALPH_STATE_DIR ?? fileConfig.stateDir ?? DEFAULT_CONFIG.stateDir,
    ),
    model: process.env.RALPH_MODEL ?? fileConfig.model ?? DEFAULT_CONFIG.model,
    reasoningEffort:
      process.env.RALPH_REASONING_EFFORT ??
      fileConfig.reasoningEffort ??
      DEFAULT_CONFIG.reasoningEffort,
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
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { threadId: null, eventLogPath: null, turnsCompleted: 0 };
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
