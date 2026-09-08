(function installTurnLifecycle(root) {
  function isCodexReconnectNotice(event) {
    if (event?.type !== "error") return false;
    const match = String(event.message ?? "").match(/^Reconnecting(?:\.{3}|…)\s+(\d+)\/(\d+)\b/i);
    return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= Number(match[2]));
  }

  function isCodexTransientProviderMessage(message) {
    return typeof message === "string" && (
      /\b(?:selected )?model\b.*\bat capacity\b/i.test(message) ||
      /\btemporarily unavailable\b|\boverloaded\b/i.test(message) ||
      /\brequest (?:timed out|timeout)\b|\berror sending request\b/i.test(message) ||
      /\bstream (?:disconnected|interrupted)\b|\bconnection (?:reset|closed|refused)\b/i.test(message) ||
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/.test(message)
    );
  }

  function isFailureEvent(record) {
    return record?.eventType === "ralph.turn-failed" || record?.eventType === "turn.failed" ||
      (record?.eventType === "error" && !isCodexReconnectNotice(record.event));
  }

  // Only the latest attempt controls the live clock. A retry can reuse both
  // the Ralph turn number and the provider thread after an earlier failure.
  function failedAttemptEndMs(records, turn) {
    let start = -Infinity;
    let end = null;
    for (const record of records ?? []) {
      if (record.turnNumber !== turn) continue;
      const time = Date.parse(record.recordedAt ?? "");
      if (!Number.isFinite(time)) continue;
      const boundary = record.eventType === "ralph.turn-restart" ||
        (record.eventType === "ralph.phase-status" && record.event?.action === "turn-start");
      if (boundary && time >= start) {
        start = time;
        if (end != null && end < start) end = null;
      }
      if (isFailureEvent(record) && time >= start) end = Math.max(end ?? -Infinity, time);
    }
    return end;
  }

  root.RALPH_TURN_LIFECYCLE = Object.freeze({
    isCodexReconnectNotice, isCodexTransientProviderMessage, isFailureEvent, failedAttemptEndMs,
  });
})(globalThis);
