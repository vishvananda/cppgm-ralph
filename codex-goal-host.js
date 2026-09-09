import { assertCodexGoalComplete } from "./codex-goal-completion.js";

// A native task completion is an internal checkpoint, not the lifetime of
// the app-server (and its unified-exec sessions). Only a verified terminal
// goal plus an idle turn releases the host to the caller for cleanup.
export async function runCodexGoalHost({
  client, threadId, resumeParams, input, onEvent,
  continuationPrompt, continuationMax = 20,
  settleMs = 2000, continuationGraceMs = 60_000,
}) {
  let activeTurnId = null;
  let completed = null;
  let revision = 0;
  let timer = null;
  let checking = false;
  let stopped = false;
  let nudges = 0;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Startup RPC errors can arrive before the caller begins awaiting done.
  done.catch(() => {});

  const fail = (error) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    error.threadId ??= threadId;
    // A host that exits successfully before goal verification still abandoned
    // the attempt. Recover the same thread, never advance or reset its goal.
    if (error.exitCode === 0) error.codexIncompleteTask = true;
    rejectDone(error);
  };
  const schedule = (delay = settleMs) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(check, delay);
  };
  const stillIdle = (version) => !stopped && !activeTurnId && revision === version;
  const check = async () => {
    if (stopped || activeTurnId || !completed) return;
    if (checking) { schedule(); return; }
    checking = true;
    const version = revision;
    try {
      const { goal } = await client.request("thread/goal/get", { threadId });
      if (!stillIdle(version)) return;
      if (goal?.status !== "active" || (goal.threadId && goal.threadId !== threadId)) {
        assertCodexGoalComplete(goal, threadId);
        stopped = true;
        clearTimeout(timer);
        resolveDone(goal);
        return;
      }

      const remaining = continuationGraceMs - (Date.now() - completed.at);
      if (remaining > 0) { schedule(remaining); return; }
      // Let native goal continuation own scheduling. A fallback nudge is only
      // for a verified idle host, never an observation timeout or live task.
      const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
      if (!stillIdle(version)) return;
      if (thread?.status?.type === "active") { schedule(); return; }
      if (thread?.id !== threadId || thread?.status?.type !== "idle") {
        throw new Error("Cannot verify an idle Codex goal host; refusing to start duplicate work.");
      }
      if (++nudges > continuationMax) {
        throw new Error(`Codex goal remained incomplete after ${continuationMax} in-host continuations.`);
      }
      onEvent({ type: "codex.goal_continuation", thread_id: threadId, attempt: nudges,
        message: "Continuing the active goal in the same execution host." });
      await startTurn([{ type: "text", text: continuationPrompt }]);
    } catch (error) {
      fail(error);
    } finally {
      checking = false;
    }
  };

  const startTurn = async (turnInput) => {
    const version = revision;
    const result = await client.request("turn/start", { threadId, input: turnInput });
    if (stopped || revision !== version) return; // Notifications can precede the RPC response.
    if (!result.turn?.id || result.turn.status !== "inProgress") {
      throw new Error("Codex turn/start did not return an active turn.");
    }
    activeTurnId = result.turn.id;
    completed = null;
    revision += 1;
  };

  client.onFailure = fail;
  client.onNotification = ({ method, params = {} }) => {
    if (stopped || params.threadId !== threadId) return;
    if (method === "turn/started") {
      clearTimeout(timer);
      const continuing = Boolean(completed);
      activeTurnId = params.turn.id;
      completed = null;
      revision += 1;
      onEvent({ type: continuing ? "codex.goal_continuation" : "turn.started",
        thread_id: threadId, codex_turn_id: activeTurnId,
        ...(continuing ? { message: "Native goal continuation; execution host remains active." } : {}) });
    } else if (method === "turn/completed") {
      if (activeTurnId && activeTurnId !== params.turn.id) return;
      if (completed?.id === params.turn.id) return;
      if (params.turn.status !== "completed") {
        const error = new Error(params.turn.error?.message ?? `Codex turn ${params.turn.status}.`);
        if (params.turn.error?.codexErrorInfo === "usageLimitExceeded") {
          error.codexUsageLimit = true;
          error.codexErrorInfo = "usage_limit_exceeded";
        }
        fail(error);
        return;
      }
      activeTurnId = null;
      completed = { id: params.turn.id, at: Date.now() };
      revision += 1;
      schedule();
    } else if (method === "error" && !params.willRetry) {
      const error = new Error(params.error?.message ?? "Codex app-server reported an error.");
      if (params.error?.codexErrorInfo === "usageLimitExceeded") {
        error.codexUsageLimit = true;
        error.codexErrorInfo = "usage_limit_exceeded";
      }
      fail(error);
    } else if (method === "thread/closed") {
      fail(new Error("Codex execution host unloaded the active goal thread."));
    }
  };

  try {
    await client.initialize();
    const resumed = await client.request("thread/resume", { ...resumeParams, threadId, excludeTurns: true });
    if (resumed.thread?.id !== threadId) throw new Error("Codex resumed a different goal thread.");
    onEvent({ type: "thread.started", thread_id: threadId });
    if (stopped) return await done;
    await startTurn(input);
    return await done;
  } finally {
    stopped = true;
    clearTimeout(timer);
    client.onNotification = null;
    client.onFailure = null;
  }
}
