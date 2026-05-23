#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

const DEFAULT_RATES = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
};

const DEFAULTS = {
  left: "phases-gpt-5.5-xhigh",
  leftLabel: "phases",
  leftModel: "gpt-5.5",
  right: "spark-gpt-5.4-medium",
  rightLabel: "spark",
  rightModel: "gpt-5.4",
  through: "pa22",
  ralphDir: path.join(os.homedir(), "work", ".ralph"),
  codexDir: path.join(os.homedir(), ".codex", "sessions"),
  format: "markdown",
};

function usage() {
  return `Usage: node scripts/compare-pa-costs.js [options]

Compare per-PA implementation time and cost for two Ralph runs.

Options:
  --left <run>          Left run shape, run id, event jsonl, or events dir
  --right <run>         Right run shape, run id, event jsonl, or events dir
  --left-label <text>   Label for the left run (default: phases)
  --right-label <text>  Label for the right run (default: spark)
  --left-model <model>  Pricing model for the left run (default: gpt-5.5)
  --right-model <model> Pricing model for the right run (default: gpt-5.4)
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
    else throw new Error(`unknown option: ${arg}`);
  }
  options.throughNumber = parseStageNumber(options.through);
  if (!options.throughNumber) {
    throw new Error(`invalid --through value: ${options.through}`);
  }
  return options;
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
  const rates = DEFAULT_RATES[model];
  if (!rates) {
    throw new Error(`no pricing rates configured for model ${model}`);
  }
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncached = Math.max(0, normalized.input_tokens - cached);
  return (
    (uncached * rates.input +
      cached * rates.cachedInput +
      normalized.output_tokens * rates.output) /
    1_000_000
  );
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
  const byTurn = new Map();
  const ensure = (turn) => {
    if (!byTurn.has(turn)) {
      byTurn.set(turn, {
        turn,
        stage: null,
        phase: null,
        subset: null,
        usage: emptyUsage(),
        durationMs: 0,
        sessionFirstMs: null,
        sessionLastMs: null,
        hasTaskComplete: false,
        hasSessionActivity: false,
        goalTimeUsedMs: 0,
        tokenEvents: 0,
      });
    }
    return byTurn.get(turn);
  };
  const set = (turn, fields) => {
    if (!Number.isInteger(turn) || turn <= 0) {
      return;
    }
    const target = ensure(turn);
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
      set(turn, {
        stage: status.stage,
        phase: status.phase,
        subset: status.subset,
      });
    } else if (event.eventType === "ralph.prompt") {
      const prompt = String(event.event?.prompt ?? "");
      set(turn, inferPromptTarget(prompt));
    } else if (event.eventType === "ralph.goal") {
      const objective = String(event.event?.goal?.objective ?? "");
      set(turn, inferGoalTarget(objective));
    }
  }

  return byTurn;
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
  const starts = events
    .filter((event) => event.eventType === "ralph.prompt" && Number.isInteger(event.turnNumber))
    .map((event) => ({
      turn: event.turnNumber,
      time: Date.parse(event.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return (timestamp) => {
    const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }
    let turn = null;
    for (const start of starts) {
      if (start.time > time) {
        break;
      }
      turn = start.turn;
    }
    return turn;
  };
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

async function readSessionUsageIntoTurns(filePath, byTurn, resolveTurn) {
  let previousUsage = null;
  const stream = fs.createReadStream(filePath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

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
    const turn = resolveTurn(record.timestamp);
    const slot = Number.isInteger(turn) ? byTurn.get(turn) : null;
    if (slot && Number.isFinite(time)) {
      slot.hasSessionActivity = true;
      slot.sessionFirstMs = slot.sessionFirstMs == null ? time : Math.min(slot.sessionFirstMs, time);
      slot.sessionLastMs = slot.sessionLastMs == null ? time : Math.max(slot.sessionLastMs, time);
    }

    if (record.type !== "event_msg") {
      continue;
    }
    if (record.payload?.type === "token_count") {
      const current = normalizeUsage(record.payload?.info?.total_token_usage);
      if (!hasUsage(current)) {
        continue;
      }
      const delta = usageDelta(current, previousUsage);
      previousUsage = current;
      if (slot && hasUsage(delta)) {
        slot.usage = addUsage(slot.usage, delta);
        slot.tokenEvents += 1;
      }
    } else if (record.payload?.type === "task_complete") {
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
    }
  }
}

function fillDurationFallbacks(events, byTurn) {
  const starts = events
    .filter((event) => event.eventType === "ralph.prompt" && Number.isInteger(event.turnNumber))
    .map((event) => ({
      turn: event.turnNumber,
      time: Date.parse(event.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  for (let index = 0; index < starts.length; index += 1) {
    const slot = byTurn.get(starts[index].turn);
    if (!slot || slot.durationMs > 0) {
      continue;
    }
    if (slot.goalTimeUsedMs > 0) {
      slot.durationMs = slot.goalTimeUsedMs;
      continue;
    }
    if (slot.sessionFirstMs != null && slot.sessionLastMs != null) {
      slot.durationMs = Math.max(0, slot.sessionLastMs - slot.sessionFirstMs);
      continue;
    }
    const nextTime = starts[index + 1]?.time;
    if (Number.isFinite(nextTime) && nextTime > starts[index].time) {
      slot.durationMs = nextTime - starts[index].time;
    }
  }
}

async function summarizeRun(options, side) {
  const spec = options[side];
  const filePath = resolveRunFile(spec, options.ralphDir);
  const events = readJsonl(filePath);
  const byTurn = buildTurnMeta(events);
  const resolveTurn = buildTurnResolver(events);
  const threadIds = [...new Set(events.map(eventThreadId).filter(Boolean))];
  const sessionFiles = findSessionFiles(options.codexDir, threadIds);

  for (const threadId of threadIds) {
    for (const sessionFile of (sessionFiles.get(threadId) ?? []).sort()) {
      await readSessionUsageIntoTurns(sessionFile, byTurn, resolveTurn);
    }
  }

  fillDurationFallbacks(events, byTurn);

  const model = options[`${side}Model`];
  const byPa = new Map();
  for (const [turn, turnInfo] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
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
      });
    }
    const row = byPa.get(pa);
    row.turns.push(turn);
    row.usage = addUsage(row.usage, turnInfo.usage);
    row.durationMs += turnInfo.durationMs;
    row.cost += estimateCost(turnInfo.usage, model);
    row.phases.set(turnInfo.phase ?? "unknown", (row.phases.get(turnInfo.phase ?? "unknown") ?? 0) + 1);
    if (turnInfo.hasSessionActivity && !turnInfo.hasTaskComplete) {
      row.activeTurns += 1;
    }
  }

  return {
    side,
    spec,
    filePath,
    model,
    byTurn,
    byPa,
  };
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
  return {
    ...row,
    status: row.activeTurns > 0 ? "partial" : "complete",
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
    }),
    { turns: 0, durationMs: 0, cost: 0, usage: emptyUsage(), activeTurns: 0 },
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

function buildComparison(options, leftRun, rightRun) {
  const rows = [];
  for (let number = 1; number <= options.throughNumber; number += 1) {
    const pa = `pa${number}`;
    rows.push({
      pa,
      left: paSummary(leftRun, pa),
      right: paSummary(rightRun, pa),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    through: `pa${options.throughNumber}`,
    rates: DEFAULT_RATES,
    left: {
      label: options.leftLabel,
      model: options.leftModel,
      spec: options.left,
      filePath: leftRun.filePath,
      total: totalSummary(rows.map((row) => row.left)),
    },
    right: {
      label: options.rightLabel,
      model: options.rightModel,
      spec: options.right,
      filePath: rightRun.filePath,
      total: totalSummary(rows.map((row) => row.right)),
    },
    rows,
  };
}

function renderMarkdown(comparison) {
  const left = comparison.left.label;
  const right = comparison.right.label;
  const lines = [];
  lines.push(`Compared through ${comparison.through}. Times are HHH:MM:SS.`);
  lines.push("");
  lines.push("| Run | Turns | Time | Cost | Status |");
  lines.push("|---|---:|---:|---:|---|");
  lines.push(summaryRow(comparison.left));
  lines.push(summaryRow(comparison.right));
  lines.push("");
  lines.push(
    `| PA | ${left} turns | ${left} time | ${left} cost | ${left} status | ${right} turns | ${right} time | ${right} cost | ${right} status |`,
  );
  lines.push("|---|---:|---:|---:|---|---:|---:|---:|---|");
  for (const row of comparison.rows) {
    lines.push(
      [
        row.pa,
        row.left.turns.length,
        hhhmmss(row.left.durationMs),
        money(row.left.cost),
        row.left.status,
        row.right.turns.length,
        hhhmmss(row.right.durationMs),
        money(row.right.cost),
        row.right.status,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push(`Pricing: ${left}=${comparison.left.model}, ${right}=${comparison.right.model}.`);
  lines.push(`Run files: ${comparison.left.filePath}; ${comparison.right.filePath}`);
  lines.push("Status `partial` means at least one included turn has session activity but no task_complete event yet.");
  return lines.join("\n");
}

function summaryRow(run) {
  const status = run.total.activeTurns > 0 ? "partial" : "complete";
  return `| ${run.label} | ${run.total.turns} | ${hhhmmss(run.total.durationMs)} | ${money(run.total.cost)} | ${status} |`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [leftRun, rightRun] = await Promise.all([
    summarizeRun(options, "left"),
    summarizeRun(options, "right"),
  ]);
  const comparison = buildComparison(options, leftRun, rightRun);
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
