const DEFAULT_RESULT_LIMIT = 12_000;

export function subagentRunRecord(recordedAt, threadId, turnNumber, eventType, item) {
  return {
    recordedAt,
    threadId,
    turnNumber,
    eventType,
    event: { type: eventType, item },
  };
}

export function existingSubagentEventKeys(events) {
  const keys = new Set();
  for (const record of events ?? []) {
    const item = record?.event?.item;
    if (item?.type !== "subagent" || !item.id) {
      continue;
    }
    const threadId = subagentEventThreadId(record) ?? "";
    if (record.eventType === "item.started") {
      keys.add(`start:${threadId}:${item.id}`);
    } else if (record.eventType === "item.completed") {
      keys.add(`complete:${threadId}:${item.notification_id ?? `${item.id}:${record.recordedAt ?? ""}`}`);
      if (item.provider === "codex") {
        keys.add(`complete:${threadId}:codex:${item.id}`);
      }
    }
  }
  return keys;
}

export function buildSubagentTurnResolver(events) {
  const starts = (events ?? [])
    .filter((record) =>
      record?.eventType === "ralph.prompt" ||
      (record?.eventType === "ralph.phase-status" && record.event?.action === "turn-start"))
    .map((record) => ({
      threadId: subagentEventThreadId(record),
      turnNumber: record.turnNumber,
      time: Date.parse(record.recordedAt ?? ""),
    }))
    .filter((entry) => Number.isInteger(entry.turnNumber) && entry.turnNumber > 0 && Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time);
  return (timestamp, threadId) => {
    const time = Date.parse(timestamp ?? "");
    if (!Number.isFinite(time)) {
      return null;
    }
    let selected = null;
    for (const start of starts) {
      if (start.time > time) {
        break;
      }
      if (!threadId || !start.threadId || start.threadId === threadId) {
        selected = start;
      }
    }
    return selected?.turnNumber ?? null;
  };
}

export function subagentEventThreadId(record) {
  return record?.threadId ?? record?.event?.thread_id ?? record?.event?.threadId ?? null;
}

export function compactSubagentText(value, limit = DEFAULT_RESULT_LIMIT) {
  const text = subagentTextValue(value);
  const max = Number.isFinite(limit) ? Math.max(1_000, limit) : DEFAULT_RESULT_LIMIT;
  if (text.length <= max) {
    return text;
  }
  const edge = Math.floor((max - 80) / 2);
  return `${text.slice(0, edge)}\n\n... subagent output omitted ...\n\n${text.slice(-edge)}`;
}

export function subagentTextValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}
