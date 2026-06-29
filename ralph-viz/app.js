const runSelect = document.getElementById("runSelect");
const refreshRuns = document.getElementById("refreshRuns");
const reloadRun = document.getElementById("reloadRun");
const viewerMode = document.getElementById("viewerMode");
const codexDetail = document.getElementById("codexDetail");
const summaryTitle = document.getElementById("summaryTitle");
const timelineTitle = document.getElementById("timelineTitle");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const progressDock = document.getElementById("progressDock");
const runDocsCard = document.getElementById("runDocsCard");
const runDocsEl = document.getElementById("runDocs");
const eventFilter = document.getElementById("eventFilter");
const eventCountEl = document.getElementById("eventCount");
const hideNoiseToggle = document.getElementById("hideNoise");
const autoRefreshToggle = document.getElementById("autoRefresh");
const combinedViewToggle = document.getElementById("combinedView");
const fullViewToggle = document.getElementById("fullView");

const AUTO_REFRESH_MS = 2500;
const BOTTOM_STICKY_PX = 32;
const COMPACT_TURN_CARD_LIMIT = 50;
const COMBINED_RUN_CARD_LIMIT = 3;
const ACTIVE_EVENT_GAP_MS = 10 * 60 * 1000;
const SCROLL_JUMP_LOG_PX = 80;
const MOBILE_SCROLL_REFRESH_PAUSE_MS = AUTO_REFRESH_MS;
const SCROLL_DEBUG_PARAM = "scrollDebug";
const SCROLL_DEBUG_STORAGE_KEY = "ralphScrollDebug";
const SCROLL_DEBUG_DEFAULT = false;
const PROGRESS_DOCK_EXTRA_SPACE_PX = 18;
const PROGRESS_BEST_STORAGE_KEY = "ralphProgressBest:v1";
const PROGRESS_BEST_CACHE_LIMIT = 600;
const STATIC_DATA_ROOT = staticDataRootFromUrl();
const ECHARTS_CDN_URL = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
let echartsLoadPromise = null;

const API_PRICE_RATES = new Map([
  ["gpt-5.5", { input: 5.00, cachedInput: 0.50, output: 30.00 }],
  ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.50 }],
  ["gpt-5.4", { input: 2.50, cachedInput: 0.25, output: 15.00 }],
  ["claude-fable-5", { input: 10.00, cachedInput: 1.00, output: 50.00 }],
  ["claude-opus-4-8", { input: 5.00, cachedInput: 0.50, output: 25.00 }],
  ["claude-haiku-4-5", { input: 1.00, cachedInput: 0.10, output: 5.00 }],
]);

const API_PRICE_MODEL_ALIASES = [
  [/(\b|-)opus(\b|-)/, "claude-opus-4-8"],
  [/(\b|-)fable(\b|-)/, "claude-fable-5"],
  [/(\b|-)haiku(\b|-)/, "claude-haiku-4-5"],
];

function staticDataRootFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const root = params.get("data")?.trim();
  return root ? root.replace(/\/+$/, "") : "data";
}

const state = {
  runs: [],
  selectedRun: null,
  currentRun: null,
  shapeUsage: null,
  codexDetail: null,
  events: [],
  combinedRuns: [],
  raw: [],
  staticMode: false,
  staticManifest: null,
  staticRunSummaries: new Map(),
  staticRunDocs: new Map(),
  staticComparison: null,
  compareThrough: null,
  selectedDocName: null,
  autoRefreshTimer: null,
  openTurnReloadTimer: null,
  refreshInFlight: false,
  openEntryKeys: new Set(),
  expandedOutputKeys: new Set(),
  userScrollVersion: 0,
  latestLayoutScrollSnapshot: null,
  stickToBottomAfterLayout: false,
  followLiveTail: false,
  preferScrollTopAfterLayout: false,
  progressDockSpacePx: 0,
  scrollDebugEnabled: initialScrollDebugEnabled(),
  scrollDebugPageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  scrollDebugSeq: 0,
  progressBestCache: loadProgressBestCache(),
  appVersion: null,
  lastObservedScrollTop: null,
  lastUserScrollAt: 0,
  mobileScrollPauseUntil: 0,
  lastProgrammaticScrollAt: 0,
  lastProgrammaticScrollReason: null,
};

let progressDockSpaceFrame = 0;

// Noise event types that clutter the view
const NOISE_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "error", "codex.session.token_count", "codex.task_complete",
  "codex.thread_goal_updated", "ralph.test-status",
  "ralph.agent-progress",
  // Gemini streaming noise
  "content", "finished", "model_info", "tool_call_response",
]);

const SCROLL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " ",
]);

function fmt(time) {
  return time
    ? new Date(time).toLocaleString([], {
        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      })
    : "n/a";
}

function fmtShort(time) {
  return time
    ? new Date(time).toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
}

function initialScrollDebugEnabled() {
  const params = new URLSearchParams(window.location.search);
  if (params.get(SCROLL_DEBUG_PARAM) === "1") {
    try {
      window.localStorage.setItem(SCROLL_DEBUG_STORAGE_KEY, "1");
    } catch (_) {}
    return true;
  }
  if (params.get(SCROLL_DEBUG_PARAM) === "0") {
    try {
      window.localStorage.removeItem(SCROLL_DEBUG_STORAGE_KEY);
    } catch (_) {}
    return false;
  }
  try {
    return window.localStorage.getItem(SCROLL_DEBUG_STORAGE_KEY) === "1" || SCROLL_DEBUG_DEFAULT;
  } catch (_) {
    return SCROLL_DEBUG_DEFAULT;
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && amount >= 1024; i += 1) {
    amount /= 1024;
    unit = units[i];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function cleanText(text) {
  return (text ?? "").toString().trim();
}

function unwrapCommand(command) {
  const text = cleanText(command);
  const prefix = "/bin/bash -lc ";
  if (!text.startsWith(prefix)) return text;
  const wrapped = text.slice(prefix.length).trim();
  if (wrapped.length >= 2) {
    const first = wrapped[0], last = wrapped[wrapped.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"'))
      return wrapped.slice(1, -1);
  }
  return wrapped;
}

function truncate(text, max = 120) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function buildSummary(events, shapeUsage = null, run = null) {
  const turnSet = new Set();
  for (const r of events) {
    const turn = displayTurnForRecord(r);
    if (Number.isInteger(turn)) turnSet.add(turn);
  }
  const first = events.at(0)?.recordedAt ?? null;
  const last = events.at(-1)?.recordedAt ?? null;
  const priceModel = inferPriceModel(run);

  const typeCounts = new Map();
  for (const r of events) {
    const t = r.eventType ?? "unknown";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }

  const testProgress = applyProgressBestCache(buildAgentTestProgressState(events), run);
  const normalizedShapeUsage = normalizeShapeUsage(shapeUsage);

  return {
    threadId: events.at(0)?.threadId ?? "n/a",
    events: events.length,
    turns: turnSet.size,
    first, last,
    activeDurationMs: activeEventDurationMs(events),
    tokenUsage: latestCumulativeUsage(events),
    shapeUsage: normalizedShapeUsage,
    priceModel,
    latestTurn: latestTurnOverview(events, priceModel, normalizedShapeUsage, run),
    latestPhaseStatus: latestPhaseStatus(events),
    testProgress,
    latestTestStatus: latestTestStatus(events),
    typeStats: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function latestTurnOverview(events, priceModel, shapeUsage = null, run = null) {
  const turn = latestNumericTurn(events);
  if (turn == null) {
    return null;
  }
  const durationMap = buildTurnDurationMap(events);
  const duration = durationText(bestTurnDurationSpan(shapeUsage, turn, durationMap, {
    activeCurrentTurn: isActiveCurrentRunTurn(run, turn),
    activeStartMs: activeCurrentRunTurnStartMs(run, turn, events),
  }));
  const usage = bestTurnUsage(shapeUsage, turn, buildUsageMap(events).get(turn));
  const cost = usage ? costEstimateText(usage, priceModel) : "n/a";
  return { turn, duration, cost };
}

function bestTurnDurationSpan(shapeUsage, turn, durationMap, options = {}) {
  const cached = shapeUsageTurnDuration(shapeUsage, turn);
  const live = durationMap?.get(turn) ?? null;
  let best = null;
  if (!cached) {
    best = live;
  } else if (!live) {
    best = cached;
  } else {
    best = (live.durationMs ?? 0) > (cached.durationMs ?? 0) ? live : cached;
  }
  return options.activeCurrentTurn ? activeCurrentTurnDurationSpan(best, cached, live, options) : best;
}

function activeCurrentTurnDurationSpan(best, cached, live, options = {}) {
  const candidates = [best, cached, live].filter(Boolean);
  if (!candidates.length) {
    return best;
  }
  if (options.activeStartMs == null) {
    return best;
  }
  const activeStartMs = Number(options.activeStartMs);
  if (!Number.isFinite(activeStartMs) || activeStartMs <= 0) {
    return best;
  }
  const first = activeStartMs;
  const lastValues = candidates
    .map((entry) => Number(entry.last))
    .filter(Number.isFinite);
  const last = Math.max(Date.now(), ...lastValues, first);
  return {
    ...(best ?? {}),
    first,
    last,
    durationMs: Math.max(Number(best?.durationMs) || 0, last - first),
  };
}

function isActiveCurrentRunTurn(run, turn) {
  if (!run?.state?.active || !Number.isInteger(turn) || turn <= 0) {
    return false;
  }
  const completed = Number(run.state.turnsCompleted);
  return Number.isInteger(completed) && turn > completed;
}

function activeCurrentRunTurnStartMs(run, turn, records = []) {
  if (!isActiveCurrentRunTurn(run, turn)) {
    return null;
  }
  const latestEventStartMs = latestTurnStartMs(records, turn);
  if (Number.isFinite(latestEventStartMs)) {
    return latestEventStartMs;
  }
  return null;
}

function latestTurnStartMs(records, turn) {
  let latest = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (
      record?.eventType !== "ralph.phase-status" ||
      record.event?.action !== "turn-start" ||
      displayTurnForRecord(record) !== turn
    ) {
      continue;
    }
    const time = Date.parse(record.recordedAt ?? "");
    if (Number.isFinite(time) && (latest == null || time > latest)) {
      latest = time;
    }
  }
  return latest;
}

function shapeUsageTurnDuration(shapeUsage, turn) {
  if (!Number.isInteger(turn) || turn <= 0) {
    return null;
  }
  for (const run of Array.isArray(shapeUsage?.runs) ? shapeUsage.runs : []) {
    for (const entry of Array.isArray(run?.turnDurations) ? run.turnDurations : []) {
      if (Number(entry?.turnNumber) !== turn) {
        continue;
      }
      const durationMs = Number(entry?.durationMs);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        return {
          first: entry.firstAt ? Date.parse(entry.firstAt) : null,
          last: entry.lastAt ? Date.parse(entry.lastAt) : null,
          durationMs,
        };
      }
    }
  }
  return null;
}

function bestTurnUsage(shapeUsage, turn, liveUsage = null) {
  const cached = shapeUsageTurnUsage(shapeUsage, turn);
  if (!cached) {
    return liveUsage;
  }
  if (!liveUsage) {
    return cached;
  }
  return usageMagnitude(liveUsage) > usageMagnitude(cached) ? liveUsage : cached;
}

function shapeUsageTurnUsage(shapeUsage, turn) {
  if (!Number.isInteger(turn) || turn <= 0) {
    return null;
  }
  let usage = null;
  for (const run of Array.isArray(shapeUsage?.runs) ? shapeUsage.runs : []) {
    for (const entry of Array.isArray(run?.turnUsages) ? run.turnUsages : []) {
      if (Number(entry?.turnNumber) !== turn) {
        continue;
      }
      const normalized = normalizeUsage(entry?.usage);
      if (hasTokenUsage(normalized)) {
        usage = addUsage(usage, normalized);
      }
    }
  }
  return hasTokenUsage(usage) ? usage : null;
}

function usageMagnitude(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) {
    return 0;
  }
  return normalized.total_tokens ||
    normalized.input_tokens +
      normalized.cached_input_tokens +
      normalized.output_tokens +
      normalized.reasoning_output_tokens ||
    normalized.cost_usd;
}

function latestNumericTurn(events) {
  let latest = null;
  for (const record of events) {
    const turn = displayTurnForRecord(record);
    if (Number.isInteger(turn) && (latest == null || turn > latest)) {
      latest = turn;
    }
  }
  return latest;
}

function displayTurnForRecord(record) {
  if (Number.isInteger(record?._displayTurn) && record._displayTurn > 0) {
    return record._displayTurn;
  }
  if (Number.isInteger(record.turnNumber) && record.turnNumber > 0) {
    return record.turnNumber;
  }
  return "setup";
}

function annotateDisplayTurns(records) {
  const sorted = [...records].sort((a, b) =>
    String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
  let maxDisplayTurn = 0;
  let maxStartedSourceTurn = 0;
  let active = null;
  let lastChecked = null;

  for (const record of sorted) {
    const sourceTurn = Number.isInteger(record.turnNumber) && record.turnNumber > 0
      ? record.turnNumber
      : null;
    if (!sourceTurn) {
      record._displayTurn = null;
      continue;
    }

    const phaseStatus = record.eventType === "ralph.phase-status"
      ? record.event?.phaseStatus
      : null;
    const action = record.event?.action ?? null;

    if (phaseStatus && action === "turn-start") {
      const replayedSourceTurn = sourceTurn < maxStartedSourceTurn && active?.sourceTurn !== sourceTurn;
      const displayTurn = replayedSourceTurn ? maxDisplayTurn + 1 : sourceTurn;
      maxStartedSourceTurn = Math.max(maxStartedSourceTurn, sourceTurn);
      maxDisplayTurn = Math.max(maxDisplayTurn, displayTurn);
      active = {
        sourceTurn,
        displayTurn,
        phase: phaseStatus.phase ?? null,
        stage: phaseStatus.stage ?? null,
        subset: phaseStatus.subset ?? null,
      };
      lastChecked = null;
      record._displayTurn = displayTurn;
      continue;
    }

    if (phaseStatus && action === "checked" && active && phaseStatusMatchesActive(phaseStatus, active)) {
      record._displayTurn = active.displayTurn;
      lastChecked = {
        displayTurn: active.displayTurn,
        stage: phaseStatus.stage ?? null,
        subset: phaseStatus.subset ?? null,
        recordedAt: record.recordedAt ?? null,
      };
      continue;
    }

    if (record.eventType === "ralph.test-status" && lastChecked) {
      const testStatus = record.event?.testStatus;
      if (testStatusMatchesCheckedTurn(testStatus, lastChecked, record.recordedAt)) {
        record._displayTurn = lastChecked.displayTurn;
        continue;
      }
    }

    if (active && sourceTurn === active.sourceTurn) {
      record._displayTurn = active.displayTurn;
      continue;
    }

    record._displayTurn = sourceTurn;
  }

  return records;
}

function phaseStatusMatchesActive(phaseStatus, active) {
  return (
    phaseStatus?.phase === active.phase &&
    phaseStatus?.stage === active.stage &&
    normalizeOptionalText(phaseStatus?.subset) === normalizeOptionalText(active.subset)
  );
}

function testStatusMatchesCheckedTurn(testStatus, checked, recordedAt) {
  if (!testStatus || testStatus.targetStage !== checked.stage) {
    return false;
  }
  if (normalizeOptionalText(testStatus.targetSubset) !== normalizeOptionalText(checked.subset)) {
    return false;
  }
  const checkedAt = Date.parse(checked.recordedAt ?? "");
  const eventAt = Date.parse(recordedAt ?? "");
  return !Number.isFinite(checkedAt) ||
    !Number.isFinite(eventAt) ||
    Math.abs(eventAt - checkedAt) <= 60_000;
}

function normalizeOptionalText(value) {
  return value == null || value === "" ? "" : String(value);
}

function renderSummary(events) {
  const s = buildSummary(events, state.shapeUsage, selectedRunMeta());
  const chips = s.typeStats.slice(0, 8)
    .map(([type, count]) => `<span class="pill">${type}: ${count}</span>`)
    .join(" ");
  const usage = preferredUsageSummary(s);
  const usageText = usage
    ? usageSummaryText(usage.usage, s.priceModel, {
        durationMs: usage.durationMs,
        includeModel: true,
        suffix: usage.suffix,
        costUsd: usage.costUsd,
      })
    : '<span class="muted">n/a</span>';
  const detailText = codexDetailSummaryHtml(state.codexDetail);
  const progressText = latestProgressSummaryHtml(s.testProgress.latest);
  const phaseText = s.latestPhaseStatus
    ? latestPhaseStatusHtml(s.latestPhaseStatus.status)
    : '<span class="muted">n/a</span>';

  summaryEl.innerHTML = `
    <div><strong>thread</strong>${truncate(s.threadId, 24)}</div>
    <div><strong>events</strong>${s.events}</div>
    <div><strong>turns</strong>${s.turns}</div>
    <div><strong>started</strong>${fmt(s.first)}</div>
    <div><strong>latest</strong>${fmt(s.last)}</div>
    <div><strong>detail</strong>${detailText}</div>
    <div class="summary-wide"><strong>phase</strong>${phaseText}</div>
    <div class="summary-wide"><strong>test progress</strong>${progressText}</div>
    <div class="summary-wide"><strong>usage</strong>${usageText}</div>
    <div style="grid-column:1/-1"><strong>types</strong>${chips || '<span class="muted">none</span>'}</div>
  `;
  renderProgressDock(s);
}

function codexDetailSummaryHtml(detail) {
  if (!detail?.mode) {
    return '<span class="muted">n/a</span>';
  }
  if (detail.mode === "none") {
    return "Ralph only";
  }
  if (detail.mode === "all") {
    return "All detail";
  }
  if (detail.mode === "turns") {
    const turns = Array.isArray(detail.turns) ? detail.turns.join(", ") : "";
    return turns ? `Turns ${escapeHtml(turns)}` : '<span class="muted">No detail turns</span>';
  }
  if (detail.mode === "tail") {
    return `Last ${fmtInt(detail.tailTurns ?? 2)} turns`;
  }
  return escapeHtml(detail.mode);
}

function renderProgressDock(summary) {
  if (!progressDock) {
    return;
  }
  const run = selectedRunMeta();
  const details = runDetailHtml(summary, run, { includeName: true, metaClass: "dock-meta" });
  progressDock.innerHTML = details || '<span class="muted">No run</span>';
  updateProgressDockSpace();
}

function runDetailHtml(summary, run, options = {}) {
  const progress = summary?.testProgress?.latest ?? null;
  const testStatus = summary?.latestTestStatus?.status ?? null;
  const phaseStatus = summary?.latestPhaseStatus?.status ?? null;
  const latestTurn = summary?.latestTurn ?? null;
  const usage = preferredUsageSummary(summary);
  const latest = summary?.last ? fmtShort(summary.last) : "";
  const nameHtml = options.includeName
    ? `<strong>${escapeHtml(run?.label ?? state.selectedRun ?? "No run")}</strong>`
    : "";
  const phaseHtml = phaseStatus
    ? `<span class="dock-phase${phaseStatus.allRequiredPassed ? " dock-phase-pass" : ""}">${escapeHtml(phaseStatusText(phaseStatus))}</span>`
    : '<span class="muted">phase n/a</span>';
  const progressHtml = progress
    ? `<span class="dock-main">${escapeHtml(dockProgressText(progress))}</span>`
    : '<span class="muted">test progress n/a</span>';
  const testHtml = testStatus
    ? `<span class="dock-tests${testStatus.allTestsPassed ? " dock-tests-pass" : ""}">${escapeHtml(testStatusText(testStatus, { progress }))}</span>`
    : '<span class="muted">tests n/a</span>';
  const turnHtml = latestTurn
    ? `<span class="dock-turn">${escapeHtml(dockTurnText(latestTurn))}</span>`
    : "";
  const usageHtml = usage
    ? `<span class="dock-usage">${escapeHtml(dockUsageText(usage, summary.priceModel))}</span>`
    : "";
  const metaClass = options.metaClass ?? "dock-meta";
  const updatedHtml = latest ? `<span class="${escapeHtml(metaClass)}">updated ${escapeHtml(latest)}</span>` : "";
  return `
    ${nameHtml}
    ${turnHtml}
    ${usageHtml}
    ${phaseHtml}
    ${progressHtml}
    ${testHtml}
    ${updatedHtml}
  `;
}

function scheduleProgressDockSpaceUpdate() {
  if (!progressDock) {
    return;
  }
  if (progressDockSpaceFrame) {
    window.cancelAnimationFrame(progressDockSpaceFrame);
  }
  progressDockSpaceFrame = window.requestAnimationFrame(() => {
    progressDockSpaceFrame = 0;
    updateProgressDockSpace();
  });
}

function updateProgressDockSpace() {
  if (!progressDock) {
    return;
  }
  const wasSticky = shouldFollowLiveTail(getScrollMetrics());
  const height = Math.ceil(progressDock.getBoundingClientRect().height || 0);
  const space = Math.max(56, height + PROGRESS_DOCK_EXTRA_SPACE_PX);
  state.progressDockSpacePx = space;
  document.documentElement.style.setProperty("--progress-dock-space", `${space}px`);
  if (wasSticky) {
    afterNextPaint(scrollToBottomNow);
  }
}

function dockTurnText(turn) {
  const parts = [`turn ${turn.turn}`];
  if (turn.duration) {
    parts.push(`time ${turn.duration}`);
  }
  parts.push(`cost ${turn.cost || "n/a"}`);
  return parts.join(" / ");
}

function preferredUsageSummary(summary) {
  if (summary?.shapeUsage?.usage) {
    return {
      usage: summary.shapeUsage.usage,
      durationMs: summary.shapeUsage.durationMs,
      suffix: `${fmtInt(summary.shapeUsage.runCount)} runs`,
      costUsd: shapeUsageTurnCost(summary.shapeUsage, summary.priceModel),
    };
  }
  if (summary?.tokenUsage) {
    return {
      usage: summary.tokenUsage,
      durationMs: summary.activeDurationMs,
      suffix: "selected thread",
    };
  }
  return null;
}

function dockUsageText(usageSummary, priceModel) {
  const usage = normalizeUsage(usageSummary?.usage);
  if (!usage) {
    return "usage n/a";
  }
  return `usage ${usageSummaryText(usage, priceModel, {
    durationMs: usageSummary.durationMs,
    compact: true,
    suffix: usageSummary.suffix,
    costUsd: usageSummary.costUsd,
  })}`;
}

function shapeUsageTurnCost(shapeUsage, model) {
  let total = 0;
  let sawCost = false;
  for (const run of Array.isArray(shapeUsage?.runs) ? shapeUsage.runs : []) {
    for (const entry of Array.isArray(run?.turnUsages) ? run.turnUsages : []) {
      const cost = turnUsageCost(entry?.usage, model);
      if (Number.isFinite(cost)) {
        total += cost;
        sawCost = true;
      }
    }
  }
  return sawCost ? total : null;
}

function turnUsageCost(usage, model) {
  const normalized = normalizeUsage(usage);
  if (!hasTokenUsage(normalized)) {
    return null;
  }
  if (normalized.cost_usd > 0) {
    return normalized.cost_usd;
  }
  return apiCostEstimate(normalized, model);
}

// --- Display entry building (merge command start/end) ---

function buildDisplayEntries(records) {
  const entries = [];
  const cmdStarts = new Map();
  const todoEntries = new Map();
  // Gemini: accumulate content chunks by traceId into messages
  const contentByTrace = new Map();

  for (const record of records) {
    const item = record.event?.item;
    const isCmd = item?.type === "command_execution";

    if (record.eventType === "item.started" && isCmd) {
      const entry = { kind: "command", startRecord: record, endRecord: null };
      entries.push(entry);
      if (item.id) cmdStarts.set(item.id, entry);
      continue;
    }
    if (record.eventType === "item.completed" && isCmd) {
      if (item.id && cmdStarts.has(item.id)) {
        cmdStarts.get(item.id).endRecord = record;
        cmdStarts.delete(item.id);
      } else {
        // Claude emits completed-only command events (no item.started)
        entries.push({ kind: "command", startRecord: null, endRecord: record });
      }
      continue;
    }

    if (
      item?.type === "todo_list" &&
      (record.eventType === "item.started" ||
        record.eventType === "item.updated" ||
        record.eventType === "item.completed")
    ) {
      const key = todoEntryKey(record);
      if (todoEntries.has(key)) {
        todoEntries.get(key).record = record;
      } else {
        const entry = { kind: "todo", record };
        todoEntries.set(key, entry);
        entries.push(entry);
      }
      continue;
    }

    // Gemini: accumulate streaming content chunks into a single message entry
    if (record.eventType === "content" && typeof record.event?.value === "string") {
      const traceId = record.event.traceId ?? "_default";
      if (contentByTrace.has(traceId)) {
        contentByTrace.get(traceId).text += record.event.value;
      } else {
        const entry = { kind: "gemini-message", text: record.event.value, record };
        contentByTrace.set(traceId, entry);
        entries.push(entry);
      }
      continue;
    }

    // Gemini: tool call requests — merge with response by callId
    if (record.eventType === "tool_call_request") {
      const callId = record.event?.value?.callId;
      const entry = { kind: "gemini-tool-call", record, responseRecord: null };
      entries.push(entry);
      if (callId) cmdStarts.set(`gemini:${callId}`, entry);
      continue;
    }

    // Gemini: tool call responses — attach to matching request
    if (record.eventType === "tool_call_response") {
      const callId = record.event?.value?.callId;
      const key = `gemini:${callId}`;
      if (callId && cmdStarts.has(key)) {
        cmdStarts.get(key).responseRecord = record;
        cmdStarts.delete(key);
      }
      continue;
    }

    // Gemini: thought events
    if (record.eventType === "thought") {
      entries.push({ kind: "gemini-thought", record });
      continue;
    }

    entries.push({ kind: "event", record });
  }
  return entries;
}

function todoEntryKey(record) {
  const item = record?.event?.item ?? {};
  return [
    "todo",
    record?.threadId ?? "thread",
    displayTurnForRecord(record),
    item.id ?? record?.recordedAt ?? "",
  ].join(":");
}

// --- Card renderers ---

function renderCommandCard(entry) {
  const startItem = entry.startRecord?.event?.item ?? {};
  const endItem = entry.endRecord?.event?.item ?? {};
  const item = entry.endRecord ? endItem : startItem;
  const cmd = unwrapCommand(item.command || startItem.command) || "unknown command";
  const output = cleanText(item.aggregated_output);
  const exitCode = item.exit_code;
  const time = fmtShort(entry.endRecord?.recordedAt ?? entry.startRecord?.recordedAt);

  const card = document.createElement("div");
  card.className = "ev ev-cmd" + (exitCode != null && exitCode !== 0 ? " ev-cmd-fail" : "");
  const { header: summary, body } = createAccordion(card, {
    key: commandEntryKey(entry),
  });

  const cmdSpan = document.createElement("code");
  cmdSpan.className = "cmd-inline";
  cmdSpan.textContent = truncate(cmd, 200);
  summary.append(cmdSpan);

  if (output) {
    const lineCount = output.split(/\r?\n/).length;
    const lc = document.createElement("span");
    lc.className = "cmd-lines";
    lc.textContent = `${lineCount} line${lineCount !== 1 ? "s" : ""}`;
    summary.append(lc);
  }

  if (time) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = time;
    summary.append(ts);
  }

  if (exitCode != null) {
    const badge = document.createElement("span");
    badge.className = exitCode === 0 ? "pill pill-ok" : "pill pill-bad";
    badge.textContent = exitCode === 0 ? "ok" : `exit ${exitCode}`;
    summary.append(badge);
  } else if (!entry.endRecord) {
    const badge = document.createElement("span");
    badge.className = "pill pill-running";
    badge.textContent = "running";
    summary.append(badge);
  }

  appendFullCommand(body, cmd);

  if (output) {
    appendExpandableText(body, output, `out:${commandEntryKey(entry)}`, "cmd-output");
  }

  return card;
}

const OUTPUT_PREVIEW_CHAR_LIMIT = 2000;

function appendExpandableText(container, text, key, className) {
  const el = document.createElement(className === "thought-body" ? "div" : "pre");
  el.className = className;
  if (key) {
    el.dataset.contentScrollKey = key;
  }
  const expanded = key ? state.expandedOutputKeys.has(key) : false;
  if (expanded || text.length <= OUTPUT_PREVIEW_CHAR_LIMIT) {
    el.textContent = text;
    container.append(el);
    return;
  }
  let cut = text.lastIndexOf("\n", OUTPUT_PREVIEW_CHAR_LIMIT);
  if (cut <= 0) {
    cut = OUTPUT_PREVIEW_CHAR_LIMIT;
  }
  const totalLines = text.split(/\r?\n/).length;
  el.textContent = text.slice(0, cut);
  const more = document.createElement("button");
  more.className = "btn-more";
  more.textContent = `Show all (${fmtInt(totalLines)} lines)`;
  more.onclick = () => {
    const scrollSnapshot = captureScrollSnapshot();
    if (key) {
      state.expandedOutputKeys.add(key);
    }
    el.textContent = text;
    more.remove();
    markLayoutScrollIntent(scrollSnapshot);
  };
  container.append(el, more);
}

function appendFullCommand(body, command) {
  const text = cleanText(command);
  if (!text) {
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "cmd-full";
  pre.textContent = text;
  body.append(pre);
}

function commandEntryKey(entry) {
  const startItem = entry.startRecord?.event?.item ?? {};
  const endItem = entry.endRecord?.event?.item ?? {};
  const id = startItem.id ?? endItem.id;
  const threadId = entry.startRecord?.threadId ?? entry.endRecord?.threadId ?? "thread";
  const turn = entry.startRecord?.turnNumber ?? entry.endRecord?.turnNumber ?? "setup";
  if (id) {
    return `command:${threadId}:${turn}:${id}`;
  }
  const recordedAt = entry.startRecord?.recordedAt ?? entry.endRecord?.recordedAt ?? "";
  const command = unwrapCommand(startItem.command || endItem.command || "");
  return `command:${threadId}:${turn}:${recordedAt}:${command}`;
}

function createAccordion(root, options = {}) {
  const {
    key = null,
    initialOpen = key ? state.openEntryKeys.has(key) : false,
    headerClass = "accordion-header",
    bodyClass = "accordion-body",
    scrollKey = key,
    onToggle = null,
  } = options;

  root.classList.add("accordion");
  if (key) {
    root.dataset.entryKey = key;
  }

  const header = document.createElement("button");
  header.type = "button";
  header.className = headerClass;
  if (scrollKey) {
    header.dataset.scrollKey = scrollKey;
  }

  const body = document.createElement("div");
  body.className = bodyClass;

  function setOpen(open) {
    root.classList.toggle("is-open", open);
    root.dataset.open = open ? "true" : "false";
    header.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  }

  setOpen(Boolean(initialOpen));
  header.addEventListener("click", () => {
    const scrollSnapshot = captureScrollSnapshot();
    const open = !root.classList.contains("is-open");
    scrollDebug("accordion-click-before", {
      open,
      key,
      root: describeElementForScroll(root),
      header: describeElementForScroll(header),
      snapshot: scrollSnapshot,
    });
    setOpen(open);
    if (key) {
      if (open) {
        state.openEntryKeys.add(key);
      } else {
        state.openEntryKeys.delete(key);
      }
    }
    if (onToggle) {
      onToggle(open);
    }
    const layoutSnapshot = markLayoutScrollIntent(scrollSnapshot);
    restoreScrollAfterRender(layoutSnapshot, { immediate: true });
    scrollDebug("accordion-click-after", {
      open,
      key,
      root: describeElementForScroll(root),
      header: describeElementForScroll(header),
    });
  });

  root.append(header, body);
  return { header, body, setOpen };
}

function renderMessageCard(record) {
  const text = cleanText(record.event?.item?.text);
  if (!text) return null;

  const card = document.createElement("div");
  card.className = "ev ev-msg";

  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;

  card.append(body);
  return card;
}

function renderFileChangeCard(record) {
  const item = record.event?.item ?? {};
  const changes = item.changes ?? [];
  if (!changes.length) return null;

  const card = document.createElement("div");
  card.className = "ev ev-file";
  const { header: summary, body } = createAccordion(card, {
    key: fileChangeEntryKey(record),
  });
  if (changes.length === 1) {
    summary.append(fileChangeLabel(changes[0]));
  } else {
    summary.innerHTML = `<span class="pill">${changes.length} files</span>`;
  }
  const time = fmtShort(record.recordedAt);
  if (time) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = time;
    summary.append(ts);
  }

  const list = document.createElement("div");
  list.className = "file-list";
  for (const c of changes) {
    const row = document.createElement("div");
    row.className = "file-row";
    const path = c.movePath ? `${c.path} -> ${c.movePath}` : c.path;
    row.innerHTML = `<span class="file-kind">${c.kind}</span> <span class="file-path">${path}</span>`;
    list.append(row);
    const addedText = addedFileTextFromDiff(c);
    if (addedText != null) {
      const lang = sourceLanguageForPath(c.path);
      const pre = document.createElement("pre");
      pre.className = `file-source language-${lang}`;
      pre.dataset.contentScrollKey = `source:${fileChangeEntryKey(record)}:${fileChangePathText(c)}`;
      const code = document.createElement("code");
      code.className = `language-${lang}`;
      code.textContent = addedText;
      pre.append(code);
      highlightCodeBlock(code);
      list.append(pre);
    } else if (c.diff) {
      const pre = document.createElement("pre");
      pre.className = "file-diff";
      pre.dataset.contentScrollKey = `diff:${fileChangeEntryKey(record)}:${fileChangePathText(c)}`;
      const code = document.createElement("code");
      code.className = "language-diff-cpp diff-highlight";
      code.textContent = c.diff;
      pre.append(code);
      highlightCodeBlock(code);
      list.append(pre);
    }
  }

  body.append(list);
  return card;
}

function addedFileTextFromDiff(change) {
  if (change?.kind !== "add" || typeof change?.diff !== "string" || !change.diff) {
    return null;
  }
  const lines = change.diff.split(/\r?\n/);
  const hasUnifiedHeaders = lines.some((line) => line.startsWith("@@") || line.startsWith("--- "));
  const added = [];
  let inHunk = !hasUnifiedHeaders;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (hasUnifiedHeaders && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }
    if (line.startsWith("+") && inHunk) {
      added.push(line.slice(1));
    }
  }
  if (added.length === 0 && !change.diff.startsWith("+")) {
    return null;
  }
  return added.join("\n");
}

function sourceLanguageForPath(filePath) {
  const name = String(filePath ?? "").split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (name === "Makefile" || lower === "makefile" || lower.endsWith(".mk")) return "makefile";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh") || lower.endsWith(".hxx") || lower.endsWith(".h")) return "cpp";
  if (lower.endsWith(".c")) return "c";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".pl") || lower.endsWith(".pm")) return "perl";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".html") || lower.endsWith(".xml")) return "markup";
  if (lower.endsWith(".css")) return "css";
  return "none";
}

