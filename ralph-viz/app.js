const runSelect = document.getElementById("runSelect");
const refreshRuns = document.getElementById("refreshRuns");
const reloadRun = document.getElementById("reloadRun");
const summaryEl = document.getElementById("summary");
const timelineEl = document.getElementById("timeline");
const eventFilter = document.getElementById("eventFilter");
const eventCountEl = document.getElementById("eventCount");
const hideNoiseToggle = document.getElementById("hideNoise");
const autoRefreshToggle = document.getElementById("autoRefresh");

const AUTO_REFRESH_MS = 2500;
const BOTTOM_STICKY_PX = 160;

const state = {
  runs: [],
  selectedRun: null,
  currentRun: null,
  events: [],
  raw: [],
  autoRefreshTimer: null,
  refreshInFlight: false,
  openEntryKeys: new Set(),
};

// Noise event types that clutter the view
const NOISE_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "error", "codex.session.token_count", "ralph.test-status",
  // Gemini streaming noise
  "content", "finished", "model_info", "tool_call_response",
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
    const turn = displayTurnForRecord(r);
    if (Number.isInteger(turn)) turnSet.add(turn);
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

function displayTurnForRecord(record) {
  if (Number.isInteger(record.turnNumber) && record.turnNumber > 0) {
    return record.turnNumber;
  }
  return "setup";
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
      more.onclick = () => { pre.textContent = output; more.remove(); };
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
  details.open = state.openEntryKeys.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) {
      state.openEntryKeys.add(key);
    } else {
      state.openEntryKeys.delete(key);
    }
  });
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

  const sender = record.event?.sender ?? "ralph";
  const card = document.createElement("div");
  card.className = "ev ev-prompt";

  const label = document.createElement("span");
  label.className = "prompt-label";
  label.textContent = sender;

  const body = document.createElement("div");
  body.className = "prompt-body";
  body.textContent = prompt;

  card.append(label, body);
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
      more.onclick = () => { pre.textContent = output; more.remove(); };
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

  if (record.eventType === "ralph.prompt")
    return renderPromptCard(record);
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

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function buildUsageMap(records) {
  const map = new Map();
  for (const r of records) {
    // Codex: turn.completed has usage
    if (r.eventType === "turn.completed" && r.event?.usage) {
      const turn = displayTurnForRecord(r);
      map.set(turn, r.event.usage);
    }
    // Gemini: finished events have usageMetadata — accumulate per turn
    if (r.eventType === "finished" && r.event?.value?.usageMetadata) {
      const turn = displayTurnForRecord(r);
      const gm = r.event.value.usageMetadata;
      const prev = map.get(turn);
      if (prev && prev._gemini) {
        // Accumulate across multiple finished events in same turn
        prev.input_tokens += gm.promptTokenCount ?? 0;
        prev.output_tokens += (gm.candidatesTokenCount ?? 0) + (gm.thoughtsTokenCount ?? 0);
        prev.cached_input_tokens += gm.cachedContentTokenCount ?? 0;
      } else if (!prev) {
        map.set(turn, {
          _gemini: true,
          input_tokens: gm.promptTokenCount ?? 0,
          output_tokens: (gm.candidatesTokenCount ?? 0) + (gm.thoughtsTokenCount ?? 0),
          cached_input_tokens: gm.cachedContentTokenCount ?? 0,
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
  if (!output || !/test-report/.test(command + output)) {
    return null;
  }

  const summary = parseTestReportSummary(output);
  if (!summary) {
    return null;
  }

  const stageSections = parseStageSections(output);
  const stageNames = stageSections.map(stage => stage.name);
  const firstFailureLine = output
    .split(/\r?\n/)
    .find(line => /ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match/.test(line)) ?? null;
  const failingStage = firstFailureLine?.match(/^(pa\d+)\//)?.[1] ?? null;
  const failingIndex = failingStage ? stageNames.indexOf(failingStage) : -1;
  const stageCount = stageNames.length;
  const stages = stageSections.map((stage, index) => {
    const failed = countStageFailureLines(stage.body);
    return {
      name: stage.name,
      status: summary.allTestsPassed ? "pass" : failed > 0 ? "fail" : index < failingIndex ? "pass" : "unknown",
      passed: 0,
      total: 0,
      failed,
      targets: [],
    };
  });
  const stagesPassed = stages.filter(stage => stage.status === "pass").length;

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
    firstFailureLine,
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
  return body
    .split(/\r?\n/)
    .filter(line =>
      /^(?:pa\d+\/|pa\d+\/\.\.\/).+?: (?:ERROR:|TEST FAIL|FAIL after|Expected EXIT_|got EXIT_|does not match)/.test(line),
    ).length;
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

function testStatusText(ts) {
  if (!ts) return "";
  const parts = [`${ts.testsPassed}/${ts.testsTotal} tests`];
  if (ts.stageCount > 0) parts.push(`${ts.stagesPassed}/${ts.stageCount} stages`);
  if (ts.failingStage) parts.push(ts.failingStage);
  else if (ts.allTestsPassed) parts.push("all pass");
  return parts.join(", ");
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
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const total = input + output;
  const parts = [`${fmtTokens(total)} tok`, `${fmtTokens(input)} in`];
  if (cached) parts.push(`${fmtTokens(cached)} cached`);
  parts.push(`${fmtTokens(output)} out`);
  return parts.join(" / ");
}

function renderTimeline(records) {
  const options = renderTimeline.pendingOptions ?? {};
  renderTimeline.pendingOptions = {};
  rememberOpenEntryKeys();
  timelineEl.innerHTML = "";
  const usageMap = buildUsageMap(records);
  const testMap = buildTestStatusMap(records);
  const filtered = filterRecords(records);
  eventCountEl.textContent = `${filtered.length} / ${records.length}`;

  const turnMap = buildTurnMap(filtered);
  for (const turn of testMap.keys()) {
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

  for (const turn of sortedTurns) {
    const items = turnMap.get(turn) ?? [];
    const details = document.createElement("details");
    details.className = "turn";
    details.dataset.turn = String(turn);

    // Open turns from URL, or default to last turn
    if (hasUrlTurns ? urlTurns.includes(String(turn)) : turn === lastTurn) {
      details.open = true;
    }

    details.addEventListener("toggle", syncOpenTurnsToUrl);

    const summary = document.createElement("summary");
    summary.className = "turn-header";
    const label = turn === "setup" ? "Setup" : `Turn ${turn}`;
    const usage = usageMap.get(turn);
    const ts = testMap.get(turn);
    const infoText = items.length ? turnSummaryText(items) : "pre-turn check";
    const usageHtml = usage ? ` <span class="turn-usage">${usageText(usage)}</span>` : "";
    const tsHtml = ts ? ` <span class="turn-tests${ts.allTestsPassed ? " turn-tests-pass" : ""}">${testStatusText(ts)}</span>` : "";
    summary.innerHTML = `<strong>${label}</strong> <span class="turn-info">${infoText}</span>${tsHtml}${usageHtml}`;
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
    return;
  }

  for (const run of state.runs) {
    const opt = document.createElement("option");
    opt.value = run.id;
    opt.textContent = `${run.label} (${run.events} events)`;
    runSelect.append(opt);
  }

  const urlRun = options.ignoreUrl ? null : getUrlParams().run;
  const selectedRun = options.preserveSelection ? state.selectedRun : null;
  const preferred = options.preferredRun && state.runs.some(r => r.id === options.preferredRun) ? options.preferredRun
    : selectedRun && state.runs.some(r => r.id === selectedRun) ? selectedRun
    : urlRun && state.runs.some(r => r.id === urlRun) ? urlRun
    : state.currentRun && state.runs.some(r => r.id === state.currentRun) ? state.currentRun
    : state.runs[0].id;
  runSelect.value = preferred;
  await loadRun(preferred, { stickToBottom: options.stickToBottom });
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
  state.raw = state.events.slice();
  renderSummary(state.events);
  renderTimeline.pendingOptions = { openLatestTurn: options.stickToBottom };
  renderTimeline(state.events);
  if (options.stickToBottom) {
    scrollToBottom();
  }
}

function isAutoRefreshEnabled() {
  return autoRefreshToggle?.checked ?? false;
}

function isNearBottom() {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - BOTTOM_STICKY_PX;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  });
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

async function refreshActiveRun() {
  if (!isAutoRefreshEnabled() || state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  try {
    const stickToBottom = isNearBottom();
    const stateData = await fetch("/api/state").then(r => r.json());
    const currentRun = stateData.currentThread ?? null;
    state.currentRun = currentRun;
    if (currentRun && currentRun !== state.selectedRun) {
      await loadRuns({ preferredRun: currentRun, ignoreUrl: true, stickToBottom });
    } else if (state.selectedRun) {
      await loadRun(state.selectedRun, { stickToBottom });
    } else {
      await loadRuns({ stickToBottom });
    }
  } catch (error) {
    console.error("auto-refresh failed", error);
  } finally {
    state.refreshInFlight = false;
  }
}

// --- Bind ---

refreshRuns.addEventListener("click", () => loadRuns({ preserveSelection: true }));
reloadRun.addEventListener("click", () => loadRun(state.selectedRun));
runSelect.addEventListener("change", e => loadRun(e.target.value));
eventFilter.addEventListener("input", () => renderTimeline(state.events));
hideNoiseToggle.addEventListener("change", () => renderTimeline(state.events));
if (autoRefreshToggle) {
  autoRefreshToggle.addEventListener("change", () => {
    renderTimeline(state.events);
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
