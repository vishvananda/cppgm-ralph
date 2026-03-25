const runSelect = document.getElementById("runSelect");
const refreshRuns = document.getElementById("refreshRuns");
const reloadRun = document.getElementById("reloadRun");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const eventFilter = document.getElementById("eventFilter");
const eventCountEl = document.getElementById("eventCount");
const hideNoiseToggle = document.getElementById("hideNoise");
const autoRefreshToggle = document.getElementById("autoRefresh");

const state = { runs: [], selectedRun: null, events: [], raw: [] };

// Noise event types that clutter the view
const NOISE_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "error",
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

function buildSummary(events) {
  const turnSet = new Set();
  for (const r of events) {
    if (Number.isInteger(r.turnNumber)) turnSet.add(r.turnNumber);
  }
  const first = events.at(0)?.recordedAt ?? null;
  const last = events.at(-1)?.recordedAt ?? null;

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
    typeStats: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function renderSummary(events) {
  const s = buildSummary(events);
  const chips = s.typeStats.slice(0, 8)
    .map(([type, count]) => `<span class="pill">${type}: ${count}</span>`)
    .join(" ");

  summaryEl.innerHTML = `
    <div><strong>thread</strong>${truncate(s.threadId, 24)}</div>
    <div><strong>events</strong>${s.events}</div>
    <div><strong>turns</strong>${s.turns}</div>
    <div><strong>started</strong>${fmt(s.first)}</div>
    <div><strong>latest</strong>${fmt(s.last)}</div>
    <div style="grid-column:1/-1"><strong>types</strong>${chips || '<span class="muted">none</span>'}</div>
  `;
}

// --- Display entry building (merge command start/end) ---

function buildDisplayEntries(records) {
  const entries = [];
  const cmdStarts = new Map();

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
    entries.push({ kind: "event", record });
  }
  return entries;
}

// --- Card renderers ---