function highlightCodeBlock(code) {
  if (!code || !window.Prism?.highlightElement) {
    return;
  }
  try {
    window.Prism.highlightElement(code);
  } catch (_) {
    // Keep the raw text visible if Prism fails to parse a large or unusual block.
  }
}

function fileChangePathText(change) {
  const path = change?.movePath ? `${change.path} -> ${change.movePath}` : change?.path;
  return path || "file";
}

function fileChangeLabel(change) {
  const label = document.createElement("span");
  label.className = "file-title";

  const kind = document.createElement("span");
  kind.className = "file-kind";
  kind.textContent = change?.kind ?? "update";

  const path = document.createElement("span");
  path.className = "file-path";
  path.textContent = fileChangePathText(change);

  label.append(kind, " ", path);
  return label;
}

function fileChangeEntryKey(record) {
  const item = record.event?.item ?? {};
  const threadId = record.threadId ?? "thread";
  const turn = record.turnNumber ?? "setup";
  if (item.id) {
    return `file:${threadId}:${turn}:${item.id}`;
  }
  const paths = (item.changes ?? []).map(fileChangePathText).join(",");
  return `file:${threadId}:${turn}:${record.recordedAt ?? ""}:${paths}`;
}

function renderTodoCard(record) {
  const items = record.event?.item?.items ?? [];
  if (!items.length) return null;

  const card = document.createElement("div");
  card.className = "ev ev-todo";
  const { header: summary, body } = createAccordion(card, {
    key: todoEntryKey(record),
  });
  const done = items.filter(t => t.completed).length;
  summary.innerHTML = `<span class="pill">${done}/${items.length} tasks</span>`;

  const list = document.createElement("div");
  list.className = "todo-list";
  for (const t of items) {
    const row = document.createElement("div");
    row.className = t.completed ? "todo-row todo-done" : "todo-row";
    row.textContent = `${t.completed ? "\u2713" : "\u25CB"} ${t.text}`;
    list.append(row);
  }

  body.append(list);
  return card;
}

function renderReasoningCard(record) {
  const text = cleanText(record.event?.item?.text);
  if (!text) return null;

  const card = document.createElement("div");
  card.className = "ev ev-thought";

  appendExpandableText(card, text, `out:${recordScrollKey(record, "reasoning")}`, "thought-body");

  return card;
}

function renderMcpToolCard(record) {
  const item = record.event?.item ?? {};
  const failed = item.status === "failed" || Boolean(item.error);
  const label = item.server && item.server !== "claude-code"
    ? `${item.server}/${item.tool ?? "tool"}`
    : item.tool ?? "tool";
  const errorText = cleanText(item.error?.message ?? "");
  const resultText = cleanText(
    typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "", null, 2),
  );
  const output = errorText && errorText !== resultText
    ? [errorText, resultText].filter(Boolean).join("\n")
    : resultText || errorText;
  const time = fmtShort(record.recordedAt);

  const card = document.createElement("div");
  card.className = "ev ev-cmd" + (failed ? " ev-cmd-fail" : "");
  const { header: summary, body } = createAccordion(card, {
    key: mcpToolEntryKey(record),
  });

  const toolSpan = document.createElement("span");
  toolSpan.className = "pill";
  toolSpan.textContent = label;
  summary.append(toolSpan);

  const detail = mcpToolDetailText(item);
  if (detail) {
    const detailSpan = document.createElement("code");
    detailSpan.className = "cmd-inline";
    detailSpan.textContent = truncate(detail, 200);
    summary.append(document.createTextNode(" "), detailSpan);
  }

  if (output) {
    const lineCount = output.split(/\r?\n/).length;
    const lc = document.createElement("span");
    lc.className = "cmd-lines";
    lc.textContent = `${lineCount} line${lineCount !== 1 ? "s" : ""}`;
    summary.append(lc);
  }

  if (time) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = time;
    summary.append(ts);
  }

  const badge = document.createElement("span");
  badge.className = failed ? "pill pill-bad" : "pill pill-ok";
  badge.textContent = failed ? "error" : "ok";
  summary.append(badge);

  if (output) {
    appendExpandableText(body, output, `out:${mcpToolEntryKey(record)}`, "cmd-output");
  }

  return card;
}

function mcpToolDetailText(item) {
  const input = item?.input;
  if (!input || typeof input !== "object") return "";
  const value =
    input.file_path ??
    input.notebook_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.command ??
    input.description ??
    input.prompt ??
    "";
  let detail = typeof value === "string" ? value : "";
  if (detail && input.offset != null) {
    detail += `:${input.offset}`;
    if (input.limit != null) detail += `-${Number(input.offset) + Number(input.limit)}`;
  }
  return detail;
}

function mcpToolEntryKey(record) {
  const item = record.event?.item ?? {};
  const threadId = record.threadId ?? "thread";
  const turn = record.turnNumber ?? "setup";
  if (item.id) {
    return `mcp:${threadId}:${turn}:${item.id}`;
  }
  return `mcp:${threadId}:${turn}:${record.recordedAt ?? ""}:${item.server ?? ""}:${item.tool ?? ""}`;
}

function renderWebSearchCard(record) {
  const query = cleanText(record.event?.item?.query);
  if (!query) return null;

  const card = document.createElement("div");
  card.className = "ev ev-cmd";

  const label = document.createElement("span");
  label.className = "pill";
  label.textContent = "web_search";

  const text = document.createElement("code");
  text.className = "cmd-inline";
  text.textContent = truncate(query, 200);

  card.append(label, document.createTextNode(" "), text);
  return card;
}

function renderSystemCard(record) {
  // Compact one-liner for system events
  const div = document.createElement("div");
  div.className = "ev ev-sys";

  let text = record.eventType;
  if (record.eventType === "turn.completed" && record.event?.usage) {
    const u = record.event.usage;
    text = `turn done \u2014 ${u.input_tokens + u.output_tokens} tok (${u.input_tokens} in, ${u.output_tokens} out)`;
  } else if (record.eventType === "finished" && record.event?.value?.usageMetadata) {
    const u = record.event.value.usageMetadata;
    const total = u.totalTokenCount ?? 0;
    text = `finished \u2014 ${total} tok (${u.promptTokenCount ?? 0} in, ${u.candidatesTokenCount ?? 0} out, ${u.thoughtsTokenCount ?? 0} thought)`;
  } else if (record.eventType === "model_info") {
    text = `model: ${record.event?.value ?? "unknown"}`;
  } else if (record.eventType === "turn.failed") {
    text = `turn failed: ${cleanText(record.event?.error?.message) || "unknown"}`;
    div.classList.add("ev-sys-err");
  } else if (isLimitWaitEvent(record)) {
    const minutes = Math.ceil((record.event?.wait_ms ?? 0) / 60000);
    const label = record.eventType === "ralph.limit_wait" ? "provider wait" : "quota wait";
    text = `${label} — ${minutes}m (${cleanText(record.event?.message) || "usage limit"})`;
  } else if (record.eventType === "error") {
    text = `error: ${cleanText(record.event?.message) || "unknown"}`;
    div.classList.add("ev-sys-err");
  }

  const ts = fmtShort(record.recordedAt);
  div.innerHTML = `<span class="sys-label">${text}</span>${ts ? `<span class="ts">${ts}</span>` : ""}`;
  return div;
}

function renderPromptCard(record) {
  const prompt = cleanText(record.event?.prompt);
  if (!prompt) return null;

  const card = document.createElement("div");
  card.className = "ev ev-prompt";

  const label = document.createElement("span");
  label.className = "prompt-label";
  label.textContent = "Turn prompt";

  const body = document.createElement("div");
  body.className = "prompt-body";
  body.textContent = prompt;

  card.append(label, body);
  return card;
}

function renderGoalCard(record) {
  const goal = record.event?.goal;
  const objective = cleanText(goal?.objective);
  if (!objective) return null;

  const parts = ["Goal objective"];
  if (record.event?.action) parts.push(record.event.action);
  if (goal?.status) parts.push(goal.status);

  const card = document.createElement("div");
  card.className = "ev ev-goal";

  const label = document.createElement("span");
  label.className = "goal-label";
  label.textContent = parts.join(" / ");

  const body = document.createElement("div");
  body.className = "goal-body";
  body.textContent = objective;

  card.append(label, body);
  return card;
}

function renderPhaseStatusCard(record) {
  const status = record.event?.phaseStatus;
  if (!status) return null;

  const card = document.createElement("div");
  card.className = "ev ev-phase";

  const label = document.createElement("span");
  label.className = status.allRequiredPassed ? "phase-label phase-label-pass" : "phase-label";
  const action = record.event?.action ? ` / ${record.event.action}` : "";
  label.textContent = `Phase ${phaseStatusText(status)}${action}`;
  card.append(label);

  const checks = Array.isArray(status.checks) ? status.checks : [];
  if (checks.length) {
    const list = document.createElement("div");
    list.className = "phase-checks";
    for (const check of checks) {
      const row = document.createElement("div");
      row.className = `phase-check${check.passed ? " phase-check-pass" : " phase-check-fail"}`;

      const name = document.createElement("span");
      name.className = "phase-check-name";
      name.textContent = check.name ?? "check";
      row.append(name);

      const result = document.createElement("span");
      result.className = "phase-check-result";
      result.textContent = check.passed ? "pass" : `fail ${check.exitCode ?? "?"}`;
      row.append(result);

      if (check.command) {
        const command = document.createElement("code");
        command.className = "phase-check-command";
        command.textContent = check.command;
        row.append(command);
      }

      if (!check.passed && check.outputPreview) {
        const preview = document.createElement("span");
        preview.className = "phase-check-preview";
        preview.textContent = check.outputPreview;
        row.append(preview);
      }

      list.append(row);
    }
    card.append(list);
  }

  return card;
}

function renderGeminiMessageCard(entry) {
  const text = cleanText(entry.text);
  if (!text) return null;

  const card = document.createElement("div");
  card.className = "ev ev-msg";

  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;

  card.append(body);
  return card;
}

function renderGeminiToolCallCard(entry) {
  const record = entry.record;
  const responseRecord = entry.responseRecord;
  const val = record.event?.value ?? {};
  const respVal = responseRecord?.event?.value ?? {};
  const toolName = val.name ?? "unknown";
  const args = val.args ?? {};
  const cmd = args.command ?? args.file_path ?? args.dir_path ?? "";
  const description = args.description ?? "";
  const output = cleanText(respVal.output);
  const time = fmtShort(responseRecord?.recordedAt ?? record.recordedAt);
  const durationMs = respVal.durationMs;

  const card = document.createElement("div");
  const isError = respVal.status === "error";
  card.className = "ev ev-cmd" + (isError ? " ev-cmd-fail" : "");
  const { header: summary, body } = createAccordion(card, {
    key: geminiToolEntryKey(entry),
  });

  const toolSpan = document.createElement("span");
  toolSpan.className = "pill";
  toolSpan.textContent = toolName;
  summary.append(toolSpan);

  if (cmd) {
    const cmdSpan = document.createElement("code");
    cmdSpan.className = "cmd-inline";
    cmdSpan.textContent = truncate(cmd, 200);
    summary.append(document.createTextNode(" "), cmdSpan);
  } else if (description) {
    const descSpan = document.createElement("span");
    descSpan.className = "cmd-inline";
    descSpan.textContent = truncate(description, 200);
    summary.append(document.createTextNode(" "), descSpan);
  }

  if (output) {
    const lineCount = output.split(/\r?\n/).length;
    const lc = document.createElement("span");
    lc.className = "cmd-lines";
    lc.textContent = `${lineCount} line${lineCount !== 1 ? "s" : ""}`;
    summary.append(lc);
  }

  if (time) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = time;
    summary.append(ts);
  }

  if (durationMs != null) {
    const dur = document.createElement("span");
    dur.className = "cmd-lines";
    dur.textContent = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
    summary.append(dur);
  }

  if (responseRecord) {
    const badge = document.createElement("span");
    badge.className = isError ? "pill pill-bad" : "pill pill-ok";
    badge.textContent = isError ? "error" : "ok";
    summary.append(badge);
  }

  appendFullCommand(body, cmd || description);

  if (output) {
    appendExpandableText(body, output, `out:${geminiToolEntryKey(entry)}`, "cmd-output");
  } else if (!responseRecord) {
    // No response yet — show args as fallback
    const argText = JSON.stringify(args, null, 2);
    if (argText && argText !== "{}") {
      const pre = document.createElement("pre");
      pre.className = "cmd-output";
      pre.textContent = argText;
      body.append(pre);
    }
  }

  return card;
}

function geminiToolEntryKey(entry) {
  const record = entry.record;
  const callId = record.event?.value?.callId;
  const traceId = record.event?.traceId;
  const threadId = record.threadId ?? "thread";
  const turn = record.turnNumber ?? "setup";
  return `gemini-tool:${threadId}:${turn}:${callId ?? traceId ?? record.recordedAt ?? ""}`;
}

function renderGeminiThoughtCard(record) {
  const val = record.event?.value ?? {};
  const subject = cleanText(val.subject);
  const description = cleanText(val.description);
  if (!subject && !description) return null;

  const card = document.createElement("div");
  card.className = "ev ev-thought";

  if (subject) {
    const subj = document.createElement("strong");
    subj.className = "thought-subject";
    subj.textContent = subject;
    card.append(subj);
  }
  if (description) {
    const body = document.createElement("div");
    body.className = "thought-body";
    body.textContent = description;
    card.append(body);
  }

  return card;
}

