#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

const DEFAULT_RATES = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "claude-fable-5": { input: 10.0, cachedInput: 1.0, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, cachedInput: 0.5, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, cachedInput: 0.1, output: 5.0 },
};

const DEFAULTS = {
  left: "phases-gpt-5.5-xhigh",
  right: "trusted-gpt-5.5-xhigh",
  through: "pa22",
  ralphDir: path.join(os.homedir(), "work", ".ralph"),
  codexDir: path.join(os.homedir(), ".codex", "sessions"),
  format: "markdown",
};
const ACTIVE_EVENT_GAP_MS = 10 * 60 * 1000;

function usage() {
  return `Usage: node scripts/compare-pa-costs.js [options] [runSpec ...]

Compare per-PA implementation time and cost across Ralph runs. Pass any number
of run specs as positional arguments; the legacy --left/--right options remain
as aliases for the first two runs. Labels default to the run spec and pricing
models are inferred from the run name (e.g. "fable-claude-fable-5-xhigh" uses
claude-fable-5 rates). Claude runs price each turn with the provider-reported
cost recorded in the run log when available.

Options:
  --left <run>          First run shape, run id, event jsonl, or events dir
  --right <run>         Second run shape, run id, event jsonl, or events dir
  --left-label <text>   Label for the first run (default: run spec)
  --right-label <text>  Label for the second run (default: run spec)
  --left-model <model>  Pricing model for the first run (default: inferred)
  --right-model <model> Pricing model for the second run (default: inferred)
  --through <paN|N>     Last PA to include (default: pa22)
  --ralph-dir <path>    Ralph state dir (default: ~/work/.ralph)
  --codex-dir <path>    Codex sessions dir (default: ~/.codex/sessions)
  --format <md|json>    Output format (default: md)
  --help                Show this help

Run specs can be:
  phases-gpt-5.5-xhigh
  phases-gpt-5.5-xhigh/019e34a7-...
  /home/.../.ralph/phases-gpt-5.5-xhigh/events/run.jsonl
`;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const next = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return argv[i];
    };
    if (arg === "--left") options.left = next();
    else if (arg === "--right") options.right = next();
    else if (arg === "--left-label") options.leftLabel = next();
    else if (arg === "--right-label") options.rightLabel = next();
    else if (arg === "--left-model") options.leftModel = next();
    else if (arg === "--right-model") options.rightModel = next();
    else if (arg === "--through") options.through = next();
    else if (arg === "--ralph-dir") options.ralphDir = next();
    else if (arg === "--codex-dir") options.codexDir = next();
    else if (arg === "--format") options.format = next();
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  options.throughNumber = parseStageNumber(options.through);
  if (!options.throughNumber) {
    throw new Error(`invalid --through value: ${options.through}`);
  }

  const runConfigs = [];
  if (argv.includes("--left") || !positional.length) {
    runConfigs.push({ spec: options.left, label: options.leftLabel, model: options.leftModel });
  }
  if (argv.includes("--right") || !positional.length) {
    runConfigs.push({ spec: options.right, label: options.rightLabel, model: options.rightModel });
  }
  runConfigs.push(...positional.map((spec) => ({ spec })));
  options.runs = runConfigs.map((run) => ({
    spec: run.spec,
    label: run.label ?? run.spec,
    model: run.model ?? inferModelFromSpec(run.spec),
  }));
  return options;
}

function inferModelFromSpec(spec) {
  const text = String(spec ?? "").toLowerCase();
  return (
    Object.keys(DEFAULT_RATES)
      .sort((a, b) => b.length - a.length)
      .find((model) => text.includes(model)) ?? null
  );
}