function renderCommandCard(entry) {
  const startItem = entry.startRecord?.event?.item ?? {};
  const endItem = entry.endRecord?.event?.item ?? {};
  const item = entry.endRecord ? endItem : startItem;
  const cmd = unwrapCommand(item.command) || "unknown command";
  const output = cleanText(item.aggregated_output);
  const exitCode = item.exit_code;
  const time = fmtShort(entry.endRecord?.recordedAt ?? entry.startRecord?.recordedAt);

  const card = document.createElement("details");
  card.className = "ev ev-cmd" + (exitCode != null && exitCode !== 0 ? " ev-cmd-fail" : "");

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
      more.onclick = () => { pre.textContent = output; more.remove(); };
      card.append(pre, more);
    } else {
      pre.textContent = output;
      card.append(pre);
    }
  }

  return card;
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
  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="pill">${changes.length} file${changes.length !== 1 ? "s" : ""}</span>`;
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
    row.innerHTML = `<span class="file-kind">${c.kind}</span> <span class="file-path">${c.path}</span>`;
    list.append(row);
  }

  card.append(summary, list);
  return card;
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

function renderDisplayEntry(entry) {
  if (entry.kind === "command") return renderCommandCard(entry);

  const record = entry.record;
  const item = record.event?.item;

  if (record.eventType === "item.completed" && item?.type === "agent_message")
    return renderMessageCard(record);
  if (record.eventType === "item.completed" && item?.type === "file_change")
    return renderFileChangeCard(record);
  if (record.eventType === "item.started" && item?.type === "todo_list")
    return renderTodoCard(record);

  // System / noise
  return renderSystemCard(record);
}

// --- Filtering ---

function shouldShow(record) {
  const hideNoise = hideNoiseToggle?.checked ?? true;
  if (hideNoise && NOISE_TYPES.has(record.eventType)) {
    // Keep item.started only for commands (they get merged)
    if (record.eventType === "item.started" && record.event?.item?.type === "command_execution")
      return true;
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
    const turn = Number.isInteger(record.turnNumber) ? record.turnNumber : "pre";
    const list = turns.get(turn) ?? [];
    list.push(record);
    turns.set(turn, list);
  }
  return turns;
}

function turnSummaryText(items) {
  let cmds = 0, msgs = 0, files = 0, other = 0;
  for (const r of items) {
    const t = r.event?.item?.type;
    if (t === "command_execution") cmds++;
    else if (t === "agent_message") msgs++;
    else if (t === "file_change") files++;
    else other++;
  }
  const parts = [];
  if (cmds) parts.push(`${cmds} cmd`);
  if (msgs) parts.push(`${msgs} msg`);
  if (files) parts.push(`${files} file`);
  return parts.join(", ") || `${items.length} events`;
}

function renderTimeline(records) {
  timelineEl.innerHTML = "";
  const filtered = filterRecords(records);
  eventCountEl.textContent = `${filtered.length} / ${records.length}`;

  const turnMap = buildTurnMap(filtered);
  const sortedTurns = [...turnMap.keys()].sort((a, b) => {
    if (a === "pre") return -1;
    if (b === "pre") return 1;
    return a - b;
  });

  const lastTurn = sortedTurns[sortedTurns.length - 1];

  for (const turn of sortedTurns) {
    const items = turnMap.get(turn) ?? [];
    const details = document.createElement("details");
    details.className = "turn";
    // Auto-open last turn
    if (turn === lastTurn) details.open = true;

    const summary = document.createElement("summary");
    summary.className = "turn-header";
    const label = turn === "pre" ? "Setup" : `Turn ${turn}`;
    summary.innerHTML = `<strong>${label}</strong> <span class="turn-info">${turnSummaryText(items)}</span>`;
    details.append(summary);

    const feed = document.createElement("div");
    feed.className = "turn-feed";
    const displayEntries = buildDisplayEntries(items);
    for (const entry of displayEntries) {
      const el = renderDisplayEntry(entry);
      if (el) feed.append(el);
    }
    details.append(feed);
    timelineEl.append(details);
  }
}

// --- Data loading ---

async function loadRuns() {
  const [stateData, data] = await Promise.all([
    fetch("/api/state").then(r => r.json()),
    fetch("/api/runs").then(r => r.json()),
  ]);
  state.runs = data.runs ?? [];

  runSelect.innerHTML = "";
  if (!state.runs.length) {
    const opt = document.createElement("option");
    opt.textContent = "No runs found";
    runSelect.append(opt);
    summaryEl.innerHTML = "";
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    return;
  }

  for (const run of state.runs) {
    const opt = document.createElement("option");
    opt.value = run.id;
    opt.textContent = `${run.id.slice(0, 8)}... (${run.events} events)`;
    runSelect.append(opt);
  }

  const preferred = stateData.currentThread;
  const defaultRun = preferred && state.runs.some(r => r.id === preferred) ? preferred : state.runs[0].id;
  runSelect.value = defaultRun;
  await loadRun(defaultRun);
}

async function loadRun(id) {
  if (!id) return;
  state.selectedRun = id;
  const data = await fetch(`/api/run/${encodeURIComponent(id)}`).then(r => {
    if (!r.ok) throw new Error(`Load failed: ${r.status}`);
    return r.json();
  });

  state.events = data.events ?? [];
  state.raw = state.events.slice();
  renderSummary(state.events);
  renderTimeline(state.events);
}

// --- Bind ---

refreshRuns.addEventListener("click", loadRuns);
reloadRun.addEventListener("click", () => loadRun(state.selectedRun));
runSelect.addEventListener("change", e => loadRun(e.target.value));
eventFilter.addEventListener("input", () => renderTimeline(state.events));
hideNoiseToggle.addEventListener("change", () => renderTimeline(state.events));
if (autoRefreshToggle) {
  autoRefreshToggle.addEventListener("change", () => renderTimeline(state.events));
}

loadRuns().catch(err => {
  summaryEl.innerHTML = `<div><strong>error</strong>${err.message}</div>`;
});