function renderDisplayEntry(entry) {
  if (entry.kind === "command") return renderCommandCard(entry);
  if (entry.kind === "todo") return renderTodoCard(entry.record);
  if (entry.kind === "gemini-message") return renderGeminiMessageCard(entry);
  if (entry.kind === "gemini-tool-call") return renderGeminiToolCallCard(entry);
  if (entry.kind === "gemini-thought") return renderGeminiThoughtCard(entry.record);

  const record = entry.record;
  const item = record.event?.item;

  if (record.eventType === "ralph.goal")
    return renderGoalCard(record);
  if (record.eventType === "ralph.prompt")
    return renderPromptCard(record);
  if (record.eventType === "ralph.phase-status")
    return renderPhaseStatusCard(record);
  if (record.eventType === "item.completed" && item?.type === "agent_message")
    return renderMessageCard(record);
  if (record.eventType === "item.completed" && item?.type === "file_change")
    return renderFileChangeCard(record);
  if (
    (record.eventType === "item.started" ||
      record.eventType === "item.updated" ||
      record.eventType === "item.completed") &&
    item?.type === "todo_list"
  )
    return renderTodoCard(record);
  if (record.eventType === "item.completed" && item?.type === "reasoning")
    return renderReasoningCard(record);
  if (record.eventType === "item.completed" && item?.type === "mcp_tool_call")
    return renderMcpToolCard(record);
  if (record.eventType === "item.completed" && item?.type === "web_search")
    return renderWebSearchCard(record);

  // System / noise
  return renderSystemCard(record);
}

function scrollKeyForEntry(entry, index = null) {
  if (entry.kind === "command") return commandEntryKey(entry);
  if (entry.kind === "todo") return todoEntryKey(entry.record);
  if (entry.kind === "gemini-tool-call") return geminiToolEntryKey(entry);
  if (entry.kind === "gemini-message") return recordScrollKey(entry.record, "gemini-message", index);
  if (entry.kind === "gemini-thought") return recordScrollKey(entry.record, "gemini-thought", index);
  return recordScrollKey(entry.record, entry.kind ?? "event", index);
}

function recordScrollKey(record, prefix = "event", index = null) {
  if (!record) {
    return null;
  }
  const item = record.event?.item ?? {};
  const threadId = record.threadId ?? "thread";
  const turn = displayTurnForRecord(record);
  const stableParts = [
    item.id,
    item.type,
    record.event?.traceId,
    record.event?.action,
    record.recordedAt,
    index == null ? null : `entry-${index}`,
  ].filter(part => part != null && part !== "");
  const stableId = stableParts.join(":") || record.eventType || "";
  return `${prefix}:${threadId}:${turn}:${record.eventType ?? "event"}:${stableId}`;
}

function expandableEntryKey(entry) {
  if (entry.kind === "command") return commandEntryKey(entry);
  if (entry.kind === "gemini-tool-call") return geminiToolEntryKey(entry);
  if (entry.kind === "event" && entry.record?.eventType === "item.completed" && entry.record?.event?.item?.type === "file_change") {
    return fileChangeEntryKey(entry.record);
  }
  if (entry.kind === "event" && entry.record?.eventType === "item.completed" && entry.record?.event?.item?.type === "mcp_tool_call") {
    return mcpToolEntryKey(entry.record);
  }
  return null;
}

function isFullCardView() {
  return fullViewToggle?.checked ?? false;
}

function displayEntryWindow(entries) {
  if (isFullCardView() || entries.length <= COMPACT_TURN_CARD_LIMIT) {
    return {
      entries,
      total: entries.length,
      hidden: 0,
      startIndex: 0,
      indices: entries.map((_, index) => index),
      latestCount: entries.length,
      openExtra: 0,
    };
  }
  const startIndex = entries.length - COMPACT_TURN_CARD_LIMIT;
  const visibleIndices = new Set();
  for (let index = startIndex; index < entries.length; index += 1) {
    visibleIndices.add(index);
  }
  entries.forEach((entry, index) => {
    const key = expandableEntryKey(entry);
    if (key && state.openEntryKeys.has(key)) {
      visibleIndices.add(index);
    }
  });
  const indices = [...visibleIndices].sort((a, b) => a - b);
  const openExtra = indices.filter(index => index < startIndex).length;
  return {
    entries: indices.map(index => entries[index]),
    total: entries.length,
    hidden: entries.length - indices.length,
    startIndex,
    indices,
    latestCount: COMPACT_TURN_CARD_LIMIT,
    openExtra,
  };
}

function turnCardWindowText(windowInfo) {
  if (!windowInfo?.hidden) {
    return "";
  }
  if (windowInfo.openExtra) {
    return `latest ${windowInfo.latestCount}/${windowInfo.total} cards + ${windowInfo.openExtra} open`;
  }
  return `latest ${windowInfo.entries.length}/${windowInfo.total} cards`;
}

// --- Filtering ---

function shouldShow(record) {
  const hideNoise = hideNoiseToggle?.checked ?? true;
  if (hideNoise && NOISE_TYPES.has(record.eventType)) {
    // Keep item.started only for commands (they get merged)
    if (record.eventType === "item.started" && record.event?.item?.type === "command_execution")
      return true;
    // Keep gemini content/tool_call_response — they get merged by buildDisplayEntries
    if (record.eventType === "content" || record.eventType === "tool_call_response") return true;
    return false;
  }
  return true;
}

function filterRecords(records) {
  const search = eventFilter.value.trim().toLowerCase();
  let filtered = records;
  if (search) {
    filtered = filtered.filter(r => (r.eventType ?? "").toLowerCase().includes(search));
  }
  return filtered.filter(shouldShow);
}

// --- Turn grouping + timeline ---

function buildTurnMap(events) {
  const turns = new Map();
  for (const record of events) {
    const turn = displayTurnForRecord(record);
    const list = turns.get(turn) ?? [];
    list.push(record);
    turns.set(turn, list);
  }
  return turns;
}

function buildTurnDurationMap(records, options = {}) {
  const includeOpenCommandTail = options.includeOpenCommandTail !== false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const map = new Map();
  const attempts = buildTurnAttemptWindows(records);
  const spansByTurnAttemptThread = new Map();
  const sessionTimingByTurnAttempt = new Map();
  const ralphLifecycleByTurnAttempt = new Map();
  const limitWaitsByTurnAttempt = new Map();
  const openCommandsByTurnAttemptThread = new Map();
  let latestEventTime = -Infinity;
  const latestAttemptThreadKeys = new Set();
  for (const record of records) {
    const turn = displayTurnForRecord(record);
    const time = Date.parse(record.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    const durationSpanActivity = isDurationSpanActivity(record);
    if (durationSpanActivity) {
      const span = map.get(turn) ?? { first: time, last: time, durationMs: 0 };
      span.first = Math.min(span.first, time);
      span.last = Math.max(span.last, time);
      map.set(turn, span);
    } else if (!map.has(turn)) {
      map.set(turn, { first: null, last: null, durationMs: 0 });
    }

    const attemptIndex = findTurnAttemptIndex(attempts, turn, time);
    const turnAttemptKey = `${turn}\0${attemptIndex}`;
    if (isLimitWaitEvent(record)) {
      const waitMs = Number(record.event?.wait_ms ?? 0);
      if (Number.isFinite(waitMs) && waitMs > 0) {
        const waits = limitWaitsByTurnAttempt.get(turnAttemptKey) ?? [];
        waits.push({ startMs: time, durationMs: waitMs });
        limitWaitsByTurnAttempt.set(turnAttemptKey, waits);
      }
    }
    if (durationSpanActivity) {
      const attemptThreadKey = `${turnAttemptKey}\0${eventThreadId(record) ?? ""}`;
      if (time > latestEventTime) {
        latestEventTime = time;
        latestAttemptThreadKeys.clear();
        latestAttemptThreadKeys.add(attemptThreadKey);
      } else if (time === latestEventTime) {
        latestAttemptThreadKeys.add(attemptThreadKey);
      }
      const threadSpan = spansByTurnAttemptThread.get(attemptThreadKey) ?? {
        turn,
        attemptIndex,
        first: time,
        last: time,
        events: [],
      };
      threadSpan.first = Math.min(threadSpan.first, time);
      threadSpan.last = Math.max(threadSpan.last, time);
      threadSpan.events.push({ ...record, time });
      spansByTurnAttemptThread.set(attemptThreadKey, threadSpan);
      if (isCommandStartEvent(record)) {
        openCommandsByTurnAttemptThread.set(
          attemptThreadKey,
          (openCommandsByTurnAttemptThread.get(attemptThreadKey) ?? 0) + 1,
        );
      } else if (isCommandEndEvent(record)) {
        openCommandsByTurnAttemptThread.set(
          attemptThreadKey,
          Math.max(0, (openCommandsByTurnAttemptThread.get(attemptThreadKey) ?? 0) - 1),
        );
      }
    }

    if (isCodexTimingActivity(record)) {
      const timing = sessionTimingByTurnAttempt.get(turnAttemptKey) ?? {
        turn,
        attemptIndex,
        durationMs: 0,
        goalTimeUsedMs: 0,
        sessionFirstMs: null,
        sessionLastMs: null,
      };
      timing.sessionFirstMs = timing.sessionFirstMs == null ? time : Math.min(timing.sessionFirstMs, time);
      timing.sessionLastMs = timing.sessionLastMs == null ? time : Math.max(timing.sessionLastMs, time);
      if (record.eventType === "codex.task_complete") {
        const durationMs = Number(record.event?.durationMs ?? 0);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          timing.durationMs += durationMs;
        }
      } else if (record.eventType === "codex.thread_goal_updated") {
        const timeUsedSeconds = Number(record.event?.timeUsedSeconds ?? 0);
        if (Number.isFinite(timeUsedSeconds) && timeUsedSeconds > 0) {
          timing.goalTimeUsedMs = Math.max(timing.goalTimeUsedMs, timeUsedSeconds * 1000);
        }
      }
      sessionTimingByTurnAttempt.set(turnAttemptKey, timing);
    }

    if (record.eventType === "ralph.phase-status") {
      const lifecycle = ralphLifecycleByTurnAttempt.get(turnAttemptKey) ?? {
        turn,
        attemptIndex,
        startMs: null,
        checkedMs: null,
      };
      if (record.event?.action === "turn-start") {
        lifecycle.startMs = lifecycle.startMs == null ? time : Math.max(lifecycle.startMs, time);
        if (lifecycle.checkedMs != null && lifecycle.checkedMs < lifecycle.startMs) {
          lifecycle.checkedMs = null;
        }
      } else if (record.event?.action === "checked") {
        lifecycle.checkedMs = lifecycle.checkedMs == null ? time : Math.max(lifecycle.checkedMs, time);
      }
      ralphLifecycleByTurnAttempt.set(turnAttemptKey, lifecycle);
    }
  }
  if (includeOpenCommandTail) {
    for (const [attemptThreadKey, openCommands] of openCommandsByTurnAttemptThread.entries()) {
      if (openCommands <= 0 || !latestAttemptThreadKeys.has(attemptThreadKey)) {
        continue;
      }
      const threadSpan = spansByTurnAttemptThread.get(attemptThreadKey);
      if (threadSpan) {
        threadSpan.last = Math.max(threadSpan.last, nowMs);
      }
      const [turn, attemptIndex] = attemptThreadKey.split("\0");
      const timing = sessionTimingByTurnAttempt.get(`${turn}\0${attemptIndex}`);
      if (timing && timing.sessionLastMs != null) {
        timing.sessionLastMs = Math.max(timing.sessionLastMs, nowMs);
      }
    }
  }
  const attemptDurations = new Map();
  for (const [attemptThreadKey, threadSpan] of spansByTurnAttemptThread.entries()) {
    const key = `${threadSpan.turn}\0${threadSpan.attemptIndex}`;
    const durationMs = activeEventDurationMs(threadSpan.events, {
      includeOpenCommandTail: includeOpenCommandTail && latestAttemptThreadKeys.has(attemptThreadKey),
      nowMs,
    });
    attemptDurations.set(key, (attemptDurations.get(key) ?? 0) + durationMs);
  }
  for (const [key, lifecycle] of ralphLifecycleByTurnAttempt.entries()) {
    if (
      Number.isFinite(lifecycle.startMs) &&
      Number.isFinite(lifecycle.checkedMs) &&
      lifecycle.checkedMs >= lifecycle.startMs
    ) {
      attemptDurations.set(
        key,
        subtractLimitWaitOverlap(
          lifecycle.checkedMs - lifecycle.startMs,
          lifecycle.startMs,
          lifecycle.checkedMs,
          limitWaitsByTurnAttempt.get(key),
        ),
      );
    }
  }
  for (const [key, timing] of sessionTimingByTurnAttempt.entries()) {
    let durationMs = 0;
    if (timing.durationMs > 0) {
      durationMs = Math.max(durationMs, timing.durationMs);
    }
    if (timing.goalTimeUsedMs > 0) {
      durationMs = Math.max(
        durationMs,
        subtractLimitWaitOverlap(
          timing.goalTimeUsedMs,
          timing.sessionFirstMs,
          timing.sessionLastMs,
          limitWaitsByTurnAttempt.get(key),
        ),
      );
    }
    if (timing.sessionFirstMs != null && timing.sessionLastMs != null) {
      durationMs = Math.max(
        durationMs,
        subtractLimitWaitOverlap(
          Math.max(0, timing.sessionLastMs - timing.sessionFirstMs),
          timing.sessionFirstMs,
          timing.sessionLastMs,
          limitWaitsByTurnAttempt.get(key),
        ),
      );
    }
    if (durationMs > 0) {
      attemptDurations.set(key, Math.max(attemptDurations.get(key) ?? 0, durationMs));
    }
  }
  const totalByTurn = new Map();
  for (const [key, durationMs] of attemptDurations.entries()) {
    const turn = Number(key.split("\0", 1)[0]);
    if (Number.isFinite(turn)) {
      totalByTurn.set(turn, (totalByTurn.get(turn) ?? 0) + durationMs);
    }
  }
  for (const [turn, durationMs] of totalByTurn.entries()) {
    const span = map.get(turn);
    if (span) {
      span.durationMs = durationMs;
    }
  }
  return map;
}

function subtractLimitWaitOverlap(durationMs, spanStartMs, spanEndMs, waits) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(waits) || !waits.length) {
    return Math.max(0, durationMs || 0);
  }
  if (!Number.isFinite(spanStartMs) || !Number.isFinite(spanEndMs) || spanEndMs <= spanStartMs) {
    return Math.max(0, durationMs);
  }
  let waitedMs = 0;
  for (const wait of waits) {
    const waitStartMs = Number(wait?.startMs);
    const waitDurationMs = Number(wait?.durationMs);
    if (!Number.isFinite(waitStartMs) || !Number.isFinite(waitDurationMs) || waitDurationMs <= 0) {
      continue;
    }
    const start = Math.max(spanStartMs, waitStartMs);
    const end = Math.min(spanEndMs, waitStartMs + waitDurationMs);
    waitedMs += Math.max(0, end - start);
  }
  return Math.max(0, durationMs - waitedMs);
}