function parseStageNumber(value) {
  const match = String(value ?? "").match(/^(?:pa)?(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function stageNumber(stage) {
  const match = String(stage ?? "").match(/^pa(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function resolveRunFile(spec, ralphDir) {
  const expanded = expandHome(spec);
  if (fs.existsSync(expanded)) {
    const stat = fs.statSync(expanded);
    if (stat.isFile()) {
      return expanded;
    }
    if (stat.isDirectory()) {
      return newestJsonl(expanded);
    }
  }

  const slash = spec.indexOf("/");
  if (slash !== -1) {
    const shape = spec.slice(0, slash);
    const fileBase = spec.slice(slash + 1);
    const candidate = path.join(ralphDir, shape, "events", `${fileBase}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const eventsDir = path.join(ralphDir, spec, "events");
  if (fs.existsSync(eventsDir)) {
    const runFile = path.join(eventsDir, "run.jsonl");
    if (fs.existsSync(runFile)) {
      return runFile;
    }
    return newestJsonl(eventsDir);
  }

  throw new Error(`could not resolve run spec: ${spec}`);
}

function readRunState(filePath) {
  const statePath = path.join(path.dirname(path.dirname(filePath)), "state.json");
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const activeStage = typeof state.activeStage === "string" ? state.activeStage : null;
    return {
      statePath,
      activeStage,
      activeStageNumber: stageNumber(activeStage),
      activePhase: typeof state.activePhase === "string" ? state.activePhase : null,
      activeSubset: typeof state.activeSubset === "string" ? state.activeSubset : null,
      turnsCompleted: Number.isInteger(state.turnsCompleted) ? state.turnsCompleted : null,
      phaseAttempted: state.phaseAttempted === true,
    };
  } catch (_) {
    return null;
  }
}

function newestJsonl(directory) {
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(directory, entry.name));
  if (!files.length) {
    throw new Error(`no .jsonl files under ${directory}`);
  }
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function compareCachePath(runFilePath) {
  const runDir = path.dirname(path.dirname(runFilePath));
  const fileBase = path.basename(runFilePath, ".jsonl");
  return path.join(runDir, "usage-cache", `compare-pa-costs-${fileBase}.json`);
}

function expandHome(filePath) {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    input_tokens: Math.max(0, usage.input_tokens ?? usage.promptTokenCount ?? 0),
    cached_input_tokens: Math.max(0, usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? 0),
    output_tokens: Math.max(
      0,
      usage.output_tokens ?? ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)),
    ),
    reasoning_output_tokens: Math.max(
      0,
      usage.reasoning_output_tokens ?? usage.thinking_output_tokens ?? usage.thoughtsTokenCount ?? 0,
    ),
    total_tokens: Math.max(0, usage.total_tokens ?? usage.totalTokenCount ?? 0),
    cost_usd: Math.max(0, Number(usage.cost_usd ?? usage.total_cost_usd) || 0),
  };
}

function hasUsage(usage) {
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
  };
}

function usageCounterReset(current, previous) {
  const a = normalizeUsage(current);
  const b = normalizeUsage(previous);
  if (!a || !b) {
    return false;
  }
  return (
    a.total_tokens < b.total_tokens ||
    a.input_tokens < b.input_tokens ||
    a.cached_input_tokens < b.cached_input_tokens ||
    a.output_tokens < b.output_tokens ||
    a.reasoning_output_tokens < b.reasoning_output_tokens
  );
}

function usageDelta(current, previous) {
  if (!previous || usageCounterReset(current, previous)) {
    return normalizeUsage(current);
  }
  return subtractUsage(current, previous);
}

function estimateCost(usage, model) {
  const normalized = normalizeUsage(usage) ?? emptyUsage();
  const rates = model ? DEFAULT_RATES[model] : null;
  if (!rates) {
    // No rate card: fall back to the provider-reported cost (Claude runs
    // record total_cost_usd per turn) or zero.
    return normalized.cost_usd ?? 0;
  }
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncached = Math.max(0, normalized.input_tokens - cached);
  const estimate =
    (uncached * rates.input +
      cached * rates.cachedInput +
      normalized.output_tokens * rates.output) /
    1_000_000;
  // Prefer provider-reported cost when present (covers thinking tokens and
  // cache-write premiums the rate estimate can't see).
  return normalized.cost_usd > estimate ? normalized.cost_usd : estimate;
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

function buildTurnMeta(events) {
  const attempts = buildRawTurnAttemptWindows(events);
  const byAttempt = new Map();
  const ensure = (attempt) => {
    const turn = attempt?.turnNumber;
    const key = attempt?.key ?? (Number.isInteger(turn) ? String(turn) : null);
    if (!key || !Number.isInteger(turn) || turn <= 0) {
      return null;
    }
    if (!byAttempt.has(key)) {
      byAttempt.set(key, {
        key,
        turn,
        attemptIndex: attempt?.attemptIndex ?? 0,
        startedAtMs: attempt?.startTime ?? null,
        stage: null,
        phase: null,
        subset: null,
        usage: emptyUsage(),
        durationMs: 0,
        sessionFirstMs: null,
        sessionLastMs: null,
        sessionActiveMs: 0,
        sessionLastActivityMs: null,
        hasTaskComplete: false,
        hasSessionActivity: false,
        hasUsageLimitedGoal: false,
        goalStatus: null,
        phaseStatusComplete: null,
        failedRequiredCheckCount: 0,
        goalTimeUsedMs: 0,
        tokenEvents: 0,
        eventFirstMs: null,
        eventLastMs: null,
        limitWaits: [],
      });
    }
    return byAttempt.get(key);
  };
  for (const attempt of attempts) {
    ensure(attempt);
  }
  const set = (event, fields) => {
    const turn = event.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      return;
    }
    const time = Date.parse(event.recordedAt ?? "");
    const target = ensure(rawTurnAttemptForTime(attempts, turn, time) ?? { turnNumber: turn, key: String(turn) });
    if (!target) {
      return;
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value != null && value !== "") {
        target[key] = value;
      }
    }
  };

  for (const event of events) {
    const turn = event.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    if (event.eventType === "ralph.phase-status") {
      const status = event.event?.phaseStatus ?? {};
      const fields = {
        stage: status.stage,
        phase: status.phase,
        subset: status.subset,
      };
      if (typeof status.allRequiredPassed === "boolean") {
        fields.phaseStatusComplete = status.allRequiredPassed;
        fields.failedRequiredCheckCount = Array.isArray(status.failedRequiredChecks)
          ? status.failedRequiredChecks.length
          : status.allRequiredPassed
            ? 0
            : 1;
      }
      set(event, fields);
    } else if (event.eventType === "ralph.prompt") {
      const prompt = String(event.event?.prompt ?? "");
      set(event, inferPromptTarget(prompt));
    } else if (event.eventType === "ralph.goal") {
      const objective = String(event.event?.goal?.objective ?? "");
      set(event, inferGoalTarget(objective));
    }
  }

  return byAttempt;
}

function inferPromptTarget(prompt) {
  const fields = {};
  const stage =
    prompt.match(/\b(?:for|target:)\s*`?(pa\d+)/i)?.[1] ??
    prompt.match(/^\s*(?:Plan|Implement|Fix architecture for|Fix file sizes for|Hand off)\s+`?(pa\d+)/i)?.[1] ??
    prompt.match(/`(pa\d+)\b/i)?.[1] ??
    null;
  if (stage) {
    fields.stage = stage;
  }

  const phase =
    prompt.match(/in the ([A-Za-z0-9._-]+) phase for `pa\d+`/i)?.[1] ??
    prompt.match(/^- phase:\s*`([^`]+)`/m)?.[1] ??
    null;
  if (phase) {
    fields.phase = phase;
  } else if (/^\s*Plan\s+`pa\d+/i.test(prompt)) {
    fields.phase = "plan";
  } else if (/^\s*Implement\s+`pa\d+/i.test(prompt)) {
    fields.phase = "implement";
  } else if (/^\s*Fix architecture for\s+`pa\d+/i.test(prompt)) {
    fields.phase = "archFix";
  } else if (/^\s*Fix file sizes for\s+`pa\d+/i.test(prompt)) {
    fields.phase = "fileSizeFix";
  } else if (/^\s*Hand off\s+`pa\d+/i.test(prompt)) {
    fields.phase = "handoff";
  }

  return fields;
}

function inferGoalTarget(objective) {
  const fields = {};
  const stage =
    objective.match(/\bfor\s+`?(pa\d+)/i)?.[1] ??
    objective.match(/`(pa\d+)\b/i)?.[1] ??
    null;
  if (stage) {
    fields.stage = stage;
  }

  const phase = objective.match(
    /\b(plan|planning|implementation|implement|audit|archFix|fileSizeFix|handoff|hand off)\b/i,
  )?.[1];
  if (phase) {
    const normalized = phase.toLowerCase();
    fields.phase =
      normalized === "planning"
        ? "plan"
        : normalized === "implementation"
          ? "implement"
          : normalized === "hand off"
            ? "handoff"
            : phase;
  }
  return fields;
}

function buildTurnResolver(events) {
  const starts = buildRawTurnAttemptWindows(events);

  return (timestamp) => {
    const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }
    let attempt = null;
    for (const start of starts) {
      if (start.startTime > time) {
        break;
      }
      attempt = start;
    }
    return attempt
      ? { turn: attempt.turnNumber, key: attempt.key }
      : null;
  };
}

function buildRawTurnAttemptWindows(events) {
  const starts = events
    .filter((event) => event.eventType === "ralph.phase-status" &&
      event.event?.action === "turn-start" &&
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

function rawTurnAttemptForTime(attempts, turnNumber, time) {
  if (!Number.isFinite(time)) {
    return null;
  }
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

function findSessionFiles(codexDir, threadIds) {
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
  if (depth > 6 || !fs.existsSync(directory)) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkCodexSessions(entryPath, visit, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      visit(entryPath);
    }
  }
}

async function readSessionUsageIntoTurns(filePath, byTurn, resolveTurn, options = {}) {
  let previousUsage = null;
  const stream = fs.createReadStream(filePath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const usageKeys = options.usageKeys instanceof Set ? options.usageKeys : null;

  for await (const line of lines) {
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
    const resolvedTurn = resolveTurn(record.timestamp);
    const turn = typeof resolvedTurn === "object" ? resolvedTurn?.turn : resolvedTurn;
    const key = typeof resolvedTurn === "object"
      ? resolvedTurn?.key
      : Number.isInteger(turn)
        ? String(turn)
        : null;
    const slot = key ? byTurn.get(key) : null;
    if (record.type !== "event_msg") {
      continue;
    }
    if (record.payload?.type === "token_count") {
      if (slot && Number.isFinite(time)) {
        recordSessionActivity(slot, time);
      }
      const current = normalizeUsage(record.payload?.info?.total_token_usage);
      if (!hasUsage(current)) {
        continue;
      }
      const delta = usageDelta(current, previousUsage);
      previousUsage = current;
      if (slot && hasUsage(delta) && (!usageKeys || usageKeys.has(slot.key))) {
        slot.usage = addUsage(slot.usage, delta);
        slot.tokenEvents += 1;
      }
    } else if (record.payload?.type === "task_complete") {
      if (slot && Number.isFinite(time)) {
        recordSessionActivity(slot, time);
      }
      const durationMs = Number(record.payload.duration_ms ?? 0);
      if (slot && Number.isFinite(durationMs) && durationMs > 0) {
        slot.durationMs += durationMs;
        slot.hasTaskComplete = true;
      }
    } else if (record.payload?.type === "thread_goal_updated") {
      const timeUsedSeconds = Number(record.payload.goal?.timeUsedSeconds ?? 0);
      if (slot && Number.isFinite(timeUsedSeconds) && timeUsedSeconds > 0) {
        slot.goalTimeUsedMs = Math.max(slot.goalTimeUsedMs, timeUsedSeconds * 1000);
      }
      const status = record.payload.goal?.status;
      if (slot && typeof status === "string" && status) {
        slot.goalStatus = status;
        if (status === "usageLimited") {
          slot.hasUsageLimitedGoal = true;
        }
      }
    }
  }
}

function recordSessionActivity(slot, time) {
  slot.hasSessionActivity = true;
  slot.sessionFirstMs = slot.sessionFirstMs == null ? time : Math.min(slot.sessionFirstMs, time);
  slot.sessionLastMs = slot.sessionLastMs == null ? time : Math.max(slot.sessionLastMs, time);
  if (slot.sessionLastActivityMs != null) {
    const gap = time - slot.sessionLastActivityMs;
    if (gap >= 0 && gap <= ACTIVE_EVENT_GAP_MS) {
      slot.sessionActiveMs += gap;
    }
  }
  slot.sessionLastActivityMs = time;
}

function fillDurationFallbacks(events, byTurn) {
  const starts = buildRawTurnAttemptWindows(events);

  for (let index = 0; index < starts.length; index += 1) {
    const slot = byTurn.get(starts[index].key);
    if (!slot) {
      continue;
    }
    let bestDurationMs = Number.isFinite(slot.durationMs) && slot.durationMs > 0
      ? slot.durationMs
      : 0;
    if (bestDurationMs <= 0 && slot.sessionActiveMs > 0) {
      bestDurationMs = slot.sessionActiveMs;
    }
    if (bestDurationMs <= 0 && slot.sessionFirstMs != null && slot.sessionLastMs != null) {
      bestDurationMs = Math.max(0, slot.sessionLastMs - slot.sessionFirstMs);
    }
    if (bestDurationMs <= 0 && slot.eventFirstMs != null && slot.eventLastMs != null) {
      bestDurationMs = Math.max(0, slot.eventLastMs - slot.eventFirstMs);
    }
    if (bestDurationMs <= 0 && slot.goalTimeUsedMs > 0) {
      bestDurationMs = slot.goalTimeUsedMs;
    }
    if (bestDurationMs > 0) {
      slot.durationMs = Math.max(0, bestDurationMs - limitWaitOverlapMs(slot));
      continue;
    }
    const nextTime = starts[index + 1]?.startTime;
    if (Number.isFinite(nextTime) && nextTime > starts[index].startTime) {
      slot.durationMs = Math.max(0, nextTime - starts[index].startTime - limitWaitOverlapMs(slot));
    }
  }
}

function readRunEventUsageIntoTurns(events, byTurn) {
  const attempts = buildRawTurnAttemptWindows(events);
  const slotFor = (record) => {
    const turn = record.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      return null;
    }
    const time = Date.parse(record.recordedAt ?? "");
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    return byTurn.get(attempt?.key ?? String(turn)) ?? null;
  };

  // Track each attempt's activity span from its own provider/prompt events.
  // This excludes downtime between attempts (crashes, --continue restarts)
  // while still counting in-process waits (e.g. quota-reset sleeps) that
  // happen between events of the same attempt.
  for (const record of events) {
    const type = String(record.eventType ?? "");
    const time = Date.parse(record.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    if (type === "claude.limit_wait") {
      // Quota-reset sleeps are recorded so they can be excluded from turn time.
      const slot = slotFor(record);
      const waitMs = Number(record.event?.wait_ms ?? 0);
      if (slot && Number.isFinite(waitMs) && waitMs > 0) {
        slot.limitWaits.push({ startMs: time, durationMs: waitMs });
      }
      continue;
    }
    if (
      !type.startsWith("item.") &&
      !type.startsWith("turn.") &&
      type !== "thread.started" &&
      type !== "codex.session.token_count" &&
      type !== "ralph.prompt"
    ) {
      continue;
    }
    const slot = slotFor(record);
    if (!slot) {
      continue;
    }
    slot.eventFirstMs = slot.eventFirstMs == null ? time : Math.min(slot.eventFirstMs, time);
    slot.eventLastMs = slot.eventLastMs == null ? time : Math.max(slot.eventLastMs, time);
  }

  // Live token_count records in the run log (Claude runs) carry cumulative
  // per-thread counters; convert to per-turn deltas.
  const previousByThread = new Map();
  const tokenTouched = new Set();
  for (const record of events) {
    if (record.eventType !== "codex.session.token_count" || !record.event?.usage) {
      continue;
    }
    const current = normalizeUsage(record.event.usage);
    if (!hasUsage(current)) {
      continue;
    }
    const threadId = eventThreadId(record) ?? "";
    const previous = previousByThread.get(threadId) ?? null;
    const delta = usageDelta(current, previous);
    previousByThread.set(threadId, current);
    const slot = slotFor(record);
    if (slot && hasUsage(delta)) {
      slot.usage = addUsage(slot.usage, delta);
      slot.tokenEvents += 1;
      tokenTouched.add(slot.key);
    }
  }

  // turn.completed records back-fill turns with no other usage source and
  // carry the provider-reported cost (Claude's total_cost_usd) for the turn.
  for (const record of events) {
    if (record.eventType !== "turn.completed" || !record.event?.usage) {
      continue;
    }
    const slot = slotFor(record);
    if (!slot) {
      continue;
    }
    const usage = normalizeUsage(record.event.usage);
    if (!tokenTouched.has(slot.key) && !hasUsage(slot.usage)) {
      slot.usage = addUsage(slot.usage, usage);
    } else if (usage.cost_usd > 0 && !(slot.usage.cost_usd > 0)) {
      slot.usage = { ...slot.usage, cost_usd: usage.cost_usd };
    }
  }
}

function includedMissingUsageKeys(byTurn, throughNumber) {
  const keys = new Set();
  for (const slot of byTurn.values()) {
    const number = stageNumber(slot.stage);
    if (!number || number < 1 || number > throughNumber) {
      continue;
    }
    if (!hasUsage(slot.usage)) {
      keys.add(slot.key);
    }
  }
  return keys;
}

function eventTypeCarriesActiveThread(eventType) {
  const type = String(eventType ?? "");
  return (
    type === "thread.started" ||
    type === "ralph.prompt" ||
    type === "ralph.goal" ||
    type === "codex.session.token_count" ||
    type.startsWith("item.") ||
    type.startsWith("turn.")
  );
}

function threadIdsForTurnKeys(events, byTurn, wantedKeys) {
  if (!(wantedKeys instanceof Set) || !wantedKeys.size) {
    return [];
  }
  const attempts = buildRawTurnAttemptWindows(events);
  const threadIds = new Set();
  for (const record of events) {
    if (!eventTypeCarriesActiveThread(record.eventType)) {
      continue;
    }
    const threadId = eventThreadId(record);
    if (!threadId) {
      continue;
    }
    const turn = record.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const time = Date.parse(record.recordedAt ?? "");
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    const key = attempt?.key ?? String(turn);
    if (wantedKeys.has(key) && byTurn.has(key)) {
      threadIds.add(threadId);
    }
  }
  return [...threadIds];
}

function sessionFileStats(sessionFiles) {
  const stats = [];
  for (const [threadId, files] of sessionFiles.entries()) {
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        stats.push({
          threadId,
          filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (_) {
        stats.push({
          threadId,
          filePath,
          missing: true,
        });
      }
    }
  }
  return stats.sort((a, b) =>
    a.threadId.localeCompare(b.threadId) ||
    a.filePath.localeCompare(b.filePath));
}

function sessionStatsCover(cached, requested) {
  if (!Array.isArray(cached) || !Array.isArray(requested) || cached.length < requested.length) {
    return false;
  }
  const cachedByKey = new Map(cached.map((entry) => [`${entry.threadId}\0${entry.filePath}`, entry]));
  for (const b of requested) {
    const a = cachedByKey.get(`${b.threadId}\0${b.filePath}`);
    if (
      !a ||
      a.threadId !== b.threadId ||
      a.filePath !== b.filePath ||
      a.size !== b.size ||
      a.missing !== b.missing ||
      Math.abs((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) > 1
    ) {
      return false;
    }
  }
  return true;
}

function cachedSlotMatches(slot, cached) {
  return (
    slot &&
    cached &&
    slot.turn === cached.turn &&
    slot.attemptIndex === cached.attemptIndex &&
    slot.startedAtMs === cached.startedAtMs &&
    slot.stage === cached.stage &&
    slot.phase === cached.phase
  );
}

function applySessionFallbackCache(cache, byTurn, missingUsageKeys, sessionStats, throughNumber) {
  if (
    !cache ||
    cache.version !== 1 ||
    !Number.isInteger(cache.throughNumber) ||
    cache.throughNumber < throughNumber ||
    !sessionStatsCover(cache.sessionFiles, sessionStats) ||
    !Array.isArray(cache.slots)
  ) {
    return false;
  }
  const slotsByKey = new Map(cache.slots.map((slot) => [slot.key, slot]));
  for (const key of missingUsageKeys) {
    const slot = byTurn.get(key);
    const cached = slotsByKey.get(key);
    if (!cachedSlotMatches(slot, cached)) {
      return false;
    }
  }
  for (const key of missingUsageKeys) {
    const slot = byTurn.get(key);
    const cached = slotsByKey.get(key);
    slot.usage = addUsage(slot.usage, cached.usage);
    slot.durationMs += Math.max(0, Number(cached.durationMs ?? 0));
    slot.sessionFirstMs = cached.sessionFirstMs ?? slot.sessionFirstMs;
    slot.sessionLastMs = cached.sessionLastMs ?? slot.sessionLastMs;
    slot.sessionActiveMs += Math.max(0, Number(cached.sessionActiveMs ?? 0));
    slot.sessionLastActivityMs = cached.sessionLastActivityMs ?? slot.sessionLastActivityMs;
    slot.hasTaskComplete = Boolean(slot.hasTaskComplete || cached.hasTaskComplete);
    slot.hasSessionActivity = Boolean(slot.hasSessionActivity || cached.hasSessionActivity);
    slot.hasUsageLimitedGoal = Boolean(slot.hasUsageLimitedGoal || cached.hasUsageLimitedGoal);
    slot.goalStatus = cached.goalStatus ?? slot.goalStatus;
    slot.goalTimeUsedMs = Math.max(slot.goalTimeUsedMs, Number(cached.goalTimeUsedMs ?? 0));
    slot.tokenEvents += Math.max(0, Number(cached.tokenEvents ?? 0));
  }
  return true;
}

function readSessionFallbackCache(cachePath, byTurn, missingUsageKeys, sessionStats, throughNumber) {
  if (!fs.existsSync(cachePath)) {
    return false;
  }
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return applySessionFallbackCache(cache, byTurn, missingUsageKeys, sessionStats, throughNumber);
  } catch (_) {
    return false;
  }
}

function writeSessionFallbackCache(cachePath, runFilePath, byTurn, usageKeys, sessionStats, throughNumber) {
  const slots = [...usageKeys]
    .map((key) => byTurn.get(key))
    .filter(Boolean)
    .map((slot) => ({
      key: slot.key,
      turn: slot.turn,
      attemptIndex: slot.attemptIndex,
      startedAtMs: slot.startedAtMs,
      stage: slot.stage,
      phase: slot.phase,
      usage: normalizeUsage(slot.usage) ?? emptyUsage(),
      durationMs: slot.durationMs,
      sessionFirstMs: slot.sessionFirstMs,
      sessionLastMs: slot.sessionLastMs,
      sessionActiveMs: slot.sessionActiveMs,
      sessionLastActivityMs: slot.sessionLastActivityMs,
      hasTaskComplete: slot.hasTaskComplete,
      hasSessionActivity: slot.hasSessionActivity,
      hasUsageLimitedGoal: slot.hasUsageLimitedGoal,
      goalStatus: slot.goalStatus,
      goalTimeUsedMs: slot.goalTimeUsedMs,
      tokenEvents: slot.tokenEvents,
    }));
  try {
    const runStat = fs.statSync(runFilePath);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      `${JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        throughNumber,
        runFile: {
          filePath: runFilePath,
          size: runStat.size,
          mtimeMs: runStat.mtimeMs,
        },
        sessionFiles: sessionStats,
        slots,
      })}\n`,
    );
  } catch (_) {
    // The cache is only an optimization; ignore failures.
  }
}

function applyRunGoalStatuses(events, byTurn) {
  const attempts = buildRawTurnAttemptWindows(events);
  for (const record of events) {
    if (record.eventType !== "ralph.goal") {
      continue;
    }
    const status = record.event?.goal?.status;
    if (typeof status !== "string" || !status) {
      continue;
    }
    const turn = record.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) {
      continue;
    }
    const time = Date.parse(record.recordedAt ?? "");
    const attempt = rawTurnAttemptForTime(attempts, turn, time);
    const slot = byTurn.get(attempt?.key ?? String(turn));
    if (!slot) {
      continue;
    }
    slot.goalStatus = status;
    if (status === "usageLimited") {
      slot.hasUsageLimitedGoal = true;
    } else if (status === "complete" || status === "blocked") {
      slot.hasUsageLimitedGoal = false;
    }
  }
}

function limitWaitOverlapMs(slot) {
  // Subtract only the portion of each quota wait that falls inside the
  // attempt's measured activity span, so a wait aborted by a kill (which the
  // span never covers) is not over-subtracted.
  if (!Array.isArray(slot.limitWaits) || !slot.limitWaits.length) {
    return 0;
  }
  const spanStart = slot.eventFirstMs;
  const spanEnd = slot.eventLastMs;
  if (spanStart == null || spanEnd == null) {
    return 0;
  }
  let waited = 0;
  for (const wait of slot.limitWaits) {
    const start = Math.max(wait.startMs, spanStart);
    const end = Math.min(wait.startMs + wait.durationMs, spanEnd);
    waited += Math.max(0, end - start);
  }
  return waited;
}

async function summarizeRun(run, options) {
  const spec = run.spec;
  const filePath = resolveRunFile(spec, options.ralphDir);
  const state = readRunState(filePath);
  const events = readJsonl(filePath);
  const byTurn = buildTurnMeta(events);
  const resolveTurn = buildTurnResolver(events);
  const threadIds = [...new Set(events.map(eventThreadId).filter(Boolean))];

  readRunEventUsageIntoTurns(events, byTurn);
  const missingUsageKeys = includedMissingUsageKeys(byTurn, options.throughNumber);
  if (missingUsageKeys.size) {
    const missingThreadIds = threadIdsForTurnKeys(events, byTurn, missingUsageKeys);
    const fallbackThreadIds = missingThreadIds.length ? missingThreadIds : threadIds;
    const sessionFiles = findSessionFiles(options.codexDir, fallbackThreadIds);
    const stats = sessionFileStats(sessionFiles);
    const cachePath = compareCachePath(filePath);
    const usedCache = readSessionFallbackCache(cachePath, byTurn, missingUsageKeys, stats, options.throughNumber);
    if (!usedCache) {
      for (const threadId of fallbackThreadIds) {
        for (const sessionFile of (sessionFiles.get(threadId) ?? []).sort()) {
          await readSessionUsageIntoTurns(sessionFile, byTurn, resolveTurn, { usageKeys: missingUsageKeys });
        }
      }
      writeSessionFallbackCache(cachePath, filePath, byTurn, missingUsageKeys, stats, options.throughNumber);
    }
  }
  applyRunGoalStatuses(events, byTurn);
  fillDurationFallbacks(events, byTurn);

  const model = run.model;
  const byPa = new Map();
  const turnInfos = [...byTurn.values()].sort((a, b) =>
    (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) ||
    a.turn - b.turn ||
    a.attemptIndex - b.attemptIndex);
  for (const turnInfo of turnInfos) {
    const number = stageNumber(turnInfo.stage);
    if (!number || number < 1 || number > options.throughNumber) {
      continue;
    }
    const pa = `pa${number}`;
    if (!byPa.has(pa)) {
      byPa.set(pa, {
        pa,
        turns: [],
        phases: new Map(),
        usage: emptyUsage(),
        durationMs: 0,
        cost: 0,
        activeTurns: 0,
        incompleteTurns: 0,
        usageLimitedTurns: 0,
      });
    }
    const row = byPa.get(pa);
    row.turns.push(turnInfo.key ?? String(turnInfo.turn));
    row.usage = addUsage(row.usage, turnInfo.usage);
    row.durationMs += turnInfo.durationMs;
    row.cost += estimateCost(turnInfo.usage, model);
    row.phases.set(turnInfo.phase ?? "unknown", (row.phases.get(turnInfo.phase ?? "unknown") ?? 0) + 1);
    if (turnInfo.hasSessionActivity && !turnInfo.hasTaskComplete) {
      row.activeTurns += 1;
    }
    if (turnInfo.hasUsageLimitedGoal) {
      row.usageLimitedTurns += 1;
    }
    if (isIncompleteTurn(turnInfo)) {
      row.incompleteTurns += 1;
    }
  }

  return {
    label: run.label,
    spec,
    filePath,
    state,
    model,
    byTurn,
    byPa,
  };
}

function isIncompleteTurn(turnInfo) {
  return (
    turnInfo.phaseStatusComplete === false ||
    turnInfo.hasUsageLimitedGoal ||
    (turnInfo.hasSessionActivity && !turnInfo.hasTaskComplete)
  );
}

function paSummary(run, pa) {
  const row = run.byPa.get(pa);
  if (!row) {
    return {
      pa,
      turns: [],
      durationMs: 0,
      cost: 0,
      usage: emptyUsage(),
      status: "not started",
      phases: "",
    };
  }
  const number = stageNumber(pa);
  const runAdvancedPastPa =
    Number.isInteger(number) &&
    Number.isInteger(run.state?.activeStageNumber) &&
    run.state.activeStageNumber > number;
  const activeInThisPa =
    Number.isInteger(number) &&
    run.state?.activeStageNumber === number &&
    Boolean(run.state?.activePhase);
  return {
    ...row,
    status: runAdvancedPastPa
      ? "complete"
      : activeInThisPa || row.incompleteTurns > 0
        ? "partial"
        : "complete",
    phases: [...row.phases.entries()].map(([phase, count]) => `${phase}:${count}`).join(","),
  };
}

function totalSummary(rows) {
  return rows.reduce(
    (total, row) => ({
      turns: total.turns + row.turns.length,
      durationMs: total.durationMs + row.durationMs,
      cost: total.cost + row.cost,
      usage: addUsage(total.usage, row.usage),
      activeTurns: total.activeTurns + (row.activeTurns ?? 0),
      incompleteTurns: total.incompleteTurns + (row.incompleteTurns ?? 0),
      partialRows: total.partialRows + (row.status === "partial" ? 1 : 0),
    }),
    { turns: 0, durationMs: 0, cost: 0, usage: emptyUsage(), activeTurns: 0, incompleteTurns: 0, partialRows: 0 },
  );
}

function hhhmmss(durationMs) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(3, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function money(amount) {
  return `$${amount.toFixed(2)}`;
}

function buildComparison(options, summaries) {
  const rows = [];
  for (let number = 1; number <= options.throughNumber; number += 1) {
    const pa = `pa${number}`;
    rows.push({
      pa,
      runs: summaries.map((run) => paSummary(run, pa)),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    through: `pa${options.throughNumber}`,
    rates: DEFAULT_RATES,
    runs: summaries.map((run, index) => ({
      label: run.label,
      model: run.model,
      spec: run.spec,
      filePath: run.filePath,
      total: totalSummary(rows.map((row) => row.runs[index])),
    })),
    rows,
  };
}

function renderMarkdown(comparison) {
  const lines = [];
  lines.push(`Compared through ${comparison.through}. Times are HHH:MM:SS.`);
  lines.push("");
  lines.push("| Run | Turns | Time | Cost | Status |");
  lines.push("|---|---:|---:|---:|---|");
  for (const run of comparison.runs) {
    lines.push(summaryRow(run));
  }
  lines.push("");
  const header = ["PA"];
  const separators = ["---"];
  for (const run of comparison.runs) {
    header.push(`${run.label} turns`, `${run.label} time`, `${run.label} cost`, `${run.label} status`);
    separators.push("---:", "---:", "---:", "---");
  }
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${separators.join("|")}|`);
  for (const row of comparison.rows) {
    const cells = [row.pa];
    for (const summary of row.runs) {
      cells.push(
        summary.turns.length,
        hhhmmss(summary.durationMs),
        money(summary.cost),
        summary.status,
      );
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    `Pricing: ${comparison.runs
      .map((run) => `${run.label}=${run.model ?? "provider-reported cost only"}`)
      .join(", ")}.`,
  );
  lines.push(`Run files: ${comparison.runs.map((run) => run.filePath).join("; ")}`);
  lines.push("Status `partial` means Ralph is currently in that PA, a required phase check is still failing, a Codex goal hit usage limits, or an included turn has session activity but no task_complete event yet.");
  return lines.join("\n");
}

function summaryRow(run) {
  const status = run.total.partialRows > 0 ? "partial" : "complete";
  return `| ${run.label} | ${run.total.turns} | ${hhhmmss(run.total.durationMs)} | ${money(run.total.cost)} | ${status} |`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summaries = await Promise.all(options.runs.map((run) => summarizeRun(run, options)));
  const comparison = buildComparison(options, summaries);
  const format = String(options.format).toLowerCase();
  if (format === "json") {
    console.log(JSON.stringify(comparison, null, 2));
  } else if (format === "md" || format === "markdown") {
    console.log(renderMarkdown(comparison));
  } else {
    throw new Error(`unsupported --format: ${options.format}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
