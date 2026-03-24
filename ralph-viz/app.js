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

function eventSummary(event) {
  if (!event || !event.event) {
    return "unknown";
  }
  if (event.eventType === "item.completed") {
    const item = event.event.item ?? {};
    if (item.type === "command_execution") {
      return `${item.type} (${item.status})`;
    }
    if (item.type === "agent_message") {
      return `${item.type}`;
    }
    return item.type ?? "item";
  }
  if (event.eventType === "turn.completed") {
    return "turn.completed";
  }
  if (event.eventType === "turn.failed") {
    return "turn.failed";
  }
  return event.eventType;
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

function eventHeadline(record) {
  const item = record.event?.item;
  if (record.eventType === "item.started" && item?.type) {
    return `${record.eventType} · ${item.type}`;
  }
  if (record.eventType === "item.completed" && item?.type === "agent_message") {
    return `${record.eventType} · ${item.type}: ${snippetFromText(item.text)}`;
  }
  if (record.eventType === "item.completed" && item?.type === "command_execution") {
    const status = item.exit_code == null ? item.status : `${item.status} (exit=${item.exit_code})`;
    return `${record.eventType} · command ${status}`;
  }
  if (record.eventType === "item.completed" && item?.type === "file_change") {
    const changeText = (item.changes ?? [])
      .map((change) => `${change.kind}: ${change.path}`)
      .slice(0, 2)
      .join(", ");
    return `${record.eventType} · file_change (${changeText || "no changes"})`;
  }
  if (record.eventType === "turn.completed" && record.event?.usage) {
    const usage = record.event.usage;
    return `${record.eventType} · tokens=${usage.input_tokens + usage.output_tokens}`;
  }
  return eventSummary(record);
}

function eventMeta(record) {
  const type = record.eventType ?? "unknown";
  const item = record.event?.item;
  if (type === "item.completed" && item?.type === "command_execution" && item.command) {
    return snippetFromText(item.command);
  }
  if (type === "item.completed" && item?.type === "agent_message") {
    return "agent response";
  }
  if (type === "item.completed" && item?.type === "file_change") {
    return `${(item.changes ?? []).length} file change(s)`;
  }
  return type;
}

function createPayloadPreview(event) {
  const item = event.event?.item;
  const compact = {};
  if (item) {
    for (const key of ["type", "status", "command", "exit_code", "aggregated_output", "text"]) {
      if (item[key] !== undefined) compact[key] = item[key];
    }
  } else if (event.event) {
    if (event.event.usage) compact.usage = event.event.usage;
  }
  return compact;
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
    list.style.paddingLeft = "0.65rem";
    const turnHeader = document.createElement("div");
    turnHeader.className = "muted";
    const typeCounts = eventTypeSummary(items)
      .map(([type, count]) => `${type}:${count}`)
      .join(" · ");
    turnHeader.textContent = `events: ${items.length}${typeCounts ? ` · ${typeCounts}` : ""}`;
    list.appendChild(turnHeader);

    for (const [index, record] of items.entries()) {
      const header = eventHeadline(record);
      const eventNode = document.createElement("details");
      eventNode.className = "event-row";
      const eventSummaryNode = document.createElement("summary");
      const short = `#${index + 1}`;
      eventSummaryNode.textContent = `${header} ${short}`;

      const meta = document.createElement("span");
      meta.className = "event-meta";
      const when = fmt(record.recordedAt);
      const extra = eventMeta(record);
      meta.textContent = `@${when} · ${extra}`;
      eventSummaryNode.appendChild(meta);

      const content = document.createElement("pre");
      const compactPayload = createPayloadPreview(record);
      const payloadText =
        Object.keys(compactPayload).length > 0
          ? JSON.stringify(compactPayload, null, 2)
          : JSON.stringify(record.event, null, 2);
      content.textContent = payloadText;
      content.className = "event-payload";

      const full = document.createElement("details");
      full.className = "nested";
      const fullSummary = document.createElement("summary");
      fullSummary.textContent = "full payload";
      const fullPre = document.createElement("pre");
      fullPre.textContent = JSON.stringify(record, null, 2);
      full.append(fullSummary, fullPre);

      eventNode.append(eventSummaryNode, content);
      eventNode.append(full);
      list.appendChild(eventNode);
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