function buildTurnAttemptWindows(records) {
  const attempts = new Map();
  const starts = records
    .filter((record) => record.eventType === "ralph.phase-status" &&
      record.event?.action === "turn-start" &&
      Number.isInteger(displayTurnForRecord(record)))
    .map((record) => ({
      turn: displayTurnForRecord(record),
      startMs: Date.parse(record.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.startMs))
    .sort((left, right) => left.startMs - right.startMs);

  for (const start of starts) {
    const list = attempts.get(start.turn) ?? [];
    const previous = list[list.length - 1];
    if (previous && previous.endMs == null) {
      previous.endMs = start.startMs;
    }
    list.push({
      index: list.length,
      startMs: start.startMs,
      endMs: null,
    });
    attempts.set(start.turn, list);
  }
  return attempts;
}

function findTurnAttemptIndex(attempts, turn, time) {
  const list = attempts.get(turn);
  if (!list?.length) {
    return 0;
  }
  let selected = list[0];
  for (const attempt of list) {
    if (time >= attempt.startMs && (attempt.endMs == null || time < attempt.endMs)) {
      return attempt.index;
    }
    if (time >= attempt.startMs) {
      selected = attempt;
    }
  }
  return selected.index;
}

function isCodexTimingActivity(record) {
  if (isUsageBaselineRecord(record)) {
    return false;
  }
  return record.eventType === "codex.session.token_count" ||
    record.eventType === "codex.task_complete" ||
    record.eventType === "codex.thread_goal_updated";
}

function isDurationSpanActivity(record) {
  if (isUsageBaselineRecord(record)) {
    return false;
  }
  return true;
}

function isLimitWaitEvent(record) {
  return record?.eventType === "claude.limit_wait" || record?.eventType === "ralph.limit_wait";
}

function durationText(span) {
  if (!span) return "";
  const milliseconds = Number.isFinite(span.durationMs)
    ? span.durationMs
    : span.first != null && span.last != null
      ? span.last - span.first
      : 0;
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function activeEventDurationMs(records, options = {}) {
  const includeOpenCommandTail = options.includeOpenCommandTail !== false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const events = records
    .map((record) => ({ record, time: Date.parse(record.recordedAt ?? "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  let durationMs = 0;
  let openCommands = 0;

  for (let i = 0; i < events.length; i += 1) {
    const record = events[i].record;
    if (isCommandStartEvent(record)) {
      openCommands += 1;
    } else if (isCommandEndEvent(record)) {
      openCommands = Math.max(0, openCommands - 1);
    }

    const next = events[i + 1];
    if (!next) {
      continue;
    }
    const gap = Math.max(0, next.time - events[i].time);
    if (openCommands > 0 || gap <= ACTIVE_EVENT_GAP_MS) {
      durationMs += gap;
    }
  }
  const last = events.at(-1);
  if (includeOpenCommandTail && openCommands > 0 && last) {
    durationMs += Math.max(0, nowMs - last.time);
  }

  return durationMs;
}

function isCommandStartEvent(record) {
  return record.eventType === "item.started" &&
    record.event?.item?.type === "command_execution";
}

function isCommandEndEvent(record) {
  return record.eventType === "item.completed" &&
    record.event?.item?.type === "command_execution";
}

function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function inferPriceModel(run = null) {
  const text = run
    ? `${run.id ?? ""} ${run.label ?? ""}`.toLowerCase()
    : `${state.selectedRun ?? ""} ${runSelect.selectedOptions?.[0]?.textContent ?? ""}`.toLowerCase();
  return [...API_PRICE_RATES.keys()]
    .sort((a, b) => b.length - a.length)
    .find((model) => text.includes(model)) ??
    API_PRICE_MODEL_ALIASES.find(([pattern]) => pattern.test(text))?.[1] ??
    null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.promptTokenCount ?? 0;
  const cached = usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? 0;
  const output =
    usage.output_tokens ??
    ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0));
  const reasoning =
    usage.reasoning_output_tokens ??
    usage.thinking_output_tokens ??
    usage.thoughtsTokenCount ??
    0;
  const total = usage.total_tokens ?? usage.totalTokenCount ?? input + output;
  const costUsd = Number(usage.cost_usd ?? usage.total_cost_usd) || 0;
  return {
    input_tokens: Math.max(0, input),
    cached_input_tokens: Math.max(0, cached),
    output_tokens: Math.max(0, output),
    reasoning_output_tokens: Math.max(0, reasoning),
    total_tokens: Math.max(0, total),
    cost_usd: Math.max(0, costUsd),
  };
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

function hasTokenUsage(usage) {
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
    cost_usd: Math.max(0, (a.cost_usd ?? 0) - (b.cost_usd ?? 0)),
  };
}

function usageDelta(current, previous) {
  if (!previous || usageCounterReset(current, previous)) {
    return normalizeUsage(current);
  }
  return subtractUsage(current, previous);
}

function usageCounterReset(current, previous) {
  const a = normalizeUsage(current);
  const b = normalizeUsage(previous);
  if (!a || !b) {
    return false;
  }
  // Only treat a genuine session restart (the cumulative counter collapsing
  // back toward a fresh start) as a reset. Some providers correct a live
  // estimate *downward* at turn end — e.g. Claude's result event reconciles the
  // summed per-step cache reads, so input_tokens dips while the running total
  // stays high. Counting that small dip as a reset makes usageDelta() re-add the
  // entire cumulative counter as one turn's delta, inflating run totals
  // quadratically (hundreds of millions / billions of "uncached" tokens).
  return a.total_tokens * 2 < b.total_tokens;
}

function usageWithCompletedCost(liveUsage, completedUsage) {
  const live = normalizeUsage(liveUsage);
  const completed = normalizeUsage(completedUsage);
  if (!hasTokenUsage(live)) {
    return completed;
  }
  if (completed?.cost_usd > 0 && sameTokenUsage(live, completed)) {
    return { ...live, cost_usd: completed.cost_usd };
  }
  return live;
}

function sameTokenUsage(left, right) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  return Boolean(
    a &&
      b &&
      a.input_tokens === b.input_tokens &&
      a.cached_input_tokens === b.cached_input_tokens &&
      a.output_tokens === b.output_tokens &&
      a.reasoning_output_tokens === b.reasoning_output_tokens &&
      a.total_tokens === b.total_tokens,
  );
}

function normalizeShapeUsage(shapeUsage) {
  const usage = normalizeUsage(shapeUsage?.usage);
  if (!usage) {
    return null;
  }
  return {
    ...shapeUsage,
    runCount: Number.isFinite(shapeUsage?.runCount) ? shapeUsage.runCount : 0,
    threadCount: Number.isFinite(shapeUsage?.threadCount) ? shapeUsage.threadCount : 0,
    durationMs: Number.isFinite(shapeUsage?.durationMs) ? shapeUsage.durationMs : 0,
    usage,
  };
}

function tokenCountRecords(records) {
  return records
    .filter((record) => record.eventType === "codex.session.token_count" && record.event?.usage)
    .sort((a, b) => String(a.recordedAt ?? "").localeCompare(String(b.recordedAt ?? "")));
}

function tokenCountThreadKey(record) {
  return eventThreadId(record) ?? "";
}

function eventThreadId(record) {
  return record?.threadId ??
    record?.event?.thread_id ??
    record?.event?.threadId ??
    record?.event?.goal?.threadId ??
    null;
}

function isUsageBaselineRecord(record) {
  return record?.eventType === "codex.session.token_count" &&
    (record?.event?.baseline === true || record?._usageBaseline === true);
}

function latestCumulativeUsage(records) {
  // buildUsageMap merges token_count-derived turns with turn.completed
  // fallback turns, so summing it covers mixed-provenance runs.
  let total = emptyUsage();
  for (const usage of buildUsageMap(records).values()) {
    total = addUsage(total, usage);
  }
  return hasTokenUsage(total) ? total : null;
}

function apiCostEstimate(usage, model) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return null;
  const rates = model ? API_PRICE_RATES.get(model) : null;
  const estimate = rates
    ? (Math.max(0, normalized.input_tokens - Math.min(normalized.cached_input_tokens, normalized.input_tokens)) * rates.input +
        Math.min(normalized.cached_input_tokens, normalized.input_tokens) * rates.cachedInput +
        normalized.output_tokens * rates.output) /
      1_000_000
    : null;
  // Prefer provider-reported cost when present. Claude turn results can report
  // substantially lower actual cost than a rough rate-card estimate from the
  // live token counters.
  const actual = normalized.cost_usd > 0 ? normalized.cost_usd : null;
  if (actual != null) {
    return actual;
  }
  return estimate;
}

function costEstimateText(usage, model, options = {}) {
  const estimate = apiCostEstimate(usage, model);
  if (estimate == null) {
    return model ? `${model}: n/a` : "n/a";
  }
  const prefix = options.includeModel && model ? `${model} ` : "";
  return `${prefix}${fmtUsd(estimate)}`;
}

function usageSummaryText(usage, model, options = {}) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return "";
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncachedInput = Math.max(0, normalized.input_tokens - cached);
  const primaryTokens = uncachedInput + normalized.output_tokens;
  const duration = Number.isFinite(options.durationMs) && options.durationMs > 0
    ? durationText({ durationMs: options.durationMs })
    : "";
  const explicitCost = Number(options.costUsd);
  const cost = Number.isFinite(explicitCost)
    ? `${options.includeModel && model ? `${model} ` : ""}${fmtUsd(explicitCost)}`
    : costEstimateText(normalized, model, { includeModel: options.includeModel });
  const parts = [];
  if (duration) {
    parts.push(duration);
  }
  parts.push(`${fmtInt(primaryTokens)} uncached tok`);
  if (cost !== "n/a") {
    parts.push(cost);
  }

  const details = [
    `${fmtInt(uncachedInput)} in`,
    `${fmtInt(normalized.output_tokens)} out`,
  ];
  if (cached) {
    details.push(`${fmtInt(cached)} cached`);
  }
  details.push(`${fmtInt(normalized.total_tokens)} total`);
  if (normalized.reasoning_output_tokens) {
    details.push(`${fmtInt(normalized.reasoning_output_tokens)} thinking`);
  }
  if (options.suffix) {
    details.push(options.suffix);
  }

  if (options.compact) {
    return `${parts.join(" / ")} (${details.join(", ")})`;
  }
  return `${parts.join(" / ")} <span class="muted">(${escapeHtml(details.join(", "))})</span>`;
}

function fullUsageText(usage, options = {}) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return "";
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncached = Math.max(0, normalized.input_tokens - cached);
  const parts = [
    `${fmtInt(uncached + normalized.output_tokens)} uncached tok`,
    `${fmtInt(uncached)} in`,
  ];
  if (cached) {
    parts.push(`${fmtInt(cached)} cached`);
  }
  parts.push(`${fmtInt(normalized.output_tokens)} out`);
  if (normalized.reasoning_output_tokens) {
    parts.push(`${fmtInt(normalized.reasoning_output_tokens)} thinking`);
  }
  if (options.includeCost) {
    const cost = costEstimateText(normalized, options.model);
    if (cost !== "n/a") parts.push(cost);
  }
  return parts.join(" / ");
}

function buildUsageMap(records) {
  const map = new Map();
  const tokenRecords = tokenCountRecords(records);
  // Turns covered by token_count records; other turns (e.g. recorded before a
  // provider emitted live token counts) fall back to turn.completed usage.
  const tokenTurns = new Set();
  if (tokenRecords.length) {
    const previousByThread = new Map();
    for (const record of tokenRecords) {
      const current = normalizeUsage(record.event.usage);
      const threadId = tokenCountThreadKey(record);
      if (isUsageBaselineRecord(record)) {
        previousByThread.set(threadId, current);
        continue;
      }
      const previous = previousByThread.get(threadId) ?? null;
      const delta = usageDelta(current, previous);
      previousByThread.set(threadId, current);
      if (!hasTokenUsage(delta)) continue;
      const turn = displayTurnForRecord(record);
      map.set(turn, addUsage(map.get(turn), delta));
      tokenTurns.add(turn);
    }
  }

  for (const r of records) {
    // turn.completed has usage (and, for Claude, the exact turn cost)
    if (r.eventType === "turn.completed" && r.event?.usage) {
      const turn = displayTurnForRecord(r);
      const usage = normalizeUsage(r.event.usage);
      if (tokenTurns.has(turn)) {
        map.set(turn, usageWithCompletedCost(map.get(turn), usage));
        continue;
      }
      map.set(turn, usage);
    }
    // Gemini: finished events have usageMetadata — accumulate per turn
    if (r.eventType === "finished" && r.event?.value?.usageMetadata) {
      const turn = displayTurnForRecord(r);
      if (tokenTurns.has(turn)) continue;
      const gm = r.event.value.usageMetadata;
      const prev = map.get(turn);
      const usage = normalizeUsage(gm);
      if (prev && prev._gemini) {
        // Accumulate across multiple finished events in same turn
        map.set(turn, { ...addUsage(prev, usage), _gemini: true });
      } else if (!prev) {
        map.set(turn, {
          _gemini: true,
          ...usage,
        });
      }
    }
  }
  return map;
}

function buildTestStatusMap(records) {
  const map = new Map();
  const ralphStatusTurns = new Set();
  const stageTotalAnchors = buildStageTotalAnchors(records);
  for (const r of records) {
    if (r.eventType === "ralph.test-status" && r.event?.testStatus) {
      const turn = displayTurnForRecord(r);
      map.set(turn, anchorTestStatusTotals(r.event.testStatus, stageTotalAnchors));
      ralphStatusTurns.add(turn);
    } else if (r.eventType === "ralph.phase-status" && r.event?.phaseStatus?.testStatus) {
      const turn = displayTurnForRecord(r);
      map.set(turn, anchorTestStatusTotals(r.event.phaseStatus.testStatus, stageTotalAnchors));
      ralphStatusTurns.add(turn);
    }
  }
  for (const r of records) {
    const item = r.event?.item;
    if (r.eventType !== "item.completed" || item?.type !== "command_execution") {
      continue;
    }
    const derived = deriveTestStatusFromCommand(r);
    if (!derived) {
      continue;
    }
    const turn = displayTurnForRecord(r);
    if (ralphStatusTurns.has(turn)) {
      continue;
    }
    map.set(turn, mergeTestStatus(map.get(turn), anchorTestStatusTotals(derived, stageTotalAnchors)));
  }
  return map;
}

function buildPhaseStatusMap(records) {
  const map = new Map();
  const successfulTests = new Map();
  for (const r of records) {
    const candidate = phaseStatusCandidateFromRecord(r);
    if (candidate) {
      const turn = displayTurnForRecord(r);
      const previous = map.get(turn);
      if (!previous || phaseStatusCandidateIsNewer(candidate, previous)) {
        map.set(turn, candidate);
      }
    }
    if (r.eventType === "ralph.test-status") {
      const target = successfulTestStatusTarget(r.event?.testStatus);
      if (target) {
        const turn = displayTurnForRecord(r);
        if (!successfulTests.has(turn)) {
          successfulTests.set(turn, new Set());
        }
        successfulTests.get(turn).add(phaseTargetKey(target));
      }
    }
  }
  synthesizeAdvancedPhaseCompletions(map, successfulTests);
  return new Map([...map.entries()].map(([turn, candidate]) => [turn, candidate.status]));
}

function latestPhaseStatus(records) {
  let selectedTurn = null;
  let selectedStatus = null;
  let selectedTime = 0;
  let selectedPriority = 0;
  for (const r of records) {
    const candidate = phaseStatusCandidateFromRecord(r);
    if (!candidate) {
      continue;
    }
    if (
      !selectedStatus ||
      candidate.time > selectedTime ||
      (candidate.time === selectedTime && candidate.priority >= selectedPriority)
    ) {
      selectedTurn = displayTurnForRecord(r);
      selectedStatus = candidate.status;
      selectedTime = candidate.time;
      selectedPriority = candidate.priority;
    }
  }
  return selectedStatus == null ? null : { turn: selectedTurn, status: selectedStatus };
}

function phaseStatusCandidateFromRecord(record) {
  const time = sortableRecordTime(record);
  if (record.eventType === "ralph.phase-status" && record.event?.phaseStatus) {
    return {
      priority: 2,
      status: record.event.phaseStatus,
      action: record.event.action ?? null,
      time,
    };
  }
  if (record.eventType === "ralph.prompt") {
    const inferred = inferPhaseStatusFromPrompt(record.event?.prompt);
    return inferred ? { priority: 1, status: inferred, action: null, time } : null;
  }
  return null;
}

function phaseStatusCandidateIsNewer(candidate, previous) {
  return (
    candidate.priority > previous.priority ||
    (candidate.priority === previous.priority && candidate.time >= previous.time)
  );
}

function sortableRecordTime(record) {
  const time = Date.parse(record?.recordedAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

function synthesizeAdvancedPhaseCompletions(map, successfulTests) {
  for (const [turn, candidate] of map) {
    if (
      candidate.status?.allRequiredPassed ||
      candidate.action === "checked" ||
      !phaseAdvancedAfterTurn(turn, candidate.status, map)
    ) {
      continue;
    }
    const target = phaseStatusTarget(candidate.status);
    if (!target || !successfulTests.get(turn)?.has(phaseTargetKey(target))) {
      continue;
    }
    candidate.status = completedPhaseStatus(candidate.status);
  }
}

function phaseAdvancedAfterTurn(turn, status, map) {
  if (!Number.isInteger(turn)) {
    return false;
  }
  const nextTurn = [...map.keys()]
    .filter((candidateTurn) => Number.isInteger(candidateTurn) && candidateTurn > turn)
    .sort((a, b) => a - b)
    .at(0);
  if (nextTurn == null) {
    return false;
  }

  const currentTarget = phaseStatusTarget(status);
  const nextStatus = map.get(nextTurn)?.status;
  const nextTarget = phaseStatusTarget(nextStatus);
  if (!currentTarget || !nextTarget) {
    return false;
  }

  const currentStageNumber = stageNumber(currentTarget.stage);
  const nextStageNumber = stageNumber(nextTarget.stage);
  if (currentStageNumber != null && nextStageNumber != null && nextStageNumber > currentStageNumber) {
    return true;
  }

  return (
    nextTarget.stage === currentTarget.stage &&
    nextTarget.subset === currentTarget.subset &&
    cleanText(nextStatus?.phase) !== cleanText(status?.phase)
  );
}

function successfulTestStatusTarget(status) {
  if (!status?.allTestsPassed || status.exitCode !== 0) {
    return null;
  }
  const stage = normalizeStageName(status.targetStage ?? status.passingThrough);
  if (!stage) {
    return null;
  }
  return { stage, subset: normalizeOptionalText(status.targetSubset) };
}

function phaseStatusTarget(status) {
  const stage = normalizeStageName(
    status?.stage ??
    status?.testStatus?.targetStage ??
    status?.primaryCheck?.targetStage,
  );
  if (!stage) {
    return null;
  }
  return {
    stage,
    subset: normalizeOptionalText(
      status?.subset ??
      status?.testStatus?.targetSubset ??
      status?.primaryCheck?.targetSubset,
    ),
  };
}

function phaseTargetKey(target) {
  return `${target.stage}\0${target.subset}`;
}

function completedPhaseStatus(status) {
  const checks = (status.checks ?? []).map((check) => ({
    ...check,
    passed: true,
    exitCode: check.exitCode === 0 ? check.exitCode : 0,
  }));
  return {
    ...status,
    checks: checks.length > 0 ? checks : [{ name: "tests", required: true, passed: true, exitCode: 0 }],
    allRequiredPassed: true,
    failedRequiredChecks: [],
    inferredCompletion: true,
  };
}

function inferPhaseStatusFromPrompt(prompt) {
  const text = cleanText(prompt);
  if (!text) {
    return null;
  }
  const phase =
    text.match(/^- Current phase:\s*`([^`]+)`/m)?.[1] ??
    text.match(/^You are in the ([A-Za-z0-9._-]+) phase\b/m)?.[1] ??
    null;
  const stage =
    text.match(/^- Current stage:\s*`(pa\d+)`/m)?.[1] ??
    text.match(/^You are in the [A-Za-z0-9._-]+ phase for `(pa\d+)`/m)?.[1] ??
    null;
  const checkLine = text.match(/^Phase checks \(([^)]+)\):\s*(.+)$/m);
  const checkPhase = checkLine?.[1] ?? null;
  const checks = parsePhaseCheckLine(checkLine?.[2] ?? "");

  if (!phase && !checkPhase && !stage && checks.length === 0) {
    return null;
  }

  const failedRequiredChecks = checks.filter((check) => check.required && !check.passed);
  return {
    phase: phase ?? checkPhase ?? "unknown",
    stage,
    checks,
    allRequiredPassed: checks.length > 0 ? failedRequiredChecks.length === 0 : false,
    failedRequiredChecks,
    inferred: true,
  };
}

function parsePhaseCheckLine(line) {
  return String(line ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^([A-Za-z0-9._-]+)\s+(pass|fail)\s+\((-?\d+)\)$/i);
      if (!match) {
        return null;
      }
      const passed = match[2].toLowerCase() === "pass";
      return {
        name: match[1],
        kind: null,
        required: true,
        primary: false,
        exitCode: Number.parseInt(match[3], 10),
        passed,
      };
    })
    .filter(Boolean);
}

function mergeTestStatus(existing, derived) {
  if (!existing) return derived;
  if ((existing.testsTotal ?? 0) === 0 && (derived.testsTotal ?? 0) > 0) {
    return { ...existing, ...derived };
  }
  if (derived.allTestsPassed && !existing.allTestsPassed) {
    return { ...existing, ...derived };
  }
  if ((derived.testsTotal ?? 0) >= (existing.testsTotal ?? 0)) {
    return { ...existing, ...derived };
  }
  return existing;
}

function buildStageTotalAnchors(records) {
  const anchors = new Map();
  for (const record of records) {
    for (const status of testStatusesFromRecord(record)) {
      addStageTotalAnchorsFromStatus(anchors, status);
    }
  }
  return anchors;
}

function testStatusesFromRecord(record) {
  const statuses = [];
  if (record.event?.testStatus) {
    statuses.push(record.event.testStatus);
  }
  if (record.event?.phaseStatus?.testStatus) {
    statuses.push(record.event.phaseStatus.testStatus);
  }
  for (const check of record.event?.phaseStatus?.checks ?? []) {
    if (check?.testStatus) {
      statuses.push(check.testStatus);
    }
  }
  return statuses;
}

function addStageTotalAnchorsFromStatus(anchors, status) {
  if (!isFullStageTestStatus(status)) {
    return;
  }
  const stages = Array.isArray(status?.stages) ? status.stages : [];
  for (const stage of stages) {
    if (stage?.status === "pass" && finitePositiveNumber(stage.total) && stage.passed === stage.total) {
      updateStageTotalAnchor(anchors, stage.name, stage.total);
    }
  }
  addInferredStageTotalAnchor(anchors, status);
}

function addInferredStageTotalAnchor(anchors, status) {
  const stages = Array.isArray(status?.stages) ? status.stages : [];
  const testsTotal = finitePositiveNumber(status?.testsTotal);
  if (!stages.length || !testsTotal) {
    return;
  }
  const targetStage =
    normalizeStageName(status?.targetStage) ??
    normalizeStageName(status?.failingStage) ??
    stages.find((stage) => stage?.status === "fail")?.name ??
    stages.at(-1)?.name;
  const targetIndex = stages.findIndex((stage) => stage?.name === targetStage);
  if (targetIndex < 0) {
    return;
  }
  let knownOtherTotal = 0;
  for (const [index, stage] of stages.entries()) {
    if (index === targetIndex) {
      continue;
    }
    const total = finitePositiveNumber(stage?.total) ?? anchors.get(stage?.name);
    if (!total) {
      return;
    }
    knownOtherTotal += total;
  }
  const inferredTotal = testsTotal - knownOtherTotal;
  if (inferredTotal > 0) {
    updateStageTotalAnchor(anchors, targetStage, Math.max(inferredTotal, stages[targetIndex]?.total ?? 0));
  }
}

function updateStageTotalAnchor(anchors, stage, total) {
  const normalized = normalizeStageName(stage);
  if (!normalized || !Number.isFinite(total) || total <= 0) {
    return;
  }
  const previous = anchors.get(normalized) ?? 0;
  if (total > previous) {
    anchors.set(normalized, total);
  }
}

function anchorTestStatusTotals(status, anchors) {
  if (!status || !isFullStageTestStatus(status) || !(anchors instanceof Map) || anchors.size === 0) {
    return status;
  }
  const stages = Array.isArray(status.stages) ? status.stages : [];
  let changed = false;
  const anchoredStages = stages.map((stage) => {
    const anchor = anchors.get(stage?.name);
    if (!anchor || anchor <= (stage?.total ?? 0)) {
      return stage;
    }
    changed = true;
    return {
      ...stage,
      total: anchor,
      passed: stage?.status === "pass" ? anchor : Math.min(stage?.passed ?? 0, anchor),
    };
  });
  if (!changed) {
    return status;
  }
  const stageTotal = anchoredStages.reduce((sum, stage) => sum + (stage.total ?? 0), 0);
  const stagePassed = anchoredStages.reduce((sum, stage) => sum + (stage.passed ?? 0), 0);
  return {
    ...status,
    testsPassed: Math.max(status.testsPassed ?? 0, stagePassed),
    testsTotal: Math.max(status.testsTotal ?? 0, stageTotal),
    stages: anchoredStages,
  };
}

function isFullStageTestStatus(status) {
  return !cleanText(status?.targetSubset);
}

function testStatusHasSubset(status) {
  return Boolean(cleanText(status?.targetSubset));
}

function normalizeStageName(stage) {
  return typeof stage === "string" && /^pa\d+$/.test(stage) ? stage : null;
}

function deriveTestStatusFromCommand(record) {
  const item = record.event?.item ?? {};
  const command = unwrapCommand(item.command ?? "");
  const output = cleanText(item.aggregated_output);
  if (!output || !parseAgentTestCommand(command)) {
    return null;
  }

  const summary = parseTestReportSummary(output);
  if (!summary) {
    return null;
  }

  const stageSections = parseStageSections(output);
  const stageNames = stageSections.map(stage => stage.name);
  const firstFailureLine = findFirstFailureLine(output) ?? null;
  const failingStage = inferFailureStage(firstFailureLine, stageSections);
  const failingIndex = failingStage ? stageNames.indexOf(failingStage) : -1;
  const stageCount = stageNames.length;
  const canInferPassingThrough = isContiguousStagePrefix(stageNames);
  const stages = stageSections.map((stage, index) => {
    const failureLines = extractStageFailureLines(stage.body);
    const failed = failureLines.length;
    return {
      name: stage.name,
      status: summary.allTestsPassed ? "pass" : failed > 0 ? "fail" : index < failingIndex ? "pass" : "unknown",
      passed: 0,
      total: 0,
      failed,
      timeouts: failureLines.filter(line => classifyFailureLine(line) === "timeout").length,
      timeoutExpectations: failureLines.filter(line => classifyFailureLine(line) === "timeout_expected").length,
      targets: [],
    };
  });
  const timeoutFailures = stages.reduce((sum, stage) => sum + (stage.timeouts ?? 0), 0);
  const timeoutExpectationFailures = stages.reduce(
    (sum, stage) => sum + (stage.timeoutExpectations ?? 0),
    0,
  );
  const stagesPassed = stages.filter(stage => stage.status === "pass").length;
  const passingThrough = canInferPassingThrough && summary.allTestsPassed
    ? stageNames.at(-1) ?? null
    : canInferPassingThrough && failingIndex > 0
      ? stageNames[failingIndex - 1]
      : null;

  return {
    recordedAt: record.recordedAt,
    command,
    exitCode: item.exit_code ?? null,
    allTestsPassed: summary.allTestsPassed,
    testsPassed: summary.testsPassed,
    testsTotal: summary.testsTotal,
    stageCount,
    stagesPassed,
    failingStage,
    passingThrough,
    firstFailureLine,
    firstFailureKind: classifyFailureLine(firstFailureLine),
    timeoutFailures,
    timeoutExpectationFailures,
    stages,
  };
}

function parseStageSections(output) {
  const headers = [...output.matchAll(/^===== (pa\d+) =====$/gm)].map(match => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  return headers.map((header, index) => ({
    name: header.name,
    body: output.slice(header.index, index + 1 < headers.length ? headers[index + 1].index : output.length),
  }));
}

function countStageFailureLines(body) {
  return extractStageFailureLines(body).length;
}

function extractStageFailureLines(body) {
  return body.split(/\r?\n/).filter(isTestFailureLine);
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

function inferFailureStage(line, stageSections) {
  const explicit = line?.match(/^(pa\d+)\//)?.[1];
  if (explicit) {
    return explicit;
  }
  if (!line) {
    return null;
  }
  return stageSections.find(stage => stage.body.includes(line))?.name ?? null;
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

function parseTestReportSummary(output) {
  const allPassed = output.match(
    /^===== ALL TESTS PASSED SUCCESSFULLY!(?: \((\d+)\s*\/\s*(\d+)\))? =====$/m,
  );
  if (allPassed) {
    const testsPassed = parseOptionalInt(allPassed[1]);
    const testsTotal = parseOptionalInt(allPassed[2]);
    return {
      allTestsPassed: true,
      testsPassed: testsPassed ?? testsTotal ?? 0,
      testsTotal: testsTotal ?? testsPassed ?? 0,
    };
  }

  const summary = output.match(/^===== TEST SUMMARY: (\d+)\s*\/\s*(\d+) TESTS PASSED =====$/m);
  if (!summary) {
    return null;
  }
  return {
    allTestsPassed: false,
    testsPassed: Number.parseInt(summary[1], 10),
    testsTotal: Number.parseInt(summary[2], 10),
  };
}

function parseOptionalInt(value) {
  if (value == null) return null;
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

function buildAgentTestProgressState(records) {
  const stageTotalAnchors = buildStageTotalAnchors(records);
  const tracker = {
    stageTotals: new Map(stageTotalAnchors),
    stageBest: new Map(),
    turnTargets: buildAgentProgressTargets(records, stageTotalAnchors),
    latest: null,
  };
  const byTurn = new Map();

  for (const record of records) {
    seedAgentTestProgressTracker(tracker, record);
    const seededObservation =
      deriveCachedAgentTestProgress(record) ??
      deriveRalphTestProgress(record, tracker);
    if (seededObservation) {
      const progress = applyAgentTestProgressObservation(tracker, seededObservation);
      if (progress) {
        byTurn.set(progress.turn, progress);
      }
    }

    const item = record.event?.item;
    if (record.eventType !== "item.completed" || item?.type !== "command_execution") {
      continue;
    }

    const commandInfo = parseAgentTestCommand(item.command ?? "");
    if (!commandInfo) {
      continue;
    }

    const observation = deriveAgentTestProgress(record, commandInfo, tracker);
    if (!observation) {
      continue;
    }

    const progress = applyAgentTestProgressObservation(tracker, observation);
    if (!progress) {
      continue;
    }
    byTurn.set(progress.turn, progress);
  }

  return { byTurn, latest: tracker.latest };
}

function applyProgressBestCache(progressState, run = null) {
  if (!progressState) {
    return progressState;
  }
  const runKey = progressBestRunKey(run);
  if (!runKey) {
    return progressState;
  }

  let changed = false;
  let cacheChanged = false;
  const byTurn = new Map();
  for (const [turn, progress] of progressState.byTurn ?? []) {
    const { progress: updated, cacheChanged: updatedCache } = mergeProgressBestCache(runKey, progress);
    byTurn.set(turn, updated);
    cacheChanged = cacheChanged || updatedCache;
    if (updated !== progress) {
      changed = true;
    }
  }

  let latest = progressState.latest;
  if (latest) {
    const { progress: updated, cacheChanged: updatedCache } = mergeProgressBestCache(runKey, latest);
    cacheChanged = cacheChanged || updatedCache;
    if (updated !== latest) {
      latest = updated;
      changed = true;
    }
  }

  if (cacheChanged) {
    saveProgressBestCache();
  }

  return changed ? { ...progressState, byTurn, latest } : progressState;
}

function mergeProgressBestCache(runKey, progress) {
  const cacheKey = progressBestCacheKey(runKey, progress);
  if (!cacheKey) {
    return { progress, cacheChanged: false };
  }

  const candidate = progressBestCandidate(progress);
  let cached = state.progressBestCache.get(cacheKey) ?? null;
  let cacheChanged = false;
  if (isBetterProgressBest(candidate, cached)) {
    cached = {
      ...candidate,
      updatedAt: new Date().toISOString(),
    };
    state.progressBestCache.set(cacheKey, cached);
    cacheChanged = true;
  }

  if (!cached || !isBetterProgressBest(cached, progress.best)) {
    return { progress, cacheChanged };
  }
  return { progress: {
    ...progress,
    best: {
      passed: cached.passed,
      total: cached.total,
      recordedAt: cached.recordedAt ?? cached.updatedAt ?? progress.recordedAt ?? null,
    },
  }, cacheChanged };
}

function progressBestRunKey(run) {
  return cleanText(run?.id ?? state.selectedRun);
}

function progressBestCacheKey(runKey, progress) {
  if (!runKey || !progress || !Number.isInteger(progress.turn) || !progress.stage) {
    return null;
  }
  const total = finitePositiveNumber(progress.current?.total) ?? finitePositiveNumber(progress.best?.total);
  if (!total) {
    return null;
  }
  return `${runKey}\0${progress.turn}\0${progress.stage}\0${total}`;
}

function progressBestCandidate(progress) {
  const best = progress?.best ?? progress?.current ?? null;
  const current = progress?.current ?? null;
  const bestPassed = Number.isFinite(best?.passed) ? best.passed : -1;
  const currentPassed = Number.isFinite(current?.passed) ? current.passed : -1;
  const source = currentPassed > bestPassed ? current : best;
  const total = finitePositiveNumber(source?.total) ?? finitePositiveNumber(best?.total) ?? finitePositiveNumber(current?.total);
  if (!source || !total) {
    return null;
  }
  return {
    passed: Math.max(0, source.passed ?? 0),
    total,
    recordedAt: source.recordedAt ?? progress?.recordedAt ?? null,
  };
}

function isBetterProgressBest(candidate, previous) {
  if (!candidate) {
    return false;
  }
  if (!previous) {
    return true;
  }
  if ((candidate.total ?? 0) !== (previous.total ?? 0)) {
    return false;
  }
  if ((candidate.passed ?? 0) !== (previous.passed ?? 0)) {
    return (candidate.passed ?? 0) > (previous.passed ?? 0);
  }
  const candidateTime = Date.parse(candidate.recordedAt ?? candidate.updatedAt ?? "");
  const previousTime = Date.parse(previous.recordedAt ?? previous.updatedAt ?? "");
  return Number.isFinite(candidateTime) &&
    (!Number.isFinite(previousTime) || candidateTime > previousTime);
}

function loadProgressBestCache() {
  try {
    const raw = window.localStorage.getItem(PROGRESS_BEST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return new Map(entries.filter(([key, value]) => typeof key === "string" && value));
  } catch (_) {
    return new Map();
  }
}

function saveProgressBestCache() {
  pruneProgressBestCache();
  try {
    window.localStorage.setItem(PROGRESS_BEST_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [...state.progressBestCache.entries()],
    }));
  } catch (_) {}
}

function pruneProgressBestCache() {
  if (state.progressBestCache.size <= PROGRESS_BEST_CACHE_LIMIT) {
    return;
  }
  const entries = [...state.progressBestCache.entries()].sort((a, b) => {
    const aTime = Date.parse(a[1]?.updatedAt ?? a[1]?.recordedAt ?? "");
    const bTime = Date.parse(b[1]?.updatedAt ?? b[1]?.recordedAt ?? "");
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
  state.progressBestCache = new Map(entries.slice(0, PROGRESS_BEST_CACHE_LIMIT));
}

function buildAgentProgressTargets(records, stageTotalAnchors = new Map()) {
  const targets = new Map();
  const turnsWithPhaseTargets = new Set();
  for (const record of records) {
    const target = progressPhaseTargetFromRecord(record, stageTotalAnchors);
    if (!target) {
      continue;
    }
    const turn = displayTurnForRecord(record);
    turnsWithPhaseTargets.add(turn);
    targets.set(progressTargetKey(turn, target.stage), target);
  }

  for (const record of records) {
    if (record.eventType === "ralph.phase-status" || turnsWithPhaseTargets.has(displayTurnForRecord(record))) {
      continue;
    }
    const target = progressTargetFromRecord(record, stageTotalAnchors);
    if (target) {
      targets.set(progressTargetKey(displayTurnForRecord(record), target.stage), target);
    }
  }
  return targets;
}

function deriveRalphTestProgress(record, tracker) {
  const testStatus = anchorTestStatusTotals(ralphTestStatusFromRecord(record), tracker.stageTotals);
  if (!testStatus) {
    return null;
  }
  const turn = displayTurnForRecord(record);
  const target = progressTargetFromTestStatus(testStatus, record.event?.phaseStatus?.stage);
  if (!target) {
    return null;
  }
  const configured = tracker.turnTargets.get(progressTargetKey(turn, target.stage));
  if (!configured) {
    return null;
  }
  const progress = progressFromTestStatus(testStatus, configured.stage, tracker);
  if (record.eventType === "ralph.phase-status" && record.event?.action === "turn-start") {
    return {
      stage: configured.stage,
      stageNumber: stageNumber(configured.stage),
      commandKind: "ralph",
      commandTarget: "phase start",
      turn,
      recordedAt: record.recordedAt,
      status: "running",
      passed: Math.max(0, Math.min(progress.passed, configured.total)),
      total: configured.total,
    };
  }
  return {
    stage: configured.stage,
    stageNumber: stageNumber(configured.stage),
    commandKind: "ralph",
    commandTarget: "ralph required status",
    turn,
    recordedAt: testStatus.recordedAt ?? record.recordedAt,
    status: progress.status,
    passed: Math.max(0, Math.min(progress.passed, configured.total)),
    total: configured.total,
  };
}

function deriveCachedAgentTestProgress(record) {
  if (record.eventType !== "ralph.agent-progress") {
    return null;
  }
  const raw = record.event?.progress;
  const stage = normalizeStageName(raw?.stage);
  const total = finitePositiveNumber(raw?.total);
  if (!stage || !total) {
    return null;
  }
  return {
    stage,
    stageNumber: stageNumber(stage),
    commandKind: cleanText(raw?.commandKind) || "session-cache",
    commandTarget: cleanText(raw?.commandTarget) || "cached test summary",
    hasSubset: raw?.hasSubset === true,
    turn: displayTurnForRecord(record),
    recordedAt: raw?.recordedAt ?? record.recordedAt,
    status: raw?.status === "pass" ? "pass" : raw?.status === "running" ? "running" : "fail",
    passed: Math.max(0, Math.min(raw?.passed ?? 0, total)),
    total,
  };
}

function progressTargetFromRecord(record, stageTotalAnchors) {
  const testStatus = anchorTestStatusTotals(ralphTestStatusFromRecord(record), stageTotalAnchors);
  if (!testStatus) {
    return null;
  }
  return progressTargetFromTestStatus(testStatus, record.event?.phaseStatus?.stage);
}

function progressPhaseTargetFromRecord(record, stageTotalAnchors) {
  if (record.eventType === "ralph.phase-status") {
    return progressTargetFromRecord(record, stageTotalAnchors);
  }
  const phaseTarget = phaseStatusTarget(phaseStatusCandidateFromRecord(record)?.status);
  const total = phaseTarget ? stageTotalAnchors.get(phaseTarget.stage) : null;
  return phaseTarget && total > 0
    ? { stage: phaseTarget.stage, total, recordedAt: record.recordedAt ?? null }
    : null;
}

function ralphTestStatusFromRecord(record) {
  if (record.eventType === "ralph.test-status") {
    return record.event?.testStatus ?? null;
  }
  if (record.eventType === "ralph.phase-status") {
    return record.event?.phaseStatus?.testStatus ?? null;
  }
  return null;
}

function progressTargetFromTestStatus(testStatus, phaseStage = null) {
  const stages = Array.isArray(testStatus?.stages) ? testStatus.stages : [];
  const normalizedPhaseStage = normalizeStageName(phaseStage);
  const phaseStageMatchesStatus =
    normalizedPhaseStage &&
    (stages.length === 0 || stages.some((candidate) => candidate?.name === normalizedPhaseStage));
  const stage =
    (phaseStageMatchesStatus ? normalizedPhaseStage : null) ??
    normalizeStageName(testStatus?.targetStage) ??
    normalizeStageName(testStatus?.failingStage) ??
    (stages.length === 1
      ? normalizeStageName(stages[0]?.name)
      : null);
  if (!stage) {
    return null;
  }
  const stageStatus = stages.find((candidate) => candidate?.name === stage);
  const total = testStatusHasSubset(testStatus) && normalizeStageName(testStatus?.targetStage) === stage
    ? finitePositiveNumber(testStatus?.testsTotal) ?? finitePositiveNumber(stageStatus?.total)
    : finitePositiveNumber(stageStatus?.total) ?? finitePositiveNumber(testStatus?.testsTotal);
  if (!total) {
    return null;
  }
  return {
    stage,
    total,
    recordedAt: testStatus.recordedAt ?? null,
  };
}

function progressFromTestStatus(testStatus, stage, tracker) {
  if (
    testStatusHasSubset(testStatus) &&
    normalizeStageName(testStatus?.targetStage) === stage &&
    finitePositiveNumber(testStatus?.testsTotal)
  ) {
    return {
      passed: Math.max(0, testStatus?.testsPassed ?? 0),
      status: testStatus?.allTestsPassed ? "pass" : "fail",
    };
  }
  const stageStatus = Array.isArray(testStatus?.stages)
    ? testStatus.stages.find((candidate) => candidate?.name === stage)
    : null;
  if (stageStatus) {
    const passed = stagePassedCount(stageStatus);
    return {
      passed: passed ?? inferredStagePassedFromThroughStatus(testStatus, stage, tracker) ?? 0,
      status: stageStatus.status === "pass" || testStatus.allTestsPassed ? "pass" : "fail",
    };
  }
  return {
    passed: inferredStagePassedFromThroughStatus(testStatus, stage, tracker) ??
      Math.max(0, testStatus?.testsPassed ?? 0),
    status: testStatus?.allTestsPassed ? "pass" : "fail",
  };
}

function inferredStagePassedFromThroughStatus(testStatus, stage, tracker) {
  if ((testStatus?.stageCount ?? 0) <= 1) {
    return null;
  }
  const number = stageNumber(stage);
  const priorTotal = number ? knownPriorStageTotal(tracker, number) : null;
  if (priorTotal == null || !Number.isFinite(testStatus?.testsPassed)) {
    return null;
  }
  return Math.max(0, testStatus.testsPassed - priorTotal);
}

function progressTargetKey(turn, stage) {
  return `${turn}:${stage}`;
}

function seedAgentTestProgressTracker(tracker, record) {
  if (record.eventType !== "ralph.test-status") {
    return;
  }
  const testStatus = record.event?.testStatus;
  if (!isFullStageTestStatus(testStatus)) {
    return;
  }
  const stages = testStatus?.stages;
  if (!Array.isArray(stages)) {
    return;
  }
  if (!hasTrustworthyStageTotals(testStatus)) {
    return;
  }
  for (const stage of stages) {
    updateKnownStageTotal(tracker, stage?.name, stage?.total);
  }
}

function hasTrustworthyStageTotals(testStatus) {
  const stages = testStatus?.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    return false;
  }
  const positiveStages = stages.filter((stage) => Number.isFinite(stage?.total) && stage.total > 0);
  if (positiveStages.length === 0) {
    return false;
  }
  if (stages.length > 1 && positiveStages.length < stages.length) {
    return false;
  }
  const positiveTotal = positiveStages.reduce((sum, stage) => sum + stage.total, 0);
  const testsTotal = testStatus?.testsTotal;
  return !Number.isFinite(testsTotal) || testsTotal <= 0 || positiveTotal <= testsTotal;
}

function parseAgentTestCommand(command) {
  const text = unwrapCommand(command).replace(/\s+\(continued session \d+\)\s*$/, "");
  let match = text.match(/\bmake\b[\s\S]*?\btest-report-through-pa(\d+)\b/);
  if (match) {
    const number = Number.parseInt(match[1], 10);
    return {
      kind: "through",
      stage: `pa${number}`,
      stageNumber: number,
      target: `test-report-through-pa${number}`,
      hasSubset: false,
    };
  }

  match = text.match(/\bmake\b[\s\S]*?\btest-report\b/);
  if (match) {
    const stages = parseActiveTestReportStages(text);
    if (stages.length > 0) {
      const lastStage = stages.at(-1);
      return {
        kind: "selected",
        stage: lastStage,
        stageNumber: stageNumber(lastStage),
        stages,
        target: `test-report ${stages.join(" ")}`,
        hasSubset: hasTestGlob(text),
      };
    }
  }

  match = text.match(/\bmake\b[\s\S]*?\btest-pa(\d+)\b/);
  if (!match) {
    return null;
  }
  const number = Number.parseInt(match[1], 10);
  return {
    kind: "single",
    stage: `pa${number}`,
    stageNumber: number,
    target: `test-pa${number}`,
    hasSubset: false,
  };
}

function parseActiveTestReportStages(text) {
  const match = text.match(/\bACTIVE_TEST_REPORT_PAS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return [...raw.matchAll(/\bpa\d+\b/g)].map((stage) => stage[0]);
}

function hasTestGlob(text) {
  return /\bGLOB\s*=/.test(text);
}

function deriveAgentTestProgress(record, commandInfo, tracker) {
  const item = record.event?.item ?? {};
  const output = cleanText(item.aggregated_output);
  if (!output) {
    return null;
  }

  const stageProgress = parseStageProgressFromAgentOutput(output, commandInfo.stage);
  const direct = stageProgress.get(commandInfo.stage);
  if (direct?.total > 0) {
    return buildAgentTestProgressObservation(record, commandInfo, direct);
  }

  if (commandInfo.kind === "selected") {
    const selectedProgress = (commandInfo.stages ?? [])
      .map((stage) => stageProgress.get(stage))
      .filter((progress) => progress?.total > 0);
    const selected =
      selectedProgress.find((progress) => progress.status === "fail") ??
      selectedProgress.at(-1);
    if (selected) {
      return buildAgentTestProgressObservation(
        record,
        {
          ...commandInfo,
          stage: selected.stage,
          stageNumber: stageNumber(selected.stage),
        },
        selected,
      );
    }

    const summaryProgress = inferSelectedReportSummaryProgress(
      output,
      commandInfo,
      tracker,
      item.exit_code,
    );
    if (summaryProgress) {
      return buildAgentTestProgressObservation(
        record,
        {
          ...commandInfo,
          stage: summaryProgress.stage,
          stageNumber: stageNumber(summaryProgress.stage),
        },
        summaryProgress,
      );
    }
  }

  if (commandInfo.kind !== "through") {
    return null;
  }

  const summary = parseTestReportSummary(output);
  if (!summary) {
    return null;
  }
  const priorTotal = knownPriorStageTotal(tracker, commandInfo.stageNumber);
  if (priorTotal == null) {
    return null;
  }

  const passed = Math.max(0, summary.testsPassed - priorTotal);
  const anchoredTotal = tracker.stageTotals.get(commandInfo.stage) ?? 0;
  const total = Math.max(passed, summary.testsTotal - priorTotal, anchoredTotal);
  if (total <= 0) {
    return null;
  }

  return buildAgentTestProgressObservation(record, commandInfo, {
    stage: commandInfo.stage,
    passed,
    total,
    status: summary.allTestsPassed || (item.exit_code === 0 && passed === total) ? "pass" : "fail",
  });
}

function buildAgentTestProgressObservation(record, commandInfo, progress) {
  return {
    stage: commandInfo.stage,
    stageNumber: commandInfo.stageNumber,
    commandKind: commandInfo.kind,
    commandTarget: commandInfo.target,
    hasSubset: commandInfo.hasSubset === true,
    turn: displayTurnForRecord(record),
    recordedAt: record.recordedAt,
    status: progress.status,
    passed: Math.max(0, progress.passed ?? 0),
    total: Math.max(0, progress.total ?? 0),
  };
}

function inferSelectedReportSummaryProgress(output, commandInfo, tracker, exitCode) {
  const summary = parseTestReportSummary(output);
  if (!summary) {
    return null;
  }

  const stages = normalizeSelectedReportStages(output, commandInfo);
  if (stages.length === 0) {
    return null;
  }

  if (stages.length === 1) {
    const anchoredTotal = commandInfo.hasSubset ? 0 : tracker.stageTotals.get(stages[0]) ?? 0;
    const total = Math.max(summary.testsTotal, anchoredTotal);
    return {
      stage: stages[0],
      passed: Math.min(summary.testsPassed, total),
      total,
      status: summaryProgressStatus(summary, exitCode),
    };
  }

  const inferred = inferMultiStageSelectedProgress(output, stages, summary, tracker);
  if (inferred.length > 0) {
    return inferred.find((progress) => progress.status === "fail") ?? inferred.at(-1);
  }

  return {
    stage: commandInfo.stage,
    passed: summary.testsPassed,
    total: summary.testsTotal,
    status: summaryProgressStatus(summary, exitCode),
  };
}

function normalizeSelectedReportStages(output, commandInfo) {
  const configured = Array.isArray(commandInfo.stages) ? commandInfo.stages.filter(Boolean) : [];
  if (configured.length > 0) {
    return configured;
  }
  return parseStageSections(output).map((section) => section.name);
}

function inferMultiStageSelectedProgress(output, stages, summary, tracker) {
  const failuresByStage = new Map(
    parseStageSections(output).map((section) => [section.name, countStageFailureLines(section.body)]),
  );
  const inferred = [];
  let knownTotal = 0;
  const unknownStages = [];

  for (const stage of stages) {
    const total = tracker.stageTotals.get(stage);
    if (Number.isFinite(total) && total > 0) {
      knownTotal += total;
      inferred.push(buildKnownStageSummaryProgress(stage, total, failuresByStage, summary));
    } else {
      unknownStages.push(stage);
    }
  }

  if (unknownStages.length === 1) {
    const total = Math.max(0, summary.testsTotal - knownTotal);
    if (total > 0) {
      inferred.push(buildKnownStageSummaryProgress(unknownStages[0], total, failuresByStage, summary));
    }
  }

  return inferred.filter((progress) => progress.total > 0);
}

function buildKnownStageSummaryProgress(stage, total, failuresByStage, summary) {
  const failed = Math.max(0, failuresByStage.get(stage) ?? 0);
  return {
    stage,
    passed: summary.allTestsPassed ? total : Math.max(0, total - failed),
    total,
    status: summary.allTestsPassed || failed === 0 ? "pass" : "fail",
  };
}

function summaryProgressStatus(summary, exitCode) {
  return summary.allTestsPassed || (exitCode === 0 && summary.testsPassed === summary.testsTotal)
    ? "pass"
    : "fail";
}

function applyAgentTestProgressObservation(tracker, observation) {
  const target = tracker.turnTargets.get(progressTargetKey(observation.turn, observation.stage));
  if (!target && turnHasConfiguredProgressTarget(tracker, observation.turn)) {
    return null;
  }
  if (target && observation.total !== target.total) {
    return null;
  }
  if (!target && !observation.hasSubset) {
    updateKnownStageTotal(tracker, observation.stage, observation.total);
  }

  const knownTotal =
    target?.total ??
    (observation.hasSubset
      ? observation.total
      : Math.max(observation.total, tracker.stageTotals.get(observation.stage) ?? 0));
  const current = {
    passed: Math.min(observation.passed, knownTotal || observation.passed),
    total: knownTotal,
  };
  const bestKey = target
    ? progressTargetKey(observation.turn, observation.stage)
    : observation.stage;
  const previousBest = tracker.stageBest.get(bestKey);
  const best =
    !previousBest || current.passed >= previousBest.passed
      ? { ...current, recordedAt: observation.recordedAt }
      : previousBest;
  const normalizedBest = {
    ...best,
    total: Math.max(best.total ?? 0, knownTotal),
  };

  tracker.stageBest.set(bestKey, normalizedBest);
  const progress = {
    ...observation,
    current,
    best: normalizedBest,
  };
  tracker.latest = progress;
  return progress;
}

function turnHasConfiguredProgressTarget(tracker, turn) {
  if (!Number.isInteger(turn)) {
    return false;
  }
  const prefix = `${turn}:`;
  for (const key of tracker.turnTargets.keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function updateKnownStageTotal(tracker, stage, total) {
  if (!stage || !Number.isFinite(total) || total <= 0) {
    return;
  }
  const previous = tracker.stageTotals.get(stage) ?? 0;
  if (total > previous) {
    tracker.stageTotals.set(stage, total);
  }
}

function knownPriorStageTotal(tracker, stageNumber) {
  let total = 0;
  for (let number = 1; number < stageNumber; number += 1) {
    const stageTotal = tracker.stageTotals.get(`pa${number}`);
    if (!Number.isFinite(stageTotal) || stageTotal <= 0) {
      return null;
    }
    total += stageTotal;
  }
  return total;
}

function parseStageProgressFromAgentOutput(output, fallbackStage) {
  const stages = new Map();
  let sectionStage = fallbackStage;

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^===== (pa\d+) =====$/);
    if (header) {
      sectionStage = header[1];
      continue;
    }

    let match = line.match(/^(.+?): running (\d+) tests$/);
    if (match) {
      setStageTargetProgress(stages, {
        target: match[1],
        sectionStage,
        fallbackStage,
        passed: 0,
        total: Number.parseInt(match[2], 10),
        status: "running",
      });
      continue;
    }

    match = line.match(/^(.+?): PASS \((\d+)\/(\d+)\)$/);
    if (match) {
      setStageTargetProgress(stages, {
        target: match[1],
        sectionStage,
        fallbackStage,
        passed: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
        status: "pass",
      });
      continue;
    }

    match = line.match(/^(.+?): FAIL \((\d+)\/(\d+)\)$/);
    if (match) {
      setStageTargetProgress(stages, {
        target: match[1],
        sectionStage,
        fallbackStage,
        passed: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
        status: "fail",
      });
      continue;
    }

    match = line.match(/^(.+?): FAIL after (\d+)\/(\d+) passed$/);
    if (match) {
      setStageTargetProgress(stages, {
        target: match[1],
        sectionStage,
        fallbackStage,
        passed: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
        status: "fail",
      });
    }
  }

  const progress = new Map();
  for (const [stage, state] of stages.entries()) {
    const entries = [...state.targets.entries()];
    const nonAggregateEntries = entries.filter(([target]) =>
      !isStageAggregateProgressTarget(target, stage));
    const targets = (nonAggregateEntries.length ? nonAggregateEntries : entries)
      .map(([, target]) => target);
    const passed = targets.reduce((sum, target) => sum + (target.passed ?? 0), 0);
    const total = targets.reduce((sum, target) => sum + (target.total ?? 0), 0);
    const failed = targets.some((target) => target.status === "fail");
    const allPassed = targets.length > 0 && targets.every((target) => target.status === "pass");
    progress.set(stage, {
      stage,
      passed,
      total,
      status: failed ? "fail" : allPassed ? "pass" : "running",
    });
  }
  return progress;
}

function isStageAggregateProgressTarget(target, stage) {
  const normalized = cleanText(target).replace(/\s+/g, " ");
  return normalized === `${stage} tests` || normalized === `${stage}/tests`;
}

function setStageTargetProgress(stages, options) {
  const stage = inferProgressStage(options.target, options.sectionStage, options.fallbackStage);
  if (!stage) {
    return;
  }
  if (!stages.has(stage)) {
    stages.set(stage, { targets: new Map() });
  }
  stages.get(stage).targets.set(options.target, {
    passed: options.passed,
    total: options.total,
    status: options.status,
  });
}

function inferProgressStage(target, sectionStage, fallbackStage) {
  return target.match(/\b(pa\d+)\b/)?.[1] ?? sectionStage ?? fallbackStage ?? null;
}

function latestPhaseStatusHtml(status) {
  if (!status) {
    return '<span class="muted">n/a</span>';
  }
  const checkHtml = (status.checks ?? []).map(checkPillHtml).join(" ");
  return [
    `<span class="summary-phase${status.allRequiredPassed ? " summary-phase-pass" : ""}">${escapeHtml(phaseStatusText(status))}</span>`,
    checkHtml,
  ].filter(Boolean).join(" ");
}

function phaseStatusText(status) {
  if (!status) {
    return "";
  }
  const parts = [];
  if (status.phase) parts.push(status.phase);
  const target = phaseTargetText(status);
  if (target) parts.push(target);
  if (status.allRequiredPassed) {
    parts.push("checks pass");
  } else {
    parts.push(phaseChecksText(status) || "checks incomplete");
  }
  return parts.join(" / ");
}

function phaseTargetText(status) {
  const stage =
    status?.stage ??
    status?.testStatus?.targetStage ??
    status?.primaryCheck?.targetStage ??
    status?.checks?.find?.((check) => check?.targetStage)?.targetStage ??
    "";
  const slice = phaseSliceText(status);
  if (stage && slice) {
    return `${stage} ${slice}`;
  }
  return stage || slice;
}

function phaseSliceText(status) {
  const index = positiveInteger(
    status?.sliceIndex ??
      status?.target?.sliceIndex ??
      status?.slice?.index ??
      status?.testStatus?.sliceIndex,
  );
  const count = positiveInteger(
    status?.sliceCount ??
      status?.observedSliceCount ??
      status?.target?.sliceCount ??
      status?.slice?.count ??
      status?.testStatus?.sliceCount,
  );
  if (index && count) {
    return `slice ${index}/${count}`;
  }
  if (index) {
    return `slice ${index}/?`;
  }
  const subset = cleanText(status?.subset ?? status?.testStatus?.targetSubset);
  const compact = compactSubsetText(subset);
  return compact ? `slice ${compact}` : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function compactSubsetText(subset) {
  const patterns = cleanText(subset).split(/\s+/).filter(Boolean);
  if (!patterns.length) {
    return "";
  }
  const first = patterns[0]
    .replace(/^pa\d+\//, "")
    .replace(/^tests\//, "");
  return patterns.length === 1 ? first : `${first} +${patterns.length - 1}`;
}

function phaseChecksText(status) {
  const checks = (status?.checks ?? []).filter((check) => check?.name);
  if (!checks.length) {
    return "";
  }
  return checks
    .map((check) => `${check.name} ${check.passed ? "pass" : "fail"}`)
    .join(", ");
}

function checkPillHtml(check) {
  if (!check?.name) {
    return "";
  }
  const className = check.passed
    ? "pill pill-ok"
    : check.required
      ? "pill pill-bad"
      : "pill";
  const text = `${check.name} ${check.passed ? "pass" : `fail ${check.exitCode ?? "?"}`}`;
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function latestProgressSummaryHtml(progress) {
  if (!progress) {
    return '<span class="muted">n/a</span>';
  }
  const turnText = Number.isInteger(progress.turn) ? `turn ${progress.turn}` : "setup";
  return [
    `<span class="summary-progress">${escapeHtml(turnText)} ${escapeHtml(progress.stage)} current ${progressRatioText(progress.current)}; best ${progressRatioText(progress.best)}</span>`,
    `<span class="muted">${escapeHtml(progress.commandTarget)}</span>`,
  ].join(" ");
}

function dockProgressText(progress) {
  if (!progress) {
    return "";
  }
  const turnText = Number.isInteger(progress.turn) ? `turn ${progress.turn}` : "setup";
  const runningText = progress.status === "running" ? " running" : "";
  return `${turnText} ${progress.stage} current ${progressRatioText(progress.current)}; best ${progressRatioText(progress.best)}${runningText}`;
}

function turnProgressText(progress) {
  if (!progress) {
    return "";
  }
  const bestText =
    progress.best && progress.best.passed > progress.current.passed
      ? ` best ${progressRatioText(progress.best)}`
      : "";
  const statusText = progress.status === "running" ? " running" : "";
  return `${progress.stage} current ${progressRatioText(progress.current)}${bestText}${statusText}`;
}

function progressRatioText(value) {
  if (!value) {
    return "0/?";
  }
  const total = value.total > 0 ? value.total : "?";
  return `${value.passed ?? 0}/${total}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function testStatusText(ts, options = {}) {
  if (!ts) return "";
  const currentFull = inferCurrentFullRunStatus(ts, options.progress);
  const parts = currentFull
    ? [
        `full beginning ${ts.testsPassed}/${ts.testsTotal} tests`,
        `full current ${currentFull.testsPassed}/${currentFull.testsTotal} est`,
      ]
    : [`full ${ts.testsPassed}/${ts.testsTotal} tests`];
  if (ts.stageCount > 0) parts.push(`${ts.stagesPassed}/${ts.stageCount} stages`);
  if (ts.failingStage) parts.push(ts.failingStage);
  else if (ts.allTestsPassed) parts.push("all pass");
  const timeoutText = timeoutStatusText(ts);
  if (timeoutText) parts.push(timeoutText);
  return parts.join(", ");
}

function inferCurrentFullRunStatus(ts, progress) {
  const current = progress?.current;
  if (!ts || !current || !progress.stage) {
    return null;
  }

  const statusTime = Date.parse(ts.recordedAt ?? "");
  const progressTime = Date.parse(progress.recordedAt ?? "");
  if (Number.isFinite(statusTime) && Number.isFinite(progressTime) && progressTime <= statusTime) {
    return null;
  }

  const stage = Array.isArray(ts.stages)
    ? ts.stages.find((candidate) => candidate?.name === progress.stage)
    : null;
  if (!stage) {
    return null;
  }

  const stagePassed = stagePassedCount(stage);
  const stageTotal = finitePositiveNumber(stage.total);
  const currentTotal = finitePositiveNumber(current.total);
  if (stagePassed == null || stageTotal == null || currentTotal == null) {
    return null;
  }
  if (currentTotal !== stageTotal) {
    return null;
  }

  const testsTotal = Math.max(0, ts.testsTotal - stageTotal + currentTotal);
  const testsPassed = Math.min(
    testsTotal,
    Math.max(0, ts.testsPassed - stagePassed + (current.passed ?? 0)),
  );
  return { testsPassed, testsTotal };
}

function stagePassedCount(stage) {
  if (Number.isFinite(stage?.passed) && stage.passed >= 0) {
    return stage.passed;
  }
  if (Number.isFinite(stage?.total) && Number.isFinite(stage?.failed)) {
    return Math.max(0, stage.total - stage.failed);
  }
  return null;
}

function finitePositiveNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function timeoutStatusText(ts) {
  const timeoutFailures = ts.timeoutFailures ?? 0;
  const timeoutExpectationFailures = ts.timeoutExpectationFailures ?? 0;
  const parts = [];
  if (timeoutFailures > 0) {
    parts.push(`${timeoutFailures} timeout${timeoutFailures === 1 ? "" : "s"}`);
  }
  if (timeoutExpectationFailures > 0) {
    parts.push(
      `${timeoutExpectationFailures} timeout expectation mismatch${timeoutExpectationFailures === 1 ? "" : "es"}`,
    );
  }
  return parts.join(", ");
}

function latestTestStatus(records) {
  const testMap = buildTestStatusMap(records);
  let selectedTurn = null;
  let selectedStatus = null;
  for (const [turn, status] of testMap.entries()) {
    // Keep the overall header anchored to the widest report; narrow in-turn
    // commands are still reflected through the current-stage progress estimate.
    if (
      !selectedStatus ||
      compareOverallTestStatus(status, selectedStatus, turn, selectedTurn) > 0
    ) {
      selectedTurn = turn;
      selectedStatus = status;
    }
  }
  return selectedStatus == null ? null : { turn: selectedTurn, status: selectedStatus };
}

function compareOverallTestStatus(a, b, aTurn, bTurn) {
  const stageDelta = statusStageCount(a) - statusStageCount(b);
  if (stageDelta !== 0) {
    return stageDelta;
  }
  const totalDelta = statusTestTotal(a) - statusTestTotal(b);
  if (totalDelta !== 0) {
    return totalDelta;
  }
  const timeDelta = statusRecordedAtValue(a) - statusRecordedAtValue(b);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return turnSortValue(aTurn) - turnSortValue(bTurn);
}

function statusStageCount(status) {
  if (Number.isFinite(status?.stageCount) && status.stageCount >= 0) {
    return status.stageCount;
  }
  return Array.isArray(status?.stages) ? status.stages.length : 0;
}

function statusTestTotal(status) {
  return Number.isFinite(status?.testsTotal) && status.testsTotal >= 0
    ? status.testsTotal
    : 0;
}

function statusRecordedAtValue(status) {
  const value = Date.parse(status?.recordedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function turnSortValue(turn) {
  if (Number.isInteger(turn)) {
    return turn;
  }
  if (turn === "setup") {
    return -1;
  }
  const parsed = Number.parseInt(turn, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function selectedRunMeta() {
  return state.runs.find((run) => run.id === state.selectedRun) ?? null;
}

function turnSummaryText(items) {
  let cmds = 0, msgs = 0, files = 0, thoughts = 0;
  for (const r of items) {
    const t = r.event?.item?.type;
    const et = r.eventType;
    // Codex events
    if (t === "command_execution") cmds++;
    else if (t === "agent_message") msgs++;
    else if (t === "file_change") files++;
    // Gemini events
    else if (et === "tool_call_request") cmds++;
    else if (et === "thought") thoughts++;
  }
  // Count unique gemini content traces as messages
  const contentTraces = new Set();
  for (const r of items) {
    if (r.eventType === "content" && typeof r.event?.value === "string") {
      contentTraces.add(r.event.traceId ?? "_default");
    }
  }
  msgs += contentTraces.size;

  const parts = [];
  if (cmds) parts.push(`${cmds} cmd`);
  if (msgs) parts.push(`${msgs} msg`);
  if (files) parts.push(`${files} file`);
  if (thoughts) parts.push(`${thoughts} thought`);
  return parts.join(", ") || `${items.length} events`;
}

function usageText(usage) {
  if (!usage) return "";
  return fullUsageText(usage, {
    includeCost: true,
    model: inferPriceModel(),
  });
}

function renderTimeline(records) {
  scrollDebug("render-timeline-before", {
    recordCount: records.length,
    childCount: timelineEl.children.length,
  });
  const options = renderTimeline.pendingOptions ?? {};
  renderTimeline.pendingOptions = {};
  rememberOpenEntryKeys();
  const usageMap = buildUsageMap(records);
  const testMap = buildTestStatusMap(records);
  const phaseMap = buildPhaseStatusMap(records);
  const durationMap = buildTurnDurationMap(records);
  const progressMap = applyProgressBestCache(
    buildAgentTestProgressState(records),
    state.currentRun,
  ).byTurn;
  const filtered = filterRecords(records);
  eventCountEl.textContent = `${filtered.length} / ${records.length}`;

  const turnMap = buildTurnMap(filtered);
  for (const turn of usageMap.keys()) {
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
  }
  for (const turn of testMap.keys()) {
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
  }
  for (const turn of phaseMap.keys()) {
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
  }
  for (const turn of progressMap.keys()) {
    if (!turnMap.has(turn)) {
      turnMap.set(turn, []);
    }
  }
  const sortedTurns = [...turnMap.keys()].sort((a, b) => {
    if (a === "setup") return -1;
    if (b === "setup") return 1;
    return a - b;
  });

  const lastTurn = sortedTurns[sortedTurns.length - 1];
  const urlTurns = getUrlParams().turns;
  if (options.openLatestTurn && lastTurn != null && !urlTurns.includes(String(lastTurn))) {
    urlTurns.push(String(lastTurn));
    setUrlParam("turns", urlTurns.join(","));
  }
  const hasUrlTurns = urlTurns.length > 0;
  const fragment = document.createDocumentFragment();

  for (const turn of sortedTurns) {
    const items = turnMap.get(turn) ?? [];
    const turnEl = document.createElement("div");
    turnEl.className = "turn";
    turnEl.dataset.turn = String(turn);

    // Open turns from URL, or default to last turn
    const initialOpen = hasUrlTurns ? urlTurns.includes(String(turn)) : turn === lastTurn;
    const { header: summary, body: feed } = createAccordion(turnEl, {
      initialOpen,
      headerClass: "turn-header accordion-header",
      bodyClass: "turn-feed accordion-body",
      scrollKey: turnScrollKey(turn),
      onToggle: syncOpenTurnsToUrl,
    });

    const label = turn === "setup" ? "Setup" : `Turn ${turn}`;
    const usage = Number.isInteger(turn)
      ? bestTurnUsage(state.shapeUsage, turn, usageMap.get(turn))
      : usageMap.get(turn);
    const ts = testMap.get(turn);
    const phase = phaseMap.get(turn);
    const progress = progressMap.get(turn);
    const duration = durationText(bestTurnDurationSpan(state.shapeUsage, turn, durationMap, {
      activeCurrentTurn: isActiveCurrentRunTurn(selectedRunMeta(), turn),
      activeStartMs: activeCurrentRunTurnStartMs(selectedRunMeta(), turn, items),
    }));
    const infoText = items.length ? turnSummaryText(items) : "pre-turn check";
    const displayEntries = buildDisplayEntries(items);
    const entryWindow = displayEntryWindow(displayEntries);
    const cardWindowText = turnCardWindowText(entryWindow);
    const usageHtml = usage ? ` <span class="turn-usage">${usageText(usage)}</span>` : "";
    const tsHtml = ts ? ` <span class="turn-tests${ts.allTestsPassed ? " turn-tests-pass" : ""}">${testStatusText(ts, { progress })}</span>` : "";
    const progressHtml = progress ? ` <span class="turn-progress">${escapeHtml(turnProgressText(progress))}</span>` : "";
    const durationHtml = duration ? ` <span class="turn-duration">${duration}</span>` : "";
    const cardWindowHtml = cardWindowText ? ` <span class="turn-window">${escapeHtml(cardWindowText)}</span>` : "";
    const phaseHtml = phase
      ? ` <span class="turn-phase${phase.allRequiredPassed ? " turn-phase-pass" : ""}">${escapeHtml(phaseStatusText(phase))}</span>`
      : "";
    summary.innerHTML = `<strong>${label}</strong> <span class="turn-info">${infoText}</span>${durationHtml}${cardWindowHtml}${phaseHtml}${progressHtml}${tsHtml}${usageHtml}`;

    entryWindow.entries.forEach((entry, offset) => {
      const el = renderDisplayEntry(entry);
      if (el) {
        if (!el.dataset.scrollKey && !el.querySelector("[data-scroll-key]")) {
          const entryIndex = entryWindow.indices?.[offset] ?? entryWindow.startIndex + offset;
          const key = scrollKeyForEntry(entry, entryIndex);
          if (key) {
            el.dataset.scrollKey = key;
          }
        }
        feed.append(el);
      }
    });
    fragment.append(turnEl);
  }
  const contentScrollPositions = captureContentScrollPositions();
  timelineEl.replaceChildren(fragment);
  restoreContentScrollPositions(contentScrollPositions);
  scrollDebug("render-timeline-after", {
    recordCount: records.length,
    childCount: timelineEl.children.length,
    sortedTurns,
  });
}

// Internal scroll positions of long-output blocks (e.g. .cmd-output) keyed by
// their stable content key, so re-rendering on auto-refresh doesn't reset a
// card the user has scrolled within.
function captureContentScrollPositions() {
  const positions = new Map();
  for (const el of timelineEl.querySelectorAll("[data-content-scroll-key]")) {
    if (el.scrollTop || el.scrollLeft) {
      positions.set(el.dataset.contentScrollKey, { top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return positions;
}

function restoreContentScrollPositions(positions) {
  if (!positions.size) {
    return;
  }
  for (const el of timelineEl.querySelectorAll("[data-content-scroll-key]")) {
    const saved = positions.get(el.dataset.contentScrollKey);
    if (saved) {
      el.scrollTop = saved.top;
      el.scrollLeft = saved.left;
    }
  }
}

function turnScrollKey(turn) {
  return `turn:${turn}`;
}

function rememberOpenEntryKeys() {
  for (const entry of timelineEl.querySelectorAll(".accordion[data-entry-key]")) {
    const key = entry.dataset.entryKey;
    if (!key) {
      continue;
    }
    if (entry.classList.contains("is-open")) {
      state.openEntryKeys.add(key);
    } else {
      state.openEntryKeys.delete(key);
    }
  }
}

// --- URL state ---

function getUrlParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    run: p.get("run"),
    view: p.get("view"),
    page: p.get("page"),
    doc: p.get("doc"),
    turns: p.get("turns")?.split(",").filter(Boolean) ?? [],
  };
}

function setUrlParam(key, value) {
  const p = new URLSearchParams(window.location.search);
  if (value == null || value === "") p.delete(key);
  else p.set(key, value);
  const qs = p.toString();
  scrollDebug("url-replace-before", { key, value, qs });
  history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  scrollDebug("url-replace-after", { key, value, qs });
}

function syncOpenTurnsToUrl() {
  const open = [];
  for (const el of timelineEl.querySelectorAll(".turn.is-open")) {
    const t = el.dataset.turn;
    if (t) open.push(t);
  }
  setUrlParam("turns", open.length ? open.join(",") : null);
  scheduleOpenTurnDetailReload();
}

function scheduleOpenTurnDetailReload() {
  if (codexDetail?.value !== "open" || !state.selectedRun) {
    return;
  }
  if (state.openTurnReloadTimer) {
    window.clearTimeout(state.openTurnReloadTimer);
  }
  const scrollSnapshot = captureScrollSnapshot();
  state.openTurnReloadTimer = window.setTimeout(() => {
    state.openTurnReloadTimer = null;
    loadRun(state.selectedRun, { scrollSnapshot }).catch((error) => {
      console.error("turn detail reload failed", error);
    });
  }, 150);
}

// --- Data loading ---

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Load failed: ${response.status}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Load failed: ${response.status}`);
  }
  return response.text();
}

function staticDataPath(relativePath) {
  const base = `${STATIC_DATA_ROOT}/${String(relativePath ?? "").replace(/^\/+/, "")}`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}_=${Date.now()}`;
}

function staticModeForced() {
  return new URLSearchParams(window.location.search).get("static") === "1";
}

function staticExportHost() {
  const host = window.location.hostname;
  return window.location.protocol === "file:" ||
    host === "storage.googleapis.com" ||
    host === "storage.cloud.google.com" ||
    host.endsWith(".storage.googleapis.com");
}

async function loadRunCatalog() {
  if (!state.staticMode && !staticModeForced() && !staticExportHost()) {
    try {
      const [stateData, data] = await Promise.all([
        fetchJson("/api/state"),
        fetchJson("/api/runs"),
      ]);
      handleAppVersion(stateData.appVersion);
      state.staticMode = false;
      document.body.classList.toggle("is-static-viz", false);
      return {
        currentThread: stateData.currentThread ?? null,
        runs: data.runs ?? [],
      };
    } catch (error) {
      console.warn("live Ralph API unavailable; trying static export data", error);
    }
  }

  const manifest = await fetchJson(staticDataPath("runs.json"));
  state.staticMode = true;
  state.staticManifest = manifest;
  state.staticRunSummaries.clear();
  state.staticRunDocs.clear();
  state.staticComparison = null;
  document.body.classList.toggle("is-static-viz", true);
  if (autoRefreshToggle) {
    autoRefreshToggle.checked = false;
  }
  stopAutoRefresh();
  return {
    currentThread: manifest.currentRun ?? null,
    runs: manifest.runs ?? [],
  };
}

function handleAppVersion(appVersion) {
  if (!appVersion) {
    return;
  }
  if (state.appVersion && state.appVersion !== appVersion) {
    window.location.reload();
    throw new Error("Ralph viz app updated; reloading page");
  }
  state.appVersion = appVersion;
}

async function loadStaticRunSummary(run) {
  if (!run?.dataPath) {
    throw new Error("Static run is missing dataPath");
  }
  if (state.staticRunSummaries.has(run.id)) {
    return state.staticRunSummaries.get(run.id);
  }
  const summary = await fetchJson(staticDataPath(run.dataPath));
  state.staticRunSummaries.set(run.id, summary);
  return summary;
}

async function loadStaticRunData(id, detailParams) {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) {
    throw new Error(`Run not found: ${id}`);
  }
  const summary = await loadStaticRunSummary(run);
  const turnEntries = selectStaticTurnEntries(summary.turns ?? [], detailParams);
  const turnPayloads = await Promise.all(turnEntries.map((turn) => fetchJson(staticDataPath(turn.path))));
  const events = turnPayloads.flatMap((payload) => payload.events ?? []);
  return {
    events,
    shapeUsage: summary.shapeUsage ?? null,
    codexDetail: staticCodexDetail(detailParams, turnEntries),
    staticSummary: summary,
  };
}

function selectStaticTurnEntries(turns, detailParams) {
  const sorted = [...turns].sort((a, b) => compareTurnKeys(a.turn, b.turn));
  const mode = detailParams.get("codex") ?? "tail";
  if (mode === "all" || mode === "none") {
    return sorted;
  }
  if (mode === "turns") {
    const wanted = new Set((detailParams.get("turns") ?? "").split(",").filter(Boolean));
    return sorted.filter((turn) => wanted.has(String(turn.turn)));
  }
  const tailTurns = Math.max(1, Number.parseInt(detailParams.get("tailTurns") ?? "2", 10) || 2);
  const numeric = sorted.filter((turn) => turn.turn !== "setup").slice(-tailTurns);
  return numeric.length ? numeric : sorted.slice(-tailTurns);
}

function compareTurnKeys(a, b) {
  if (a === "setup") return b === "setup" ? 0 : -1;
  if (b === "setup") return 1;
  return Number.parseInt(a, 10) - Number.parseInt(b, 10);
}

function staticCodexDetail(detailParams, turns) {
  const mode = detailParams.get("codex") ?? "tail";
  if (mode === "tail") {
    return { mode, tailTurns: Number.parseInt(detailParams.get("tailTurns") ?? "2", 10) || 2, static: true };
  }
  if (mode === "turns") {
    return { mode, turns: turns.map((turn) => turn.turn), static: true };
  }
  return { mode, static: true };
}

function codexDetailQueryParams() {
  const params = new URLSearchParams();
  const value = codexDetail?.value ?? "tail:2";
  params.set("usage", "fast");
  if (value === "none") {
    params.set("codex", "none");
  } else if (value === "all") {
    params.set("codex", "all");
    params.set("usage", "full");
  } else if (value === "open") {
    const turns = getUrlParams().turns;
    if (turns.length) {
      params.set("codex", "turns");
      params.set("turns", turns.join(","));
    } else {
      params.set("codex", "tail");
      params.set("tailTurns", "2");
    }
  } else {
    const match = value.match(/^tail:(\d+)$/);
    params.set("codex", "tail");
    params.set("tailTurns", match?.[1] ?? "2");
  }
  return params;
}

function combinedRunQueryParams() {
  const params = new URLSearchParams();
  params.set("codex", "tail");
  params.set("tailTurns", String(COMBINED_RUN_CARD_LIMIT));
  params.set("usage", "fast");
  return params;
}

function requestedCombinedViewFromUrl() {
  const view = getUrlParams().view;
  return view !== "run" && view !== "single";
}

function initializeViewControls() {
  if (viewerMode) {
    const page = getUrlParams().page;
    viewerMode.value = ["compare", "runs"].includes(page) ? page : "runs";
  }
  if (combinedViewToggle) {
    combinedViewToggle.checked = requestedCombinedViewFromUrl();
  }
}

function currentViewerMode() {
  return viewerMode?.value ?? "runs";
}

function isRunsPage() {
  return currentViewerMode() === "runs";
}

function isCombinedView() {
  return isRunsPage() && (combinedViewToggle?.checked ?? requestedCombinedViewFromUrl());
}

async function loadRuns(options = {}) {
  const data = await loadRunCatalog();
  state.currentRun = data.currentThread ?? null;
  state.runs = data.runs ?? [];

  runSelect.innerHTML = "";
  if (!state.runs.length) {
    setViewTitles(isCombinedView() ? "Active Runs" : "Summary", isCombinedView() ? "Recent Cards" : "Turns");
    const opt = document.createElement("option");
    opt.textContent = "No runs found";
    runSelect.append(opt);
    summaryEl.innerHTML = "";
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    state.shapeUsage = null;
    if (progressDock) {
      progressDock.innerHTML = '<span class="muted">No runs found</span>';
      updateProgressDockSpace();
    }
    return;
  }

  for (const run of state.runs) {
    const opt = document.createElement("option");
    opt.value = run.id;
    const size = formatBytes(run.size);
    const updated = fmtShort(run.mtime);
    const details = [size, updated ? `updated ${updated}` : ""].filter(Boolean).join(", ");
    opt.textContent = details ? `${run.label} (${details})` : run.label;
    runSelect.append(opt);
  }

  const urlRun = options.ignoreUrl ? null : getUrlParams().run;
  const selectedRun = options.preserveSelection ? state.selectedRun : null;
  const preferred = options.preferredRun && state.runs.some(r => r.id === options.preferredRun) ? options.preferredRun
    : selectedRun && state.runs.some(r => r.id === selectedRun) ? selectedRun
    : urlRun && state.runs.some(r => r.id === urlRun) ? urlRun
    : state.runs[0].id;
  runSelect.value = preferred;

  if (currentViewerMode() === "compare") {
    await renderComparisonView();
    return;
  }

  if (isCombinedView()) {
    await loadCombinedRuns({
      scrollSnapshot: options.scrollSnapshot,
    });
    return;
  }
  await loadRun(preferred, {
    stickToBottom: options.stickToBottom,
    scrollSnapshot: options.scrollSnapshot,
  });
}

async function loadCombinedRuns(options = {}) {
  setCombinedModeActive(true);
  hideRunDocsPanel();
  setViewTitles("Active Runs", "Recent Cards");
  state.selectedRun = runSelect.value || state.selectedRun;
  const activeRuns = state.staticMode ? staticCombinedRuns() : state.runs.filter(isActiveRunMeta);
  const query = combinedRunQueryParams().toString();
  const loaded = await Promise.all(activeRuns.map(async (run) => {
    try {
      const data = state.staticMode
        ? await loadStaticRunData(run.id, combinedRunQueryParams())
        : await fetchJson(`/api/run/${encodeURIComponent(run.id)}?${query}`);
      const events = data.events ?? [];
      const shapeUsage = normalizeShapeUsage(data.shapeUsage);
      return {
        run,
        events,
        shapeUsage,
        summary: buildSummary(events, shapeUsage, run),
        error: null,
      };
    } catch (error) {
      return {
        run,
        events: [],
        shapeUsage: null,
        summary: null,
        error,
      };
    }
  }));

  state.combinedRuns = loaded;
  state.events = [];
  state.shapeUsage = null;
  state.codexDetail = { mode: "tail", tailTurns: 2 };
  state.raw = [];

  let scrollSnapshot = options.scrollSnapshot ?? null;
  if (scrollSnapshot && scrollSnapshot.userScrollVersion !== state.userScrollVersion) {
    const staleScrollSnapshot = scrollSnapshot;
    scrollSnapshot = captureScrollSnapshot();
    scrollDebug("combined-load-refresh-stale-scroll-snapshot", {
      staleScrollSnapshot,
      scrollSnapshot,
      currentUserScrollVersion: state.userScrollVersion,
    });
  }
  renderCombinedRuns(loaded);
  restoreScrollAfterRender(scrollSnapshot, { immediate: true });
}

async function loadRun(id, options = {}) {
  if (!id) return;
  setCombinedModeActive(false);
  hideRunDocsPanel();
  setViewTitles("Summary", "Turns");
  scrollDebug("load-run-start", { id, hasScrollSnapshot: Boolean(options.scrollSnapshot) });
  state.selectedRun = id;
  setUrlParam("run", id);
  const detailParams = codexDetailQueryParams();
  const detailQuery = detailParams.toString();
  const data = state.staticMode
    ? await loadStaticRunData(id, detailParams)
    : await fetchJson(`/api/run/${encodeURIComponent(id)}${detailQuery ? `?${detailQuery}` : ""}`);

  state.events = data.events ?? [];
  state.combinedRuns = [];
  state.shapeUsage = normalizeShapeUsage(data.shapeUsage);
  state.codexDetail = data.codexDetail ?? null;
  state.raw = state.events.slice();
  let scrollSnapshot = options.scrollSnapshot
    ?? (options.stickToBottom ? captureScrollSnapshot({ forceStickToBottom: true }) : null);
  if (scrollSnapshot && scrollSnapshot.userScrollVersion !== state.userScrollVersion) {
    const staleScrollSnapshot = scrollSnapshot;
    scrollSnapshot = captureScrollSnapshot();
    scrollDebug("load-run-refresh-stale-scroll-snapshot", {
      staleScrollSnapshot,
      scrollSnapshot,
      currentUserScrollVersion: state.userScrollVersion,
    });
  }
  renderSummary(state.events);
  await renderRunDocsPanel(state.runs.find((run) => run.id === id) ?? null, data.staticSummary ?? null);
  scrollDebug("load-run-before-render", {
    id,
    eventCount: state.events.length,
    scrollSnapshot,
  });
  renderTimeline.pendingOptions = { openLatestTurn: scrollSnapshot?.stickToBottom ?? false };
  renderTimeline(state.events);
  restoreScrollAfterRender(scrollSnapshot, { immediate: true });
  scrollDebug("load-run-after-render", { id, eventCount: state.events.length });
}

function staticCombinedRuns() {
  return state.runs.slice(0, 6);
}

async function renderComparisonView() {
  setCombinedModeActive(false);
  hideRunDocsPanel();
  setViewTitles("Comparison", "PA Costs");
  state.events = [];
  state.combinedRuns = [];
  state.shapeUsage = null;
  state.codexDetail = null;
  state.raw = [];
  if (!state.staticMode) {
    summaryEl.innerHTML = '<div class="summary-wide muted">Comparison data is available in static exports.</div>';
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    if (progressDock) {
      progressDock.innerHTML = '<span class="muted">No static comparison data</span>';
      updateProgressDockSpace();
    }
    return;
  }
  const comparison = await loadStaticComparison();
  if (!comparison) {
    summaryEl.innerHTML = '<div class="summary-wide muted">No comparison data exported.</div>';
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    return;
  }
  const maxPa = comparison.rows?.length ?? 0;
  const requested = Number.parseInt(state.compareThrough ?? maxPa, 10);
  const through = Math.max(1, Math.min(maxPa, Number.isFinite(requested) ? requested : maxPa));
  state.compareThrough = through;
  const rows = comparison.rows.slice(0, through);
  const runOrder = comparisonRunOrder(comparison.runs);
  const orderedRuns = runOrder.map((index) => comparison.runs[index]);
  const totals = runOrder.map((index) => comparisonTotalForRows(rows, index));
  await ensureEChartsLoaded();
  summaryEl.innerHTML = `
    <div><strong>through</strong><input id="compareThrough" class="compact-number" type="number" min="1" max="${maxPa}" value="${through}" /></div>
    <div><strong>runs</strong>${fmtInt(comparison.runs.length)}</div>
    <div><strong>generated</strong>${fmt(comparison.generatedAt)}</div>
    <div class="summary-wide"><strong>pricing</strong>${escapeHtml(comparison.runs.map((run) => `${run.label}=${run.model ?? "provider"}`).join(", "))}</div>
  `;
  const input = document.getElementById("compareThrough");
  input?.addEventListener("change", () => {
    state.compareThrough = Number.parseInt(input.value, 10);
    renderComparisonView().catch((error) => console.error("comparison render failed", error));
  });

  const table = document.createElement("table");
  table.className = "comparison-table";
  const header = document.createElement("thead");
  header.innerHTML = `
    <tr>
      <th>PA</th>
      ${orderedRuns.map((run) => `<th>${escapeHtml(run.label)}</th>`).join("")}
    </tr>
  `;
  table.append(header);
  const body = document.createElement("tbody");
  const totalRow = document.createElement("tr");
  totalRow.className = "comparison-total";
  totalRow.innerHTML = `<th>Total</th>${totals.map((total) => `<td>${comparisonCellHtml(total)}</td>`).join("")}`;
  body.append(totalRow);
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <th>${escapeHtml(row.pa)}</th>
      ${runOrder.map((index) => `<td>${comparisonCellHtml(row.runs[index])}</td>`).join("")}
    `;
    body.append(tr);
  }
  table.append(body);
  const content = document.createElement("div");
  content.className = "comparison-content";
  const charts = renderComparisonCharts(rows, runOrder, orderedRuns);
  content.append(charts, table);
  timelineEl.replaceChildren(content);
  hydrateComparisonCharts(charts, rows, runOrder, orderedRuns);
  eventCountEl.textContent = `${fmtInt(rows.length)} PAs / ${fmtInt(comparison.runs.length)} runs`;
  if (progressDock) {
    progressDock.innerHTML = `
      <strong>Compare</strong>
      <span class="dock-main">through pa${fmtInt(through)}</span>
      <span class="dock-meta">${fmtInt(comparison.runs.length)} runs</span>
    `;
    updateProgressDockSpace();
  }
}

async function loadStaticComparison() {
  if (state.staticComparison) {
    return state.staticComparison;
  }
  const comparisonEntry = state.staticManifest?.comparisons?.[0];
  if (!comparisonEntry?.path) {
    return null;
  }
  state.staticComparison = await fetchJson(staticDataPath(comparisonEntry.path));
  return state.staticComparison;
}

function comparisonRunOrder(runs) {
  return runs.map((_, index) => index);
}

function renderComparisonCharts(rows, runOrder, orderedRuns) {
  const wrap = document.createElement("div");
  wrap.className = "comparison-charts";
  if (window.echarts) {
    wrap.innerHTML = [
      comparisonChartShellHtml("Accumulated Cost", "cost"),
      comparisonChartShellHtml("Accumulated Runtime", "runtime"),
    ].join("");
    return wrap;
  }
  wrap.innerHTML = [
    comparisonAreaChartHtml("Accumulated Cost", rows, runOrder, orderedRuns, {
      field: "cost",
      format: formatUsd,
      axis: formatCompactUsd,
    }),
    comparisonAreaChartHtml("Accumulated Runtime", rows, runOrder, orderedRuns, {
      field: "durationMs",
      format: (value) => formatHhhMmSs(value),
      axis: formatCompactDuration,
    }),
  ].join("");
  return wrap;
}

async function ensureEChartsLoaded() {
  if (window.echarts) {
    return true;
  }
  if (!echartsLoadPromise) {
    echartsLoadPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      window.setTimeout(() => finish(Boolean(window.echarts)), 5000);
      const existing = document.querySelector(`script[src="${ECHARTS_CDN_URL}"]`);
      if (existing) {
        existing.addEventListener("load", () => finish(Boolean(window.echarts)), { once: true });
        existing.addEventListener("error", () => finish(false), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = ECHARTS_CDN_URL;
      script.async = true;
      script.onload = () => finish(Boolean(window.echarts));
      script.onerror = () => finish(false);
      document.head.append(script);
    });
  }
  return echartsLoadPromise;
}

function comparisonChartShellHtml(title, metric) {
  return `
    <section class="comparison-chart">
      <div class="comparison-chart-title">
        <strong>${escapeHtml(title)}</strong>
        <span>${metric === "cost" ? "USD" : "HHH:MM:SS"}</span>
      </div>
      <div class="comparison-echart" data-comparison-chart="${escapeHtml(metric)}"></div>
    </section>
  `;
}

function hydrateComparisonCharts(container, rows, runOrder, orderedRuns) {
  if (!window.echarts || !container?.querySelector) {
    return;
  }
  const costEl = container.querySelector('[data-comparison-chart="cost"]');
  const runtimeEl = container.querySelector('[data-comparison-chart="runtime"]');
  if (costEl) {
    renderEChartArea(costEl, "Accumulated Cost", rows, runOrder, orderedRuns, {
      field: "cost",
      valueFormatter: formatUsd,
      axisFormatter: formatCompactUsd,
      tooltipFormatter: formatUsd,
    });
  }
  if (runtimeEl) {
    renderEChartArea(runtimeEl, "Accumulated Runtime", rows, runOrder, orderedRuns, {
      field: "durationMs",
      valueFormatter: formatHhhMmSs,
      axisFormatter: formatCompactDuration,
      tooltipFormatter: formatHhhMmSs,
    });
  }
}

function renderEChartArea(el, title, rows, runOrder, orderedRuns, metric) {
  const chart = window.echarts.init(el, null, { renderer: "canvas" });
  const labels = rows.map((row) => row.pa);
  const series = comparisonCumulativeSeries(rows, runOrder, orderedRuns, metric.field);
  const palette = ["#7aa2f7", "#9ece6a", "#f7768e", "#e0af68", "#bb9af7", "#73daca"];
  const colorBySeries = new Map(series.map((run, index) => [run.label, palette[index % palette.length]]));
  chart.setOption({
    color: palette,
    backgroundColor: "transparent",
    animationDuration: 550,
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(18, 18, 18, 0.96)",
      borderColor: "#333",
      textStyle: { color: "#eee", fontSize: 12 },
      formatter: (params) => comparisonChartTooltipHtml(params, colorBySeries, metric.tooltipFormatter),
    },
    legend: {
      bottom: 0,
      left: 0,
      itemWidth: 11,
      itemHeight: 8,
      textStyle: { color: "#aaa", fontSize: 11 },
    },
    grid: {
      left: 54,
      right: 20,
      top: 10,
      bottom: 58,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: "#555" } },
      axisTick: { lineStyle: { color: "#444" } },
      axisLabel: {
        color: "#999",
        interval: 0,
        rotate: 45,
        margin: 14,
      },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#252525" } },
      axisLabel: {
        color: "#999",
        formatter: (value) => metric.axisFormatter(Number(value) || 0),
      },
    },
    series: series.map((run, runIndex) => {
      const color = palette[runIndex % palette.length];
      const finalPoint = run.points.at(-1) ?? null;
      return {
        name: run.label,
        type: "line",
        smooth: false,
        connectNulls: false,
        symbol: "none",
        showSymbol: true,
        lineStyle: { width: 2.4 },
        areaStyle: { opacity: 0.16 },
        emphasis: { focus: "series" },
        data: rows.map((_, index) => {
          const point = run.points.find((candidate) => candidate.index === index);
          if (!point) {
            return null;
          }
          const isFinal = finalPoint && point.index === finalPoint.index;
          if (!isFinal) {
            return Number(point.value) || 0;
          }
          const complete = point.status === "complete";
          return {
            value: Number(point.value) || 0,
            symbol: "circle",
            symbolSize: 9,
            itemStyle: {
              color: complete ? color : "#111",
              borderColor: color,
              borderWidth: complete ? 1.5 : 2.4,
            },
          };
        }),
      };
    }),
  });
  const resize = () => chart.resize();
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(resize);
    observer.observe(el);
  } else {
    window.addEventListener("resize", resize, { passive: true });
  }
}

function comparisonChartTooltipHtml(params, colorBySeries, valueFormatter) {
  const list = Array.isArray(params) ? params : [params];
  const axisLabel = list.find(Boolean)?.axisValueLabel ?? "";
  const rows = list
    .filter((param) => param?.value != null)
    .map((param) => {
      const color = colorBySeries.get(param.seriesName) ?? param.color ?? "#999";
      return `
        <div class="comparison-tooltip-row">
          <span class="comparison-tooltip-dot" style="background:${escapeHtml(color)}"></span>
          <span>${escapeHtml(param.seriesName ?? "")}</span>
          <strong>${escapeHtml(valueFormatter(Number(param.value) || 0))}</strong>
        </div>
      `;
    })
    .join("");
  return `
    <div class="comparison-tooltip">
      <div class="comparison-tooltip-title">${escapeHtml(axisLabel)}</div>
      ${rows}
    </div>
  `;
}

function comparisonAreaChartHtml(title, rows, runOrder, orderedRuns, metric) {
  const width = 920;
  const height = 260;
  const pad = { left: 54, right: 20, top: 28, bottom: 42 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const series = comparisonCumulativeSeries(rows, runOrder, orderedRuns, metric.field);
  const maxValue = Math.max(1, ...series.flatMap((run) => run.points.map((point) => point.value)));
  const xFor = (index) => pad.left + (rows.length <= 1 ? 0 : (index / (rows.length - 1)) * plotWidth);
  const yFor = (value) => pad.top + plotHeight - (value / maxValue) * plotHeight;
  const ticks = comparisonChartTicks(maxValue, 4);
  const xLabels = comparisonXLabels(rows);
  const palette = ["#7aa2f7", "#9ece6a", "#f7768e", "#e0af68", "#bb9af7", "#73daca"];
  const paths = series.map((run, runIndex) => {
    if (!run.points.length) {
      return "";
    }
    const color = palette[runIndex % palette.length];
    const line = run.points.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(point.index).toFixed(1)} ${yFor(point.value).toFixed(1)}`).join(" ");
    const firstPoint = run.points[0];
    const finalPoint = run.points.at(-1);
    const complete = finalPoint.status === "complete";
    const area = `${line} L ${xFor(finalPoint.index).toFixed(1)} ${yFor(0).toFixed(1)} L ${xFor(firstPoint.index).toFixed(1)} ${yFor(0).toFixed(1)} Z`;
    return `
      <path class="comparison-area-fill" d="${area}" fill="${color}" style="--series-color:${color}" />
      <path class="comparison-area-line" d="${line}" stroke="${color}" />
      <circle cx="${xFor(finalPoint.index).toFixed(1)}" cy="${yFor(finalPoint.value).toFixed(1)}" r="4.8" fill="${complete ? color : "#111"}" stroke="${color}" stroke-width="${complete ? "1.5" : "2.4"}" />
    `;
  }).join("");
  const latest = series.map((run, runIndex) => {
    const color = palette[runIndex % palette.length];
    const value = run.points.at(-1)?.value ?? 0;
    return `<span><i style="background:${color}"></i>${escapeHtml(run.label)} ${escapeHtml(metric.format(value))}</span>`;
  }).join("");
  return `
    <section class="comparison-chart">
      <div class="comparison-chart-title">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(metric.format(maxValue))} max</span>
      </div>
      <svg class="comparison-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)} by PA">
        ${ticks.map((tick) => {
          const y = yFor(tick);
          return `
            <line class="comparison-grid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" />
            <text class="comparison-axis-label" x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(metric.axis(tick))}</text>
          `;
        }).join("")}
        ${xLabels.map(({ index, label }) => {
          const x = xFor(index);
          return `
            <line class="comparison-tick" x1="${x.toFixed(1)}" y1="${height - pad.bottom}" x2="${x.toFixed(1)}" y2="${height - pad.bottom + 5}" />
            <text class="comparison-axis-label" x="${x.toFixed(1)}" y="${height - 18}" text-anchor="middle">${escapeHtml(label)}</text>
          `;
        }).join("")}
        <line class="comparison-axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
        <line class="comparison-axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
        ${paths}
      </svg>
      <div class="comparison-chart-legend">${latest}</div>
    </section>
  `;
}

function comparisonCumulativeSeries(rows, runOrder, orderedRuns, field) {
  return runOrder.map((runIndex, position) => {
    let value = 0;
    return {
      label: orderedRuns[position]?.label ?? `run ${position + 1}`,
      points: rows.flatMap((row, index) => {
        const summary = row.runs?.[runIndex] ?? null;
        if (!comparisonSummaryStarted(summary)) {
          return [];
        }
        value += Number(summary?.[field] ?? 0) || 0;
        return [{
          pa: row.pa,
          index,
          value,
          status: summary?.status ?? "complete",
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
    (Number(summary.cost ?? 0) || 0) > 0 ||
    summary.status === "partial" ||
    summary.status === "complete";
}

function comparisonChartTicks(maxValue, count) {
  const ticks = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push((maxValue * index) / count);
  }
  return ticks;
}

function comparisonXLabels(rows) {
  if (rows.length <= 1) {
    return rows.length ? [{ index: 0, label: rows[0].pa }] : [];
  }
  const labels = new Map();
  const step = Math.max(1, Math.ceil((rows.length - 1) / 6));
  for (let index = 0; index < rows.length; index += step) {
    labels.set(index, rows[index].pa);
  }
  labels.set(rows.length - 1, rows.at(-1).pa);
  return [...labels.entries()].map(([index, label]) => ({ index, label }));
}

function formatCompactUsd(value) {
  const amount = Number(value) || 0;
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}k`;
  }
  return `$${amount.toFixed(0)}`;
}

function formatCompactDuration(durationMs) {
  const hours = Math.max(0, Number(durationMs) || 0) / 3600000;
  if (hours >= 100) {
    return `${Math.round(hours)}h`;
  }
  return `${hours.toFixed(1)}h`;
}

function comparisonTotalForRows(rows, runIndex) {
  return rows.reduce((total, row) => {
    const summary = row.runs?.[runIndex];
    return {
      turns: [...total.turns, ...(summary?.turns ?? [])],
      durationMs: total.durationMs + (summary?.durationMs ?? 0),
      cost: total.cost + (summary?.cost ?? 0),
      status: total.status === "partial" || summary?.status === "partial" ? "partial" : "complete",
    };
  }, { turns: [], durationMs: 0, cost: 0, status: "complete" });
}

function comparisonCellHtml(summary) {
  const turns = Array.isArray(summary?.turns) ? summary.turns.length : 0;
  const status = summary?.status ?? "n/a";
  return `
    <div>${escapeHtml(formatHhhMmSs(summary?.durationMs ?? 0))} / ${escapeHtml(formatUsd(summary?.cost ?? 0))}</div>
    <div class="comparison-meta">${fmtInt(turns)} turn${turns === 1 ? "" : "s"} / ${escapeHtml(status)}</div>
  `;
}

function formatHhhMmSs(durationMs) {
  const seconds = Math.max(0, Math.round((durationMs ?? 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${String(hours).padStart(3, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "n/a";
  }
  return `$${amount.toFixed(2)}`;
}

function hideRunDocsPanel() {
  if (runDocsCard) {
    runDocsCard.hidden = true;
  }
  if (runDocsEl) {
    runDocsEl.innerHTML = "";
  }
}

async function renderRunDocsPanel(run, summary) {
  if (!runDocsCard || !runDocsEl || !state.staticMode || !run || !summary) {
    hideRunDocsPanel();
    return;
  }
  const docs = await loadRunDocs(run, summary);
  if (!docs.length) {
    hideRunDocsPanel();
    return;
  }
  const urlDoc = getUrlParams().doc;
  const selectedDoc =
    docs.find((doc) => doc.name === state.selectedDocName) ??
    docs.find((doc) => doc.name === urlDoc) ??
    preferredRunDoc(docs);
  state.selectedDocName = selectedDoc?.name ?? null;
  if (!selectedDoc) {
    hideRunDocsPanel();
    return;
  }

  const content = await fetchText(staticDataPath(selectedDoc.path));
  const layout = run.assignmentLayout;
  const groups = groupRunDocs(docs);
  runDocsEl.innerHTML = `
    <div class="run-docs-meta">
      <span>${escapeHtml(run.label ?? run.id)}</span>
      ${layout ? `<span>${escapeHtml(layout.label ?? layout.id)}</span>` : ""}
      <span>${fmtInt(docs.length)} docs</span>
    </div>
    <div class="run-docs-body">
      <nav class="run-docs-nav">${groups.map((group) => runDocGroupHtml(group, selectedDoc)).join("")}</nav>
      <pre class="doc-content">${escapeHtml(prettyDocContent(content, selectedDoc))}</pre>
    </div>
  `;
  for (const button of runDocsEl.querySelectorAll("[data-doc-name]")) {
    button.addEventListener("click", () => {
      state.selectedDocName = button.getAttribute("data-doc-name");
      setUrlParam("doc", state.selectedDocName);
      renderRunDocsPanel(run, summary).catch((error) => console.error("run docs render failed", error));
    });
  }
  runDocsCard.hidden = false;
}

async function loadRunDocs(run, summary) {
  if (state.staticRunDocs.has(run.id)) {
    return state.staticRunDocs.get(run.id);
  }
  let docs = Array.isArray(summary.docs) ? summary.docs : [];
  if (!docs.length && run.docsPath) {
    try {
      const index = await fetchJson(staticDataPath(run.docsPath));
      docs = index.docs ?? [];
    } catch (_) {
      docs = [];
    }
  }
  state.staticRunDocs.set(run.id, docs);
  return docs;
}

function preferredRunDoc(docs) {
  return (
    docs.find((doc) => doc.name.endsWith(".config.json")) ??
    docs.find((doc) => /implement.*\.md$/i.test(doc.name)) ??
    docs.find((doc) => /\.md$/i.test(doc.name)) ??
    docs[0] ??
    null
  );
}

function groupRunDocs(docs) {
  const groups = [
    { label: "Config", docs: [] },
    { label: "Prompts", docs: [] },
    { label: "Goals", docs: [] },
    { label: "State", docs: [] },
  ];
  for (const doc of docs) {
    if (doc.name.endsWith(".config.json")) {
      groups[0].docs.push(doc);
    } else if (/goal\.md$/i.test(doc.name) || /-goal\.md$/i.test(doc.name)) {
      groups[2].docs.push(doc);
    } else if (doc.name === "state.json" || doc.name === "current-goal.json") {
      groups[3].docs.push(doc);
    } else {
      groups[1].docs.push(doc);
    }
  }
  return groups.filter((group) => group.docs.length);
}

function runDocGroupHtml(group, selectedDoc) {
  return `
    <div class="run-doc-group">
      <div class="run-doc-group-title">${escapeHtml(group.label)}</div>
      ${group.docs.map((doc) => `
        <button type="button" class="doc-tab ${doc.name === selectedDoc.name ? "is-selected" : ""}" data-doc-name="${escapeHtml(doc.name)}">
          ${escapeHtml(shortDocName(doc.name))}
        </button>
      `).join("")}
    </div>
  `;
}

function shortDocName(name) {
  return String(name ?? "")
    .replace(/^(trusted|phases|fable|opus|spark)\./, "")
    .replace(/\.md$/i, "")
    .replace(/\.json$/i, "");
}

function prettyDocContent(content, doc) {
  if (doc?.kind === "json" || /\.json$/i.test(doc?.name ?? "")) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch (_) {}
  }
  return content;
}

function setViewTitles(summaryText, timelineText) {
  if (summaryTitle) {
    summaryTitle.textContent = summaryText;
  }
  if (timelineTitle) {
    timelineTitle.textContent = timelineText;
  }
}

function setCombinedModeActive(active) {
  document.body.classList.toggle("is-combined-view", active);
}

function isActiveRunMeta(run) {
  const runState = run?.state;
  if (!runState) {
    return false;
  }
  if (runState.matchesCurrent === false || runState.recentlyUpdated === false) {
    return false;
  }
  if (run.id === state.currentRun) {
    return Boolean(runState.activePhase);
  }
  return runState.active === true ||
    (runState.matchesCurrent !== false && Boolean(runState.activePhase));
}

function renderCombinedRuns(runs) {
  const loaded = Array.isArray(runs) ? runs : [];
  const activeCount = loaded.length;
  const errorCount = loaded.filter((entry) => entry.error).length;
  const totalCards = loaded.reduce((sum, entry) => sum + latestCombinedEntries(entry.events).length, 0);
  const latestAt = loaded
    .map((entry) => entry.summary?.last ?? entry.run?.mtime ?? null)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  summaryEl.innerHTML = `
    <div><strong>active</strong>${fmtInt(activeCount)}</div>
    <div><strong>cards</strong>${fmtInt(totalCards)}</div>
    <div><strong>latest</strong>${fmt(latestAt)}</div>
    ${errorCount ? `<div class="summary-wide"><strong>errors</strong>${fmtInt(errorCount)} run${errorCount === 1 ? "" : "s"} failed to load</div>` : ""}
  `;
  eventCountEl.textContent = `${fmtInt(totalCards)} cards / ${fmtInt(activeCount)} active runs`;

  const fragment = document.createDocumentFragment();
  if (!loaded.length) {
    const empty = document.createElement("div");
    empty.className = "combined-empty muted";
    empty.textContent = "No active runs";
    fragment.append(empty);
  }

  for (const entry of loaded) {
    fragment.append(renderCombinedRun(entry));
  }

  timelineEl.replaceChildren(fragment);
  renderCombinedProgressDock(loaded);
}

function renderCombinedRun(entry) {
  const runEl = document.createElement("section");
  runEl.className = "combined-run";
  runEl.dataset.runId = entry.run.id;

  const header = document.createElement("div");
  header.className = "combined-run-header";
  const title = document.createElement("a");
  title.className = "combined-run-title";
  title.href = fullRunHref(entry.run.id);
  title.textContent = entry.run.label ?? entry.run.id;
  header.append(title);

  const details = document.createElement("div");
  details.className = "combined-run-details";
  if (entry.error) {
    details.innerHTML = `<span class="pill pill-bad">${escapeHtml(entry.error.message ?? String(entry.error))}</span>`;
  } else {
    details.innerHTML = runDetailHtml(entry.summary, entry.run, { includeName: false, metaClass: "combined-run-meta" });
  }
  header.append(details);
  runEl.append(header);

  const feed = document.createElement("div");
  feed.className = "combined-run-feed";
  const entries = latestCombinedEntries(entry.events);
  if (!entry.error && entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted combined-run-empty";
    empty.textContent = "No recent cards";
    feed.append(empty);
  }
  entries.forEach((displayEntry, index) => {
    const el = renderDisplayEntry(displayEntry);
    if (!el) {
      return;
    }
    const key = scrollKeyForEntry(displayEntry, index);
    if (key) {
      el.dataset.scrollKey = `combined:${entry.run.id}:${key}`;
    }
    feed.append(el);
  });
  runEl.append(feed);
  return runEl;
}

function latestCombinedEntries(records, limit = COMBINED_RUN_CARD_LIMIT) {
  const filtered = records.filter(shouldShow);
  return buildDisplayEntries(filtered).slice(-limit);
}

function combinedUsageSummary(entries) {
  let usage = null;
  let durationMs = 0;
  for (const entry of entries) {
    const preferred = preferredUsageSummary(entry.summary);
    if (!preferred?.usage) {
      continue;
    }
    usage = addUsage(usage, preferred.usage);
    durationMs += preferred.durationMs ?? 0;
  }
  return usage ? { usage, durationMs } : null;
}

function renderCombinedProgressDock(entries) {
  if (!progressDock) {
    return;
  }
  const activeCount = entries.length;
  const latestAt = entries
    .map((entry) => entry.summary?.last ?? entry.run?.mtime ?? null)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const latest = latestAt ? fmtShort(latestAt) : "";
  progressDock.innerHTML = `
    <strong>Combined</strong>
    <span class="dock-main">${fmtInt(activeCount)} active run${activeCount === 1 ? "" : "s"}</span>
    ${latest ? `<span class="dock-meta">updated ${escapeHtml(latest)}</span>` : ""}
  `;
  updateProgressDockSpace();
}

function fullRunHref(runId) {
  const params = new URLSearchParams(window.location.search);
  params.set("run", runId);
  params.set("view", "run");
  params.delete("turns");
  const qs = params.toString();
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

function isAutoRefreshEnabled() {
  return autoRefreshToggle?.checked ?? false;
}

function captureScrollSnapshot(options = {}) {
  const metrics = getScrollMetrics();
  const stickToBottom =
    options.forceStickToBottom ||
    state.stickToBottomAfterLayout ||
    shouldFollowLiveTail(metrics);
  if (stickToBottom) {
    state.followLiveTail = true;
  }
  const preferScrollTop = options.preferScrollTop === true || state.preferScrollTopAfterLayout;
  return {
    scrollTop: metrics.scrollTop,
    stickToBottom,
    preferScrollTop,
    anchors: stickToBottom || preferScrollTop ? [] : captureScrollAnchors(),
    userScrollVersion: state.userScrollVersion,
  };
}

function restoreScrollAfterRender(snapshot, options = {}) {
  if (!snapshot) {
    return;
  }
  if (options.immediate) {
    scrollDebug("restore-scroll-immediate", { snapshot });
    applyScrollRestoration(snapshot);
  }
  scrollDebug("restore-scroll-scheduled", { snapshot });
  afterNextPaint(() => {
    scrollDebug("restore-scroll-before-apply", { snapshot });
    if (applyScrollRestoration(snapshot)) {
      window.setTimeout(() => applyScrollRestoration(snapshot), 50);
      window.setTimeout(() => applyScrollRestoration(snapshot), 150);
    }
  });
}

function applyScrollRestoration(snapshot) {
  const restoreSnapshot = resolveScrollSnapshot(snapshot);
  if (!restoreSnapshot) {
    scrollDebug("restore-scroll-skipped", { snapshot });
    return false;
  }
  scrollDebug("restore-scroll-apply", { restoreSnapshot });
  if (restoreSnapshot.stickToBottom) {
    scrollToBottomNow();
    return true;
  }
  if (!restoreSnapshot.preferScrollTop && restoreScrollAnchor(restoreSnapshot)) {
    return true;
  }
  setScrollTop(restoreSnapshot.scrollTop, "restore-scroll-snapshot");
  return true;
}

function resolveScrollSnapshot(snapshot) {
  if (snapshot.userScrollVersion === state.userScrollVersion) {
    return snapshot;
  }
  const layoutSnapshot = state.latestLayoutScrollSnapshot;
  if (
    layoutSnapshot &&
    layoutSnapshot.userScrollVersion === state.userScrollVersion &&
    layoutSnapshot.userScrollVersion > snapshot.userScrollVersion
  ) {
    return layoutSnapshot;
  }
  return null;
}

function captureScrollAnchors() {
  const viewportTop = scrollViewportTop();
  const viewportBottom = scrollViewportBottom();
  const anchors = [];

  for (const element of timelineEl.querySelectorAll("[data-scroll-key]")) {
    const key = element.dataset.scrollKey;
    if (!key) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= viewportTop || rect.top >= viewportBottom) {
      continue;
    }
    anchors.push({
      key,
      offset: rect.top - viewportTop,
      distance: Math.abs(rect.top - viewportTop),
    });
  }

  anchors.sort((a, b) => a.distance - b.distance);
  return anchors.slice(0, 12).map(({ key, offset }) => ({ key, offset }));
}

function restoreScrollAnchor(snapshot) {
  const anchors = Array.isArray(snapshot?.anchors) ? snapshot.anchors : [];
  if (!anchors.length) {
    return false;
  }

  const root = scrollingRoot();
  for (const anchor of anchors) {
    const element = findScrollAnchor(anchor.key);
    if (!element) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const currentOffset = rect.top - scrollViewportTop();
    const delta = currentOffset - anchor.offset;
    if (Number.isFinite(delta)) {
      const targetTop = root.scrollTop + delta;
      const maxExpectedShift = Math.max(1000, root.clientHeight * 2);
      if (Math.abs(targetTop - snapshot.scrollTop) > maxExpectedShift) {
        scrollDebug("restore-anchor-rejected", {
          anchor,
          targetTop,
          maxExpectedShift,
          element: describeElementForScroll(element),
          rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
          snapshotScrollTop: snapshot.scrollTop,
        });
        continue;
      }
      scrollDebug("restore-anchor-selected", {
        anchor,
        targetTop,
        element: describeElementForScroll(element),
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      });
      setScrollTop(targetTop, "restore-scroll-anchor");
      return true;
    }
  }
  return false;
}

function findScrollAnchor(key) {
  for (const element of timelineEl.querySelectorAll("[data-scroll-key]")) {
    if (element.dataset.scrollKey === key) {
      return element;
    }
  }
  return null;
}

function afterNextPaint(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function scrollToBottomNow() {
  const root = scrollingRoot();
  const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
  state.followLiveTail = true;
  setScrollTop(maxTop, "scrollToBottomNow");
}

function setScrollTop(value, reason = "setScrollTop") {
  const root = scrollingRoot();
  const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
  const top = Math.min(Math.max(0, value), maxTop);
  const before = root.scrollTop;
  state.lastProgrammaticScrollAt = performance.now();
  state.lastProgrammaticScrollReason = reason;
  scrollDebug("set-scroll-top-before", { reason, requested: value, top, before, maxTop });
  if (typeof root.scrollTo === "function") {
    root.scrollTo({ top, behavior: "auto" });
  } else {
    root.scrollTop = top;
  }
  state.lastObservedScrollTop = top;
  window.setTimeout(() => {
    scrollDebug("set-scroll-top-after", {
      reason,
      requested: value,
      top,
      before,
      after: scrollingRoot().scrollTop,
    });
  }, 0);
}

function getScrollMetrics() {
  const root = scrollingRoot();
  const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
  const scrollTop = Math.min(Math.max(0, root.scrollTop), maxTop);
  return {
    scrollTop,
    maxTop,
    distanceFromBottom: Math.max(0, maxTop - scrollTop),
  };
}

function shouldFollowLiveTail(metrics = getScrollMetrics()) {
  if (metrics.distanceFromBottom <= bottomStickyThresholdPx()) {
    return true;
  }
  const recentUserIntent = performance.now() - state.lastUserScrollAt < 1000;
  const userMayHaveMovedAway =
    recentUserIntent && state.lastUserScrollAt > state.lastProgrammaticScrollAt;
  return state.followLiveTail && !userMayHaveMovedAway;
}

function bottomStickyThresholdPx() {
  return BOTTOM_STICKY_PX + bottomReservePx();
}

function bottomReservePx() {
  const computed = window.getComputedStyle?.(document.body);
  const paddingBottom = Number.parseFloat(computed?.paddingBottom ?? "");
  if (Number.isFinite(paddingBottom) && paddingBottom > 0) {
    return paddingBottom;
  }
  return state.progressDockSpacePx ?? 0;
}

function scrollingRoot() {
  return document.scrollingElement || document.documentElement;
}

function scrollViewportTop() {
  return 0;
}

function scrollViewportBottom() {
  const root = scrollingRoot();
  return root.clientHeight || window.innerHeight || document.documentElement.clientHeight || 0;
}

function isMobileScrollViewport() {
  if (window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches) {
    return true;
  }
  return (navigator.maxTouchPoints ?? 0) > 0 && Math.min(window.innerWidth, window.innerHeight) <= 900;
}

function markMobileScrollPause(source = "unknown", pauseMs = MOBILE_SCROLL_REFRESH_PAUSE_MS) {
  if (!isMobileScrollViewport()) {
    return;
  }
  const until = performance.now() + pauseMs;
  state.mobileScrollPauseUntil = Math.max(state.mobileScrollPauseUntil, until);
  scrollDebug("mobile-scroll-refresh-pause", {
    source,
    pauseMs,
    remainingMs: Math.max(0, Math.round(state.mobileScrollPauseUntil - performance.now())),
  });
}

function shouldPauseRefreshForMobileScroll() {
  if (!isMobileScrollViewport()) {
    return false;
  }
  return performance.now() < state.mobileScrollPauseUntil;
}

function scrollDebug(label, extra = {}) {
  if (!state.scrollDebugEnabled) {
    return;
  }
  const root = scrollingRoot();
  const metrics = getScrollMetrics();
  const active = document.activeElement;
  const payload = {
    label,
    clientAt: new Date().toISOString(),
    pageId: state.scrollDebugPageId,
    seq: ++state.scrollDebugSeq,
    selectedRun: state.selectedRun,
    userScrollVersion: state.userScrollVersion,
    url: window.location.href,
    metrics,
    rawScrollTop: root.scrollTop,
    viewport: {
      innerHeight: window.innerHeight,
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight,
    },
    activeElement: active ? {
      tag: active.tagName,
      id: active.id || "",
      className: typeof active.className === "string" ? active.className : "",
      text: truncate(cleanText(active.textContent), 120),
    } : null,
    openTurns: [...timelineEl.querySelectorAll(".turn.is-open")]
      .map(el => el.dataset.turn)
      .filter(Boolean),
    openEntries: timelineEl.querySelectorAll(".accordion.is-open[data-entry-key]").length,
    timelineChildren: timelineEl.children.length,
    extra,
  };
  console.debug("[ralph-viz scroll]", payload);
  if (state.staticMode) {
    return;
  }
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/debug-scroll", blob)) {
        return;
      }
    } catch (_) {}
  }
  fetch("/api/debug-scroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function describeElementForScroll(element) {
  if (!element) {
    return null;
  }
  return {
    tag: element.tagName,
    id: element.id || "",
    className: typeof element.className === "string" ? element.className : "",
    scrollKey: element.dataset?.scrollKey ?? "",
    entryKey: element.dataset?.entryKey ?? "",
    turn: element.dataset?.turn ?? "",
    text: truncate(cleanText(element.textContent), 120),
  };
}

function handleObservedScroll() {
  const metrics = getScrollMetrics();
  const now = performance.now();
  const recentProgrammatic = now - state.lastProgrammaticScrollAt < 300;
  const recentUserIntent = now - state.lastUserScrollAt < 1000 &&
    state.lastUserScrollAt > state.lastProgrammaticScrollAt;
  if (isMobileScrollViewport() && recentUserIntent && !recentProgrammatic) {
    markMobileScrollPause("scroll");
  }
  if (metrics.distanceFromBottom <= bottomStickyThresholdPx()) {
    state.followLiveTail = true;
  } else if (recentUserIntent && !recentProgrammatic) {
    state.followLiveTail = false;
  }

  if (!state.scrollDebugEnabled) {
    return;
  }
  const previous = state.lastObservedScrollTop;
  state.lastObservedScrollTop = metrics.scrollTop;
  if (previous == null) {
    scrollDebug("scroll-observed-initial", { metrics });
    return;
  }
  const delta = metrics.scrollTop - previous;
  if (Math.abs(delta) >= SCROLL_JUMP_LOG_PX) {
    scrollDebug("scroll-observed-jump", {
      previous,
      delta,
      sinceUserMs: Math.round(performance.now() - state.lastUserScrollAt),
      sinceProgrammaticMs: Math.round(performance.now() - state.lastProgrammaticScrollAt),
      lastProgrammaticScrollReason: state.lastProgrammaticScrollReason,
      metrics,
    });
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!isAutoRefreshEnabled()) {
    return;
  }
  state.autoRefreshTimer = window.setInterval(refreshActiveRun, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function markUserScrollIntent(source = "unknown") {
  state.lastUserScrollAt = performance.now();
  state.userScrollVersion += 1;
  state.latestLayoutScrollSnapshot = null;
  state.stickToBottomAfterLayout = false;
  state.preferScrollTopAfterLayout = false;
  if (source.startsWith("touch") || source.startsWith("pointer")) {
    markMobileScrollPause(source);
  }
  scrollDebug("user-scroll-intent", { source });
}

function markLayoutScrollIntent(preLayoutSnapshot = null) {
  state.userScrollVersion += 1;
  state.stickToBottomAfterLayout =
    state.stickToBottomAfterLayout || preLayoutSnapshot?.stickToBottom === true;
  state.preferScrollTopAfterLayout = true;
  state.latestLayoutScrollSnapshot = captureScrollSnapshot({
    forceStickToBottom: state.stickToBottomAfterLayout,
    preferScrollTop: true,
  });
  scrollDebug("layout-scroll-intent", {
    preLayoutSnapshot,
    latestLayoutScrollSnapshot: state.latestLayoutScrollSnapshot,
  });
  return state.latestLayoutScrollSnapshot;
}

function renderTimelinePreservingScroll() {
  const scrollSnapshot = captureScrollSnapshot();
  scrollDebug("render-preserving-scroll", { scrollSnapshot });
  if (isCombinedView()) {
    renderCombinedRuns(state.combinedRuns);
  } else {
    renderTimeline(state.events);
  }
  restoreScrollAfterRender(scrollSnapshot, { immediate: true });
}

function rerenderCurrentViewPreservingScroll() {
  if (!isRunsPage()) {
    loadRuns({
      preserveSelection: true,
      ignoreUrl: true,
      scrollSnapshot: captureScrollSnapshot(),
    }).catch((error) => console.error("view refresh failed", error));
    return;
  }
  renderTimelinePreservingScroll();
}

async function refreshActiveRun() {
  if (!isAutoRefreshEnabled() || state.refreshInFlight) {
    scrollDebug("refresh-skipped", {
      autoRefresh: isAutoRefreshEnabled(),
      refreshInFlight: state.refreshInFlight,
    });
    return;
  }
  if (shouldPauseRefreshForMobileScroll()) {
    scrollDebug("refresh-skipped-mobile-scroll", {
      remainingMs: Math.max(0, Math.round(state.mobileScrollPauseUntil - performance.now())),
    });
    return;
  }
  state.refreshInFlight = true;
  try {
    const scrollSnapshot = captureScrollSnapshot();
    scrollDebug("refresh-start", { scrollSnapshot });
    if (state.selectedRun) {
      await loadRuns({ preserveSelection: true, ignoreUrl: true, scrollSnapshot });
    } else {
      await loadRuns({ scrollSnapshot });
    }
    scrollDebug("refresh-complete", { scrollSnapshot });
  } catch (error) {
    console.error("auto-refresh failed", error);
    scrollDebug("refresh-error", { message: error?.message ?? String(error) });
  } finally {
    state.refreshInFlight = false;
  }
}

// --- Bind ---

refreshRuns.addEventListener("click", () => loadRuns({
  preserveSelection: true,
  ignoreUrl: true,
  scrollSnapshot: captureScrollSnapshot(),
}));
reloadRun.addEventListener("click", () => {
  const scrollSnapshot = captureScrollSnapshot();
  if (!isRunsPage()) {
    loadRuns({ preserveSelection: true, ignoreUrl: true, scrollSnapshot });
    return;
  }
  if (isCombinedView()) {
    loadRuns({ preserveSelection: true, ignoreUrl: true, scrollSnapshot });
  } else {
    loadRun(state.selectedRun, { scrollSnapshot });
  }
});
runSelect.addEventListener("change", e => {
  if (currentViewerMode() === "compare") {
    state.selectedRun = e.target.value;
    setUrlParam("run", e.target.value);
    return;
  }
  if (combinedViewToggle?.checked) {
    combinedViewToggle.checked = false;
    setUrlParam("view", "run");
  }
  loadRun(e.target.value);
});
if (viewerMode) {
  viewerMode.addEventListener("change", () => {
    const mode = currentViewerMode();
    setUrlParam("page", mode === "runs" ? null : mode);
    loadRuns({
      preserveSelection: true,
      ignoreUrl: true,
      scrollSnapshot: captureScrollSnapshot({ preferScrollTop: true }),
    }).catch((error) => console.error("view mode change failed", error));
  });
}
if (codexDetail) {
  codexDetail.addEventListener("change", () => {
    const scrollSnapshot = captureScrollSnapshot();
    if (!isRunsPage()) {
      return;
    }
    if (isCombinedView()) {
      loadRuns({ preserveSelection: true, ignoreUrl: true, scrollSnapshot });
    } else {
      loadRun(state.selectedRun, { scrollSnapshot });
    }
  });
}
eventFilter.addEventListener("input", rerenderCurrentViewPreservingScroll);
hideNoiseToggle.addEventListener("change", rerenderCurrentViewPreservingScroll);
if (combinedViewToggle) {
  combinedViewToggle.addEventListener("change", () => {
    setUrlParam("view", combinedViewToggle.checked ? null : "run");
    loadRuns({
      preserveSelection: true,
      ignoreUrl: true,
      scrollSnapshot: captureScrollSnapshot({ preferScrollTop: true }),
    });
  });
}
if (fullViewToggle) {
  fullViewToggle.addEventListener("change", rerenderCurrentViewPreservingScroll);
}
window.addEventListener("scroll", handleObservedScroll, { passive: true });
window.addEventListener("resize", scheduleProgressDockSpaceUpdate, { passive: true });
window.addEventListener("focusin", (event) => {
  scrollDebug("focusin", { target: describeElementForScroll(event.target) });
}, { passive: true });
window.addEventListener("wheel", () => markUserScrollIntent("wheel"), { passive: true });
window.addEventListener("touchstart", () => markUserScrollIntent("touchstart"), { passive: true });
window.addEventListener("touchmove", () => markUserScrollIntent("touchmove"), { passive: true });
window.addEventListener("touchend", () => markMobileScrollPause("touchend"), { passive: true });
window.addEventListener("touchcancel", () => markMobileScrollPause("touchcancel"), { passive: true });
window.addEventListener("pointerdown", () => markUserScrollIntent("pointerdown"), { passive: true });
window.addEventListener("keydown", (event) => {
  if (SCROLL_KEYS.has(event.key)) {
    markUserScrollIntent(`keydown:${event.key}`);
  }
});
if (autoRefreshToggle) {
  autoRefreshToggle.addEventListener("change", () => {
    rerenderCurrentViewPreservingScroll();
    if (autoRefreshToggle.checked) {
      startAutoRefresh();
      refreshActiveRun();
    } else {
      stopAutoRefresh();
    }
  });
}

scrollDebug("app-loaded", {
  userAgent: navigator.userAgent,
  debugEnabled: state.scrollDebugEnabled,
});

initializeViewControls();

loadRuns().catch(err => {
  summaryEl.innerHTML = `<div><strong>error</strong>${err.message}</div>`;
}).finally(() => {
  startAutoRefresh();
});
