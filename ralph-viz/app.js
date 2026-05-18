const runSelect = document.getElementById("runSelect");
const refreshRuns = document.getElementById("refreshRuns");
const reloadRun = document.getElementById("reloadRun");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const progressDock = document.getElementById("progressDock");
const eventFilter = document.getElementById("eventFilter");
const eventCountEl = document.getElementById("eventCount");
const hideNoiseToggle = document.getElementById("hideNoise");
const autoRefreshToggle = document.getElementById("autoRefresh");
const fullViewToggle = document.getElementById("fullView");

const AUTO_REFRESH_MS = 2500;
const BOTTOM_STICKY_PX = 32;
const COMPACT_TURN_CARD_LIMIT = 50;
const ACTIVE_EVENT_GAP_MS = 10 * 60 * 1000;

const API_PRICE_RATES = new Map([
  ["gpt-5.5", { input: 5.00, cachedInput: 0.50, output: 30.00 }],
  ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.50 }],
  ["gpt-5.4", { input: 2.50, cachedInput: 0.25, output: 15.00 }],
]);

const state = {
  runs: [],
  selectedRun: null,
  currentRun: null,
  shapeUsage: null,
  events: [],
  raw: [],
  autoRefreshTimer: null,
  refreshInFlight: false,
  openEntryKeys: new Set(),
  userScrollVersion: 0,
  latestLayoutScrollSnapshot: null,
  stickToBottomAfterLayout: false,
  preferScrollTopAfterLayout: false,
};

// Noise event types that clutter the view
const NOISE_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "error", "codex.session.token_count", "ralph.test-status",
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

