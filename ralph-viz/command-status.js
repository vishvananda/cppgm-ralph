(function installRalphCommandStatus(root) {
  const TIMEOUT_UNIT_MS = Object.freeze({
    "": 1000,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  });

  function declaredShellTimeoutMs(command) {
    let total = 0;
    let found = false;
    const pattern = /(?:^|[\s;|&()])timeout\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s)/g;
    for (const match of String(command ?? "").matchAll(pattern)) {
      const value = Number.parseFloat(match[1]);
      const multiplier = TIMEOUT_UNIT_MS[match[2]];
      if (Number.isFinite(value) && value >= 0 && multiplier) {
        total += value * multiplier;
        found = true;
      }
    }
    return found ? total : null;
  }

  function staleAsyncCommandEvidence({
    command,
    sessionId,
    completed = false,
    recordedAt,
    nowMs = Date.now(),
  }) {
    if (completed || sessionId == null || sessionId === "") {
      return null;
    }
    const timeoutMs = declaredShellTimeoutMs(command);
    const recordedMs = Date.parse(recordedAt ?? "");
    if (!Number.isFinite(timeoutMs) || !Number.isFinite(recordedMs)) {
      return null;
    }
    const graceMs = Math.max(5000, Math.min(30000, timeoutMs * 0.1));
    if (nowMs < recordedMs + timeoutMs + graceMs) {
      return null;
    }
    const timeoutText = `${timeoutMs / 1000}s`;
    return {
      state: "uncollected",
      sessionId: String(sessionId),
      timeoutMs,
      message: `Output unavailable: asynchronous session ${sessionId} was not polled after its ${timeoutText} command timeout.`,
    };
  }

  root.RALPH_COMMAND_STATUS = Object.freeze({
    declaredShellTimeoutMs,
    staleAsyncCommandEvidence,
  });
})(globalThis);
