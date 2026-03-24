const runSelect = document.getElementById("runSelect");
const refreshRuns = document.getElementById("refreshRuns");
const reloadRun = document.getElementById("reloadRun");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const eventFilter = document.getElementById("eventFilter");
const eventCountEl = document.getElementById("eventCount");

const state = { runs: [], selectedRun: null, events: [], raw: [] };

function fmt(time) {
  return time
    ? new Date(time).toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "n/a";
}

function buildTypeStats(events) {
  const stats = new Map();
  for (const record of events) {
    const type = record.eventType ?? "unknown";
    stats.set(type, (stats.get(type) ?? 0) + 1);
  }
  return [...stats.entries()].sort((a, b) => b[1] - a[1]);
}

function eventTypeSummary(events) {
  const map = new Map();
  for (const event of events) {
    const type = event.eventType ?? "unknown";
    map.set(type, (map.get(type) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function buildSummary(events) {
  const turnSet = new Set();
  for (const record of events) {
    if (Number.isInteger(record.turnNumber)) {
      turnSet.add(record.turnNumber);
    }
  }
  const first = events.at(0)?.recordedAt ?? null;
  const last = events.at(-1)?.recordedAt ?? null;
  return {
    threadId: events.at(0)?.threadId ?? "n/a",
    events: events.length,
    turns: turnSet.size,
    maxTurn: events.length ? Math.max(...Array.from(turnSet)) : "n/a",
    first,
    last,
    typeStats: buildTypeStats(events),
  };
}

function snippetFromText(text) {
  const clean = (text ?? "").toString().replace(/\s+/g, " ").trim();
  if (!clean) {
    return "no text";
  }
  if (clean.length <= 96) {
    return clean;
  }
  return `${clean.slice(0, 96)}...`;
}

function firstLineSnippet(text) {
  const clean = cleanText(text);
  if (!clean) {
    return "";
  }
  const [line] = clean.split(/\r?\n/, 1);
  return snippetFromText(line);
}

function cleanText(text) {
  return (text ?? "").toString().trim();
}

function unwrapCommand(command) {
  const text = cleanText(command);
  const prefix = "/bin/bash -lc ";
  if (!text.startsWith(prefix)) {
    return text;
  }
  const wrapped = text.slice(prefix.length).trim();
  if (wrapped.length >= 2) {
    const first = wrapped[0];
    const last = wrapped[wrapped.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return wrapped.slice(1, -1);
    }
  }
  return wrapped;
}

function createBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = `pill${className ? ` ${className}` : ""}`;
  badge.textContent = text;
  return badge;
}

function createMeta(record, label) {
  const meta = document.createElement("div");
  meta.className = "event-meta-line";
  meta.textContent = `${fmt(record.recordedAt)} · ${label}`;
  return meta;
}

function appendRawPayload(container, record) {
  const full = document.createElement("details");
  full.className = "nested";
  const fullSummary = document.createElement("summary");
  fullSummary.textContent = "raw event";
  const fullPre = document.createElement("pre");
  fullPre.textContent = JSON.stringify(record, null, 2);
  full.append(fullSummary, fullPre);
  container.append(full);
}

function appendOutput(container, label, text) {
  const clean = cleanText(text);
  if (!clean) {
    return;
  }
  const details = document.createElement("details");
  details.className = "nested";
  const summary = document.createElement("summary");
  const preview = firstLineSnippet(clean);
  summary.textContent = preview || label;
  const pre = document.createElement("pre");
  pre.textContent = clean;
  details.append(summary, pre);
  container.append(details);
}

function renderMessageCard(record, item, index) {
  const details = document.createElement("details");
  details.className = "event-card event-card-message event-card-message-compact";

  const summary = document.createElement("summary");
  summary.className = "message-summary";

  const preview = document.createElement("span");
  preview.className = "message-preview";
  preview.textContent = cleanText(item.text) || "No message text";

  const body = document.createElement("div");
  body.className = "event-text message-body";
  body.textContent = cleanText(item.text) || "No message text";

  summary.append(preview);
  details.append(summary, body);
  return details;
}

function renderCommandCard(entry, index) {
  const startRecord = entry.startRecord;
  const endRecord = entry.endRecord;
  const startItem = startRecord?.event?.item ?? null;
  const endItem = endRecord?.event?.item ?? null;
  const item = endItem ?? startItem ?? {};
  const card = document.createElement("details");
  card.className = "event-card event-card-command";

  const header = document.createElement("summary");
  header.className = "event-card-header";
  const title = document.createElement("pre");
  title.className = "command-block command-block-inline";
  title.textContent = unwrapCommand(item.command) || "No command captured";
  header.append(title);
  if (item.exit_code != null) {
    header.append(createBadge(`exit ${item.exit_code}`, item.exit_code === 0 ? "pill-ok" : "pill-bad"));
  } else if (!endRecord) {
    header.append(createBadge("in progress"));
  }

  card.append(header);
  appendOutput(card, "output", item.aggregated_output);
  return card;
}

function renderFileChangeCard(record, item, index) {
  const card = document.createElement("article");
  card.className = "event-card event-card-file";

  const header = document.createElement("div");
  header.className = "event-card-header";
  const title = document.createElement("strong");
  title.textContent = `File changes #${index + 1}`;
  header.append(title, createBadge(`${(item.changes ?? []).length} changes`));

  const list = document.createElement("div");
  list.className = "change-list";
  for (const change of item.changes ?? []) {
    const row = document.createElement("div");
    row.className = "change-row";
    row.textContent = `${change.kind}: ${change.path}`;
    list.append(row);
  }

  card.append(header, createMeta(record, "file_change"), list);
  appendRawPayload(card, record);
  return card;
}

function renderTodoCard(record, item, index) {
  const card = document.createElement("article");
  card.className = "event-card event-card-todo";

  const header = document.createElement("div");
  header.className = "event-card-header";
  const title = document.createElement("strong");
  title.textContent = `Todo list #${index + 1}`;
  header.append(title, createBadge(`${(item.items ?? []).length} items`));

  const list = document.createElement("div");
  list.className = "todo-list";
  for (const todo of item.items ?? []) {
    const row = document.createElement("div");
    row.className = `todo-row${todo.completed ? " todo-done" : ""}`;
    row.textContent = `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`;
    list.append(row);
  }

  card.append(header, createMeta(record, "todo_list"), list);
  appendRawPayload(card, record);
  return card;
}

function renderGenericItemCard(record, item, index) {
  const card = document.createElement("article");
  card.className = "event-card event-card-generic";

  const header = document.createElement("div");
  header.className = "event-card-header";
  const title = document.createElement("strong");
  title.textContent = `${record.eventType} #${index + 1}`;
  header.append(title, createBadge(item.type ?? "item"));

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(item, null, 2);

  card.append(header, createMeta(record, item.type ?? "item"), pre);
  appendRawPayload(card, record);
  return card;
}

function renderSystemCard(record, index) {
  const card = document.createElement("article");
  card.className = "event-card event-card-system";

  const header = document.createElement("div");
  header.className = "event-card-header";
  const title = document.createElement("strong");
  title.textContent = `${record.eventType} #${index + 1}`;
  header.append(title);

  const content = document.createElement("div");
  content.className = "event-text event-text-muted";

  if (record.eventType === "thread.started") {
    content.textContent = `Thread ${record.event?.thread_id ?? record.threadId ?? "unknown"} started`;
  } else if (record.eventType === "turn.started") {
    content.textContent = "Turn started";
  } else if (record.eventType === "turn.completed" && record.event?.usage) {
    const usage = record.event.usage;
    const total = usage.input_tokens + usage.output_tokens;
    content.textContent = `Turn completed with ${total} tokens (${usage.input_tokens} in, ${usage.output_tokens} out)`;
  } else if (record.eventType === "turn.failed") {
    content.textContent = cleanText(record.event?.error?.message) || "Turn failed";
  } else if (record.eventType === "error") {
    content.textContent = cleanText(record.event?.message) || "Error";
  } else {
    content.textContent = snippetFromText(JSON.stringify(record.event ?? {}));
  }

  card.append(header, createMeta(record, record.eventType), content);
  appendRawPayload(card, record);
  return card;
}

function buildDisplayEntries(records) {
  const entries = [];
  const commandStarts = new Map();

  for (const record of records) {
    const item = record.event?.item;
    const isCommand = item?.type === "command_execution";

    if (record.eventType === "item.started" && isCommand) {
      const entry = {
        kind: "command",
        startRecord: record,
        endRecord: null,
      };
      entries.push(entry);
      if (item.id) {
        commandStarts.set(item.id, entry);
      }
      continue;
    }

    if (record.eventType === "item.completed" && isCommand && item.id && commandStarts.has(item.id)) {
      commandStarts.get(item.id).endRecord = record;
      commandStarts.delete(item.id);
      continue;
    }

    entries.push({
      kind: "event",
      record,
    });
  }

  return entries;
}

function renderEventCard(record, index) {
  const item = record.event?.item;
  if (record.eventType === "item.completed" && item?.type === "agent_message") {
    return renderMessageCard(record, item, index);
  }
  if (record.eventType === "item.completed" && item?.type === "file_change") {
    return renderFileChangeCard(record, item, index);
  }
  if (record.eventType === "item.started" && item?.type === "todo_list") {
    return renderTodoCard(record, item, index);
  }
  if (item) {
    return renderGenericItemCard(record, item, index);
  }
  return renderSystemCard(record, index);
}

function renderDisplayEntry(entry, index) {
  if (entry.kind === "command") {
    return renderCommandCard(entry, index);
  }
  return renderEventCard(entry.record, index);
}

function renderSummary(events) {
  const summary = buildSummary(events);
  const chips = summary.typeStats
    .slice(0, 6)
    .map(([type, count]) => `<span class="pill">${type}: ${count}</span>`)
    .join(" ");

  summaryEl.innerHTML = `
    <div><strong>thread</strong>${summary.threadId}</div>
    <div><strong>events</strong>${summary.events}</div>
    <div><strong>turns</strong>${summary.turns}</div>
    <div><strong>max turn</strong>${summary.maxTurn}</div>
    <div><strong>first</strong>${fmt(summary.first)}</div>
    <div><strong>last</strong>${fmt(summary.last)}</div>
    <div style="grid-column: 1 / -1;"><strong>event mix</strong>${chips || "<span class='muted'>No events yet</span>"}</div>
  `;
}

function filterRecords(records) {
  const search = eventFilter.value.trim().toLowerCase();
  if (!search) {
    return records;
  }
  return records.filter((record) => (record.eventType ?? "").toLowerCase().includes(search));
}

function buildTurnMap(events) {
  const turns = new Map();
  for (const record of events) {
    const turn = Number.isInteger(record.turnNumber) ? record.turnNumber : "unassigned";
    const list = turns.get(turn) ?? [];
    list.push(record);
    turns.set(turn, list);
  }
  return turns;
}

function renderTimeline(records) {
  timelineEl.innerHTML = "";
  const filtered = filterRecords(records);
  eventCountEl.textContent = `${filtered.length} / ${records.length} events shown`;

  const turnMap = buildTurnMap(filtered);
  const sortedTurns = [...turnMap.keys()].sort((a, b) => {
    if (a === "unassigned") {
      return Number.POSITIVE_INFINITY;
    }
    if (b === "unassigned") {
      return Number.NEGATIVE_INFINITY;
    }
    return a - b;
  });

  for (const turn of sortedTurns) {
    const items = turnMap.get(turn) ?? [];
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.className = "level";

    const title = document.createElement("strong");
    title.textContent = `Turn ${turn}`;

    const badge = document.createElement("span");
    badge.className = "pill";
    badge.textContent = `${items.length} events`;

    summary.append(title);
    summary.append(badge);
    details.append(summary);

    const list = document.createElement("div");
    list.className = "turn-feed";
    const turnHeader = document.createElement("div");
    turnHeader.className = "muted turn-feed-meta";
    const typeCounts = eventTypeSummary(items)
      .map(([type, count]) => `${type}:${count}`)
      .join(" · ");
    turnHeader.textContent = `events: ${items.length}${typeCounts ? ` · ${typeCounts}` : ""}`;
    list.appendChild(turnHeader);

    const displayEntries = buildDisplayEntries(items);
    for (const [index, entry] of displayEntries.entries()) {
      list.appendChild(renderDisplayEntry(entry, index));
    }
    details.appendChild(list);
    timelineEl.appendChild(details);
  }
}

async function loadRuns() {
  const stateData = await fetch("/api/state").then((r) => r.json());
  const data = await fetch("/api/runs").then((r) => r.json());
  state.runs = data.runs ?? [];

  runSelect.innerHTML = "";
  if (state.runs.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No run files found";
    runSelect.appendChild(option);
    summaryEl.innerHTML = `<div><strong>status</strong>Place a run file in <code>.ralph/events</code>.</div>`;
    timelineEl.innerHTML = "";
    eventCountEl.textContent = "";
    return;
  }

  for (const run of state.runs) {
    const option = document.createElement("option");
    option.value = run.id;
    option.textContent = `${run.id} (${run.events} events)`;
    runSelect.appendChild(option);
  }

  const preferred = stateData.currentThread;
  const defaultRun = preferred && state.runs.some((run) => run.id === preferred)
    ? preferred
    : state.runs[0].id;

  runSelect.value = defaultRun;
  await loadRun(defaultRun);
}

async function loadRun(id) {
  if (!id) {
    return;
  }
  state.selectedRun = id;
  const data = await fetch(`/api/run/${encodeURIComponent(id)}`).then((r) => {
    if (!r.ok) {
      throw new Error(`Could not load run: ${r.status}`);
    }
    return r.json();
  });

  state.events = data.events ?? [];
  state.raw = state.events.slice();
  renderSummary(state.events);
  renderTimeline(state.events);
}

function bind() {
  refreshRuns.addEventListener("click", loadRuns);
  reloadRun.addEventListener("click", () => loadRun(state.selectedRun));
  runSelect.addEventListener("change", (event) => {
    loadRun(event.target.value);
  });
  eventFilter.addEventListener("input", () => renderTimeline(state.events));
}

bind();
loadRuns().catch((error) => {
  summaryEl.innerHTML = `<div><strong>error</strong>${error.message}</div>`;
});