function buildSummary(events, shapeUsage = null) {
  const turnSet = new Set();
  for (const r of events) {
    const turn = displayTurnForRecord(r);
    if (Number.isInteger(turn)) turnSet.add(turn);
  }
  const first = events.at(0)?.recordedAt ?? null;
  const last = events.at(-1)?.recordedAt ?? null;
  const priceModel = inferPriceModel();

  const typeCounts = new Map();
  for (const r of events) {
    const t = r.eventType ?? "unknown";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }

  return {
    threadId: events.at(0)?.threadId ?? "n/a",
    events: events.length,
    turns: turnSet.size,
    first, last,
    activeDurationMs: activeEventDurationMs(events),
    tokenUsage: latestCumulativeUsage(events),
    shapeUsage: normalizeShapeUsage(shapeUsage),
    priceModel,
    latestTurn: latestTurnOverview(events, priceModel),
    latestPhaseStatus: latestPhaseStatus(events),
    testProgress: buildAgentTestProgressState(events),
    latestTestStatus: latestTestStatus(events),
    typeStats: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function latestTurnOverview(events, priceModel) {
  const turn = latestNumericTurn(events);
  if (turn == null) {
    return null;
  }
  const duration = durationText(buildTurnDurationMap(events).get(turn));
  const usage = buildUsageMap(events).get(turn);
  const cost = usage ? costEstimateText(usage, priceModel) : "n/a";
  return { turn, duration, cost };
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
  if (Number.isInteger(record.turnNumber) && record.turnNumber > 0) {
    return record.turnNumber;
  }
  return "setup";
}

function renderSummary(events) {
  const s = buildSummary(events, state.shapeUsage);
  const chips = s.typeStats.slice(0, 8)
    .map(([type, count]) => `<span class="pill">${type}: ${count}</span>`)
    .join(" ");
  const usage = preferredUsageSummary(s);
  const usageText = usage
    ? usageSummaryText(usage.usage, s.priceModel, {
        durationMs: usage.durationMs,
        includeModel: true,
        suffix: usage.suffix,
      })
    : '<span class="muted">n/a</span>';
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
    <div class="summary-wide"><strong>phase</strong>${phaseText}</div>
    <div class="summary-wide"><strong>test progress</strong>${progressText}</div>
    <div class="summary-wide"><strong>usage</strong>${usageText}</div>
    <div style="grid-column:1/-1"><strong>types</strong>${chips || '<span class="muted">none</span>'}</div>
  `;
  renderProgressDock(s);
}

function renderProgressDock(summary) {
  if (!progressDock) {
    return;
  }
  const run = selectedRunMeta();
  const progress = summary?.testProgress?.latest ?? null;
  const testStatus = summary?.latestTestStatus?.status ?? null;
  const phaseStatus = summary?.latestPhaseStatus?.status ?? null;
  const latestTurn = summary?.latestTurn ?? null;
  const usage = preferredUsageSummary(summary);
  const latest = summary?.last ? fmtShort(summary.last) : "";
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
  const updatedHtml = latest ? `<span class="dock-meta">updated ${escapeHtml(latest)}</span>` : "";
  progressDock.innerHTML = `
    <strong>${escapeHtml(run?.label ?? state.selectedRun ?? "No run")}</strong>
    ${turnHtml}
    ${usageHtml}
    ${phaseHtml}
    ${progressHtml}
    ${testHtml}
    ${updatedHtml}
  `;
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
  })}`;
}

// --- Display entry building (merge command start/end) ---

function buildDisplayEntries(records) {
  const entries = [];
  const cmdStarts = new Map();
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
    if (record.eventType === "item.completed" && isCmd && item.id && cmdStarts.has(item.id)) {
      cmdStarts.get(item.id).endRecord = record;
      cmdStarts.delete(item.id);
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

// --- Card renderers ---

function renderCommandCard(entry) {
  const startItem = entry.startRecord?.event?.item ?? {};
  const endItem = entry.endRecord?.event?.item ?? {};
  const item = entry.endRecord ? endItem : startItem;
  const cmd = unwrapCommand(item.command || startItem.command) || "unknown command";
  const output = cleanText(item.aggregated_output);
  const exitCode = item.exit_code;
  const time = fmtShort(entry.endRecord?.recordedAt ?? entry.startRecord?.recordedAt);

  const card = document.createElement("details");
  card.className = "ev ev-cmd" + (exitCode != null && exitCode !== 0 ? " ev-cmd-fail" : "");
  restoreExpandableState(card, commandEntryKey(entry));

  const summary = document.createElement("summary");
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

  card.append(summary);

  if (output) {
    const pre = document.createElement("pre");
    pre.className = "cmd-output";
    if (output.length > 2000) {
      pre.textContent = output.slice(0, 2000);
      const more = document.createElement("button");
      more.className = "btn-more";
      more.textContent = `Show all (${output.length} chars)`;
      more.onclick = () => {
        const scrollSnapshot = captureScrollSnapshot();
        pre.textContent = output;
        more.remove();
        markLayoutScrollIntent(scrollSnapshot);
      };
      card.append(pre, more);
    } else {
      pre.textContent = output;
      card.append(pre);
    }
  }

  return card;
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

function restoreExpandableState(details, key) {
  if (!key) {
    return;
  }
  details.dataset.entryKey = key;
  details.dataset.scrollKey = key;
  details.open = state.openEntryKeys.has(key);
  attachPreToggleScrollSnapshot(details);
  addDetailsToggleHandler(details, () => {
    if (details.open) {
      state.openEntryKeys.add(key);
    } else {
      state.openEntryKeys.delete(key);
    }
    markLayoutScrollIntent(takePreToggleScrollSnapshot(details));
  });
}

function addDetailsToggleHandler(details, handler) {
  details.addEventListener("toggle", () => {
    if (!details._userTogglePending) {
      return;
    }
    details._userTogglePending = false;
    handler();
  });
}

function attachPreToggleScrollSnapshot(details) {
  details.addEventListener("pointerdown", (event) => {
    if (isDirectSummaryEvent(details, event)) {
      details._preToggleScrollSnapshot = captureScrollSnapshot();
      details._userTogglePending = true;
    }
  }, { capture: true });
  details.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && isDirectSummaryEvent(details, event)) {
      details._preToggleScrollSnapshot = captureScrollSnapshot();
      details._userTogglePending = true;
    }
  }, { capture: true });
}

function takePreToggleScrollSnapshot(details) {
  const snapshot = details._preToggleScrollSnapshot ?? null;
  details._preToggleScrollSnapshot = null;
  return snapshot;
}

function isDirectSummaryEvent(details, event) {
  const summary = event.target?.closest?.("summary");
  return summary?.parentElement === details;
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

  const card = document.createElement("details");
  card.className = "ev ev-file";
  restoreExpandableState(card, fileChangeEntryKey(record));
  const summary = document.createElement("summary");
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
    if (c.diff) {
      const pre = document.createElement("pre");
      pre.className = "file-diff";
      pre.textContent = c.diff;
      list.append(pre);
    }
  }

  card.append(summary, list);
  return card;
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

  const card = document.createElement("details");
  card.className = "ev ev-todo";
  const summary = document.createElement("summary");
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

  card.append(summary, list);
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

  const card = document.createElement("details");
  const isError = respVal.status === "error";
  card.className = "ev ev-cmd" + (isError ? " ev-cmd-fail" : "");
  restoreExpandableState(card, geminiToolEntryKey(entry));

  const summary = document.createElement("summary");
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

  card.append(summary);

  if (output) {
    const pre = document.createElement("pre");
    pre.className = "cmd-output";
    if (output.length > 2000) {
      pre.textContent = output.slice(0, 2000);
      const more = document.createElement("button");
      more.className = "btn-more";
      more.textContent = `Show all (${output.length} chars)`;
      more.onclick = () => {
        const scrollSnapshot = captureScrollSnapshot();
        pre.textContent = output;
        more.remove();
        markLayoutScrollIntent(scrollSnapshot);
      };
      card.append(pre, more);
    } else {
      pre.textContent = output;
      card.append(pre);
    }
  } else if (!responseRecord) {
    // No response yet — show args as fallback
    const argText = JSON.stringify(args, null, 2);
    if (argText && argText !== "{}") {
      const pre = document.createElement("pre");
      pre.className = "cmd-output";
      pre.textContent = argText;
      card.append(pre);
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
  if (record.eventType === "item.started" && item?.type === "todo_list")
    return renderTodoCard(record);

  // System / noise
  return renderSystemCard(record);
}

function scrollKeyForEntry(entry, index = null) {
  if (entry.kind === "command") return commandEntryKey(entry);
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

function buildTurnDurationMap(records) {
  const map = new Map();
  for (const record of records) {
    const turn = displayTurnForRecord(record);
    const time = Date.parse(record.recordedAt ?? "");
    if (!Number.isFinite(time)) {
      continue;
    }
    const span = map.get(turn) ?? { first: time, last: time };
    span.first = Math.min(span.first, time);
    span.last = Math.max(span.last, time);
    map.set(turn, span);
  }
  return map;
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

function activeEventDurationMs(records) {
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

function inferPriceModel() {
  const text = `${state.selectedRun ?? ""} ${runSelect.selectedOptions?.[0]?.textContent ?? ""}`.toLowerCase();
  return [...API_PRICE_RATES.keys()]
    .sort((a, b) => b.length - a.length)
    .find((model) => text.includes(model)) ?? null;
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
  return {
    input_tokens: Math.max(0, input),
    cached_input_tokens: Math.max(0, cached),
    output_tokens: Math.max(0, output),
    reasoning_output_tokens: Math.max(0, reasoning),
    total_tokens: Math.max(0, total),
  };
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
  return (
    a.total_tokens < b.total_tokens ||
    a.input_tokens < b.input_tokens ||
    a.output_tokens < b.output_tokens ||
    a.cached_input_tokens < b.cached_input_tokens ||
    a.reasoning_output_tokens < b.reasoning_output_tokens
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

function latestCumulativeUsage(records) {
  const tokenRecords = tokenCountRecords(records);
  if (tokenRecords.length) {
    return cumulativeUsageFromTokenRecords(tokenRecords);
  }

  let total = emptyUsage();
  for (const usage of buildUsageMap(records).values()) {
    total = addUsage(total, usage);
  }
  return hasTokenUsage(total) ? total : null;
}

function cumulativeUsageFromTokenRecords(tokenRecords) {
  let total = emptyUsage();
  let previous = null;
  for (const record of tokenRecords) {
    const current = normalizeUsage(record.event.usage);
    if (!hasTokenUsage(current)) {
      continue;
    }
    total = addUsage(total, usageDelta(current, previous));
    previous = current;
  }
  return hasTokenUsage(total) ? total : null;
}

function apiCostEstimate(usage, model) {
  const normalized = normalizeUsage(usage);
  const rates = model ? API_PRICE_RATES.get(model) : null;
  if (!normalized || !rates) return null;
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncached = Math.max(0, normalized.input_tokens - cached);
  return (
    (uncached * rates.input +
      cached * rates.cachedInput +
      normalized.output_tokens * rates.output) /
    1_000_000
  );
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
  const cost = costEstimateText(normalized, model, { includeModel: options.includeModel });
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
  if (tokenRecords.length) {
    let previous = null;
    for (const record of tokenRecords) {
      const current = normalizeUsage(record.event.usage);
      const delta = usageDelta(current, previous);
      previous = current;
      if (!hasTokenUsage(delta)) continue;
      const turn = displayTurnForRecord(record);
      map.set(turn, addUsage(map.get(turn), delta));
    }
    return map;
  }

  for (const r of records) {
    // Codex: turn.completed has usage
    if (r.eventType === "turn.completed" && r.event?.usage) {
      const turn = displayTurnForRecord(r);
      map.set(turn, normalizeUsage(r.event.usage));
    }
    // Gemini: finished events have usageMetadata — accumulate per turn
    if (r.eventType === "finished" && r.event?.value?.usageMetadata) {
      const turn = displayTurnForRecord(r);
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
  for (const r of records) {
    if (r.eventType === "ralph.test-status" && r.event?.testStatus) {
      const turn = displayTurnForRecord(r);
      map.set(turn, r.event.testStatus);
    } else if (r.eventType === "ralph.phase-status" && r.event?.phaseStatus?.testStatus) {
      const turn = displayTurnForRecord(r);
      map.set(turn, r.event.phaseStatus.testStatus);
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
    map.set(turn, mergeTestStatus(map.get(turn), derived));
  }
  return map;
}

function buildPhaseStatusMap(records) {
  const map = new Map();
  for (const r of records) {
    const candidate = phaseStatusCandidateFromRecord(r);
    if (!candidate) {
      continue;
    }
    const turn = displayTurnForRecord(r);
    const previous = map.get(turn);
    if (!previous || candidate.priority >= previous.priority) {
      map.set(turn, candidate);
    }
  }
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
    const time = Date.parse(r.recordedAt ?? "");
    const sortableTime = Number.isFinite(time) ? time : 0;
    if (
      !selectedStatus ||
      sortableTime > selectedTime ||
      (sortableTime === selectedTime && candidate.priority >= selectedPriority)
    ) {
      selectedTurn = displayTurnForRecord(r);
      selectedStatus = candidate.status;
      selectedTime = sortableTime;
      selectedPriority = candidate.priority;
    }
  }
  return selectedStatus == null ? null : { turn: selectedTurn, status: selectedStatus };
}

function phaseStatusCandidateFromRecord(record) {
  if (record.eventType === "ralph.phase-status" && record.event?.phaseStatus) {
    return { priority: 2, status: record.event.phaseStatus };
  }
  if (record.eventType === "ralph.prompt") {
    const inferred = inferPhaseStatusFromPrompt(record.event?.prompt);
    return inferred ? { priority: 1, status: inferred } : null;
  }
  return null;
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
  const tracker = {
    stageTotals: new Map(),
    stageBest: new Map(),
    latest: null,
  };
  const byTurn = new Map();

  for (const record of records) {
    seedAgentTestProgressTracker(tracker, record);

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
    byTurn.set(progress.turn, progress);
  }

  return { byTurn, latest: tracker.latest };
}

function seedAgentTestProgressTracker(tracker, record) {
  if (record.eventType !== "ralph.test-status") {
    return;
  }
  const testStatus = record.event?.testStatus;
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
  };
}

function parseActiveTestReportStages(text) {
  const match = text.match(/\bACTIVE_TEST_REPORT_PAS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return [...raw.matchAll(/\bpa\d+\b/g)].map((stage) => stage[0]);
}

function deriveAgentTestProgress(record, commandInfo, tracker) {
  const item = record.event?.item ?? {};
  const output = cleanText(item.aggregated_output);
  if (!output) {
    return null;
  }

  const stageProgress = parseStageProgressFromAgentOutput(output, commandInfo.stage);
  for (const progress of stageProgress.values()) {
    updateKnownStageTotal(tracker, progress.stage, progress.total);
  }

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
  const total = Math.max(passed, summary.testsTotal - priorTotal);
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
    return {
      stage: stages[0],
      passed: summary.testsPassed,
      total: summary.testsTotal,
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
  updateKnownStageTotal(tracker, observation.stage, observation.total);

  const knownTotal = Math.max(observation.total, tracker.stageTotals.get(observation.stage) ?? 0);
  const current = {
    passed: Math.min(observation.passed, knownTotal || observation.passed),
    total: knownTotal,
  };
  const previousBest = tracker.stageBest.get(observation.stage);
  const best =
    !previousBest || current.passed >= previousBest.passed
      ? { ...current, recordedAt: observation.recordedAt }
      : previousBest;
  const normalizedBest = {
    ...best,
    total: Math.max(best.total ?? 0, knownTotal),
  };

  tracker.stageBest.set(observation.stage, normalizedBest);
  const progress = {
    ...observation,
    current,
    best: normalizedBest,
  };
  tracker.latest = progress;
  return progress;
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
    const targets = [...state.targets.values()];
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
  if (status.stage) parts.push(status.stage);
  if (status.allRequiredPassed) {
    parts.push("checks pass");
  } else {
    parts.push(phaseChecksText(status) || "checks incomplete");
  }
  return parts.join(" / ");
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
  const options = renderTimeline.pendingOptions ?? {};
  renderTimeline.pendingOptions = {};
  rememberOpenEntryKeys();
  const usageMap = buildUsageMap(records);
  const testMap = buildTestStatusMap(records);
  const phaseMap = buildPhaseStatusMap(records);
  const durationMap = buildTurnDurationMap(records);
  const progressMap = buildAgentTestProgressState(records).byTurn;
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
    const details = document.createElement("details");
    details.className = "turn";
    details.dataset.turn = String(turn);
    attachPreToggleScrollSnapshot(details);

    // Open turns from URL, or default to last turn
    if (hasUrlTurns ? urlTurns.includes(String(turn)) : turn === lastTurn) {
      details.open = true;
    }

    addDetailsToggleHandler(details, () => {
      syncOpenTurnsToUrl();
      markLayoutScrollIntent(takePreToggleScrollSnapshot(details));
    });

    const summary = document.createElement("summary");
    summary.className = "turn-header";
    summary.dataset.scrollKey = turnScrollKey(turn);
    const label = turn === "setup" ? "Setup" : `Turn ${turn}`;
    const usage = usageMap.get(turn);
    const ts = testMap.get(turn);
    const phase = phaseMap.get(turn);
    const progress = progressMap.get(turn);
    const duration = durationText(durationMap.get(turn));
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
    details.append(summary);

    const feed = document.createElement("div");
    feed.className = "turn-feed";
    entryWindow.entries.forEach((entry, offset) => {
      const el = renderDisplayEntry(entry);
      if (el) {
        if (!el.dataset.scrollKey) {
          const entryIndex = entryWindow.indices?.[offset] ?? entryWindow.startIndex + offset;
          const key = scrollKeyForEntry(entry, entryIndex);
          if (key) {
            el.dataset.scrollKey = key;
          }
        }
        feed.append(el);
      }
    });
    details.append(feed);
    fragment.append(details);
  }
  timelineEl.replaceChildren(fragment);
}

function turnScrollKey(turn) {
  return `turn:${turn}`;
}

function rememberOpenEntryKeys() {
  for (const details of timelineEl.querySelectorAll("details[data-entry-key]")) {
    const key = details.dataset.entryKey;
    if (!key) {
      continue;
    }
    if (details.open) {
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
    turns: p.get("turns")?.split(",").filter(Boolean) ?? [],
  };
}

function setUrlParam(key, value) {
  const p = new URLSearchParams(window.location.search);
  if (value == null || value === "") p.delete(key);
  else p.set(key, value);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

function syncOpenTurnsToUrl() {
  const open = [];
  for (const el of timelineEl.querySelectorAll("details.turn[open]")) {
    const t = el.dataset.turn;
    if (t) open.push(t);
  }
  setUrlParam("turns", open.length ? open.join(",") : null);
}

// --- Data loading ---

async function loadRuns(options = {}) {
  const [stateData, data] = await Promise.all([
    fetch("/api/state").then(r => r.json()),
    fetch("/api/runs").then(r => r.json()),
  ]);
  state.currentRun = stateData.currentThread ?? null;
  state.runs = data.runs ?? [];

  runSelect.innerHTML = "";
  if (!state.runs.length) {
    const opt = document.createElement("option");
    opt.textContent = "No runs found";
    runSelect.append(opt);
    summaryEl.innerHTML = "";
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    state.shapeUsage = null;
    if (progressDock) {
      progressDock.innerHTML = '<span class="muted">No runs found</span>';
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
  await loadRun(preferred, {
    stickToBottom: options.stickToBottom,
    scrollSnapshot: options.scrollSnapshot,
  });
}

async function loadRun(id, options = {}) {
  if (!id) return;
  state.selectedRun = id;
  setUrlParam("run", id);
  const data = await fetch(`/api/run/${encodeURIComponent(id)}`).then(r => {
    if (!r.ok) throw new Error(`Load failed: ${r.status}`);
    return r.json();
  });

  state.events = data.events ?? [];
  state.shapeUsage = normalizeShapeUsage(data.shapeUsage);
  state.raw = state.events.slice();
  renderSummary(state.events);
  const scrollSnapshot = options.scrollSnapshot
    ?? (options.stickToBottom ? captureScrollSnapshot({ forceStickToBottom: true }) : null);
  renderTimeline.pendingOptions = { openLatestTurn: scrollSnapshot?.stickToBottom ?? false };
  renderTimeline(state.events);
  restoreScrollAfterRender(scrollSnapshot);
}

function isAutoRefreshEnabled() {
  return autoRefreshToggle?.checked ?? false;
}

function captureScrollSnapshot(options = {}) {
  const metrics = getScrollMetrics();
  const stickToBottom =
    options.forceStickToBottom ||
    state.stickToBottomAfterLayout ||
    metrics.distanceFromBottom <= BOTTOM_STICKY_PX;
  const preferScrollTop = options.preferScrollTop === true || state.preferScrollTopAfterLayout;
  return {
    scrollTop: metrics.scrollTop,
    stickToBottom,
    preferScrollTop,
    anchors: stickToBottom || preferScrollTop ? [] : captureScrollAnchors(),
    userScrollVersion: state.userScrollVersion,
  };
}

function restoreScrollAfterRender(snapshot) {
  if (!snapshot) {
    return;
  }
  afterNextPaint(() => {
    if (applyScrollRestoration(snapshot)) {
      window.setTimeout(() => applyScrollRestoration(snapshot), 50);
      window.setTimeout(() => applyScrollRestoration(snapshot), 150);
    }
  });
}

function applyScrollRestoration(snapshot) {
  const restoreSnapshot = resolveScrollSnapshot(snapshot);
  if (!restoreSnapshot) {
    return false;
  }
  if (restoreSnapshot.stickToBottom) {
    scrollToBottomNow();
    return true;
  }
  if (!restoreSnapshot.preferScrollTop && restoreScrollAnchor(restoreSnapshot)) {
    return true;
  }
  setScrollTop(restoreSnapshot.scrollTop);
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
        continue;
      }
      setScrollTop(targetTop);
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
  setScrollTop(maxTop);
}

function setScrollTop(value) {
  const root = scrollingRoot();
  const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
  const top = Math.min(Math.max(0, value), maxTop);
  if (typeof root.scrollTo === "function") {
    root.scrollTo({ top, behavior: "auto" });
  } else {
    root.scrollTop = top;
  }
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

function markUserScrollIntent() {
  state.userScrollVersion += 1;
  state.latestLayoutScrollSnapshot = null;
  state.stickToBottomAfterLayout = false;
  state.preferScrollTopAfterLayout = false;
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
}

function renderTimelinePreservingScroll() {
  const scrollSnapshot = captureScrollSnapshot();
  renderTimeline(state.events);
  restoreScrollAfterRender(scrollSnapshot);
}

async function refreshActiveRun() {
  if (!isAutoRefreshEnabled() || state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  try {
    const scrollSnapshot = captureScrollSnapshot();
    if (state.selectedRun) {
      await loadRuns({ preserveSelection: true, ignoreUrl: true, scrollSnapshot });
    } else {
      await loadRuns({ scrollSnapshot });
    }
  } catch (error) {
    console.error("auto-refresh failed", error);
  } finally {
    state.refreshInFlight = false;
  }
}

// --- Bind ---

refreshRuns.addEventListener("click", () => loadRuns({
  preserveSelection: true,
  scrollSnapshot: captureScrollSnapshot(),
}));
reloadRun.addEventListener("click", () => loadRun(state.selectedRun, {
  scrollSnapshot: captureScrollSnapshot(),
}));
runSelect.addEventListener("change", e => loadRun(e.target.value));
eventFilter.addEventListener("input", renderTimelinePreservingScroll);
hideNoiseToggle.addEventListener("change", renderTimelinePreservingScroll);
if (fullViewToggle) {
  fullViewToggle.addEventListener("change", renderTimelinePreservingScroll);
}
window.addEventListener("wheel", markUserScrollIntent, { passive: true });
window.addEventListener("touchmove", markUserScrollIntent, { passive: true });
window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
window.addEventListener("keydown", (event) => {
  if (SCROLL_KEYS.has(event.key)) {
    markUserScrollIntent();
  }
});
if (autoRefreshToggle) {
  autoRefreshToggle.addEventListener("change", () => {
    renderTimelinePreservingScroll();
    if (autoRefreshToggle.checked) {
      startAutoRefresh();
      refreshActiveRun();
    } else {
      stopAutoRefresh();
    }
  });
}

loadRuns().catch(err => {
  summaryEl.innerHTML = `<div><strong>error</strong>${err.message}</div>`;
}).finally(() => {
  startAutoRefresh();
});
