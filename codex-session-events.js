import fs from "node:fs/promises";
import path from "node:path";

export function createCodexSessionTailer({
  codexDir,
  threadId,
  sinceMs,
  pollMs = 1000,
  seenKeys = new Set(),
  onEvent,
  onError = null,
}) {
  const converter = new CodexSessionConverter();
  const offsets = new Map();
  let stopped = false;
  let polling = false;
  let timer = null;

  const poll = async () => {
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      await pollCodexSessionEvents({
        codexDir,
        threadId,
        sinceMs,
        seenKeys,
        converter,
        offsets,
        onEvent,
      });
    } catch (error) {
      onError?.(error);
    } finally {
      polling = false;
    }
  };

  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(poll, pollMs);
      timer.unref?.();
      poll();
    },
    async flush() {
      await poll();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export async function backfillCodexSessionEvents({
  codexDir,
  threadId,
  sinceMs,
  seenKeys = new Set(),
  onEvent,
}) {
  const converter = new CodexSessionConverter();
  const offsets = new Map();
  await pollCodexSessionEvents({
    codexDir,
    threadId,
    sinceMs,
    seenKeys,
    converter,
    offsets,
    onEvent,
  });
}

export async function findCodexSessionFiles(codexDir, threadId) {
  if (typeof threadId !== "string" || !threadId) {
    return [];
  }
  const sessionsDir = path.join(codexDir, "sessions");
  const matches = [];
  await walkCodexSessionFiles(sessionsDir, matches, threadId, 0);
  return matches.sort();
}

async function walkCodexSessionFiles(directory, matches, threadId, depth) {
  if (depth > 6) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkCodexSessionFiles(entryPath, matches, threadId, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
      matches.push(entryPath);
    }
  }
}

async function pollCodexSessionEvents({
  codexDir,
  threadId,
  sinceMs,
  seenKeys,
  converter,
  offsets,
  onEvent,
}) {
  const files = await findCodexSessionFiles(codexDir, threadId);
  for (const filePath of files) {
    await pollCodexSessionFile({
      filePath,
      sinceMs,
      seenKeys,
      converter,
      offsets,
      onEvent,
    });
  }
}

async function pollCodexSessionFile({
  filePath,
  sinceMs,
  seenKeys,
  converter,
  offsets,
  onEvent,
}) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let offset = offsets.get(filePath) ?? 0;
  if (stat.size < offset) {
    offset = 0;
  }
  if (stat.size === offset) {
    return;
  }

  const raw = await readFileRange(filePath, offset, stat.size);
  offsets.set(filePath, stat.size);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    const timestampMs = Date.parse(record.timestamp ?? "");
    if (Number.isFinite(sinceMs) && Number.isFinite(timestampMs) && timestampMs < sinceMs) {
      continue;
    }
    const event = converter.convert(record);
    if (!event) {
      continue;
    }
    const key = codexEventKey(event, record.timestamp);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    await onEvent(event, record);
  }
}

async function readFileRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (length === 0) {
    return "";
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

class CodexSessionConverter {
  constructor() {
    this.commandsByCallId = new Map();
    this.functionCallsByCallId = new Map();
    this.commandsBySessionId = new Map();
  }

  convert(record) {
    if (!record || typeof record !== "object") {
      return null;
    }
    if (record.type === "event_msg") {
      return this.convertEventMessage(record.payload);
    }
    if (record.type === "response_item") {
      return this.convertResponseItem(record.payload, record.timestamp);
    }
    return null;
  }

  convertEventMessage(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (payload.type === "token_count" && payload.info?.total_token_usage) {
      return {
        type: "codex.session.token_count",
        usage: payload.info.total_token_usage,
        raw: payload,
      };
    }
    if (payload.type === "task_complete") {
      return {
        type: "codex.task_complete",
        durationMs: Number(payload.duration_ms ?? 0),
        raw: payload,
      };
    }
    if (payload.type === "thread_goal_updated") {
      return {
        type: "codex.thread_goal_updated",
        timeUsedSeconds: Number(payload.goal?.timeUsedSeconds ?? 0),
        raw: payload,
      };
    }
    if (payload.type === "patch_apply_end" && payload.changes) {
      return {
        type: "item.completed",
        item: {
          id: payload.call_id ?? "patch",
          type: "file_change",
          status: payload.status ?? (payload.success ? "completed" : "failed"),
          changes: Object.entries(payload.changes).map(([filePath, change]) => ({
            kind: change?.type ?? "update",
            path: filePath,
            diff: change?.unified_diff ?? "",
            movePath: change?.move_path ?? null,
          })),
          raw: payload,
        },
      };
    }
    return null;
  }

  convertResponseItem(payload, timestamp) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (payload.type === "function_call") {
      const args = parseFunctionCallArgs(payload);
      const command = formatFunctionCall(payload, args, this);
      if (payload.call_id) {
        this.commandsByCallId.set(payload.call_id, command);
        this.functionCallsByCallId.set(payload.call_id, {
          name: payload.name,
          args,
          command,
        });
      }
      return {
        type: "item.started",
        item: {
          id: payload.call_id,
          type: "command_execution",
          status: "running",
          command,
          raw: payload,
        },
      };
    }
    if (payload.type === "function_call_output") {
      const call = this.functionCallsByCallId.get(payload.call_id) ?? null;
      if (call?.name === "exec_command") {
        const sessionId = parseRunningSessionId(payload.output);
        if (sessionId && call.command) {
          this.commandsBySessionId.set(sessionId, call.command);
        }
      }
      const command =
        call?.name === "write_stdin"
          ? formatWriteStdinCommand(call.args, this)
          : this.commandsByCallId.get(payload.call_id) ?? "";
      return {
        type: "item.completed",
        item: {
          id: payload.call_id,
          type: "command_execution",
          status: "completed",
          exit_code: parseFunctionOutputExitCode(payload.output),
          command,
          session_id: call?.args?.session_id ?? null,
          stdin: call?.name === "write_stdin" ? call.args?.chars ?? "" : null,
          aggregated_output: payload.output ?? "",
          raw: payload,
        },
      };
    }
    if (payload.type === "message" && payload.role === "assistant") {
      const text = extractAssistantMessageText(payload);
      if (!text) {
        return null;
      }
      return {
        type: "item.completed",
        item: {
          id: `message-${timestamp ?? Date.now()}`,
          type: "agent_message",
          text,
        },
      };
    }
    if (payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((item) => item.text ?? "").filter(Boolean).join("\n")
        : "";
      if (!summary) {
        return null;
      }
      return {
        type: "item.completed",
        item: {
          id: `reasoning-${timestamp ?? Date.now()}`,
          type: "reasoning",
          text: summary,
        },
      };
    }
    return null;
  }
}

function parseFunctionCallArgs(payload) {
  try {
    return payload.arguments ? JSON.parse(payload.arguments) : {};
  } catch (_) {
    return null;
  }
}

function formatFunctionCall(payload, args, context) {
  if (!args || typeof args !== "object") {
    return `${payload.name} ${payload.arguments ?? ""}`.trim();
  }
  if (payload.name === "exec_command" && args.cmd) {
    return args.cmd;
  }
  if (payload.name === "write_stdin") {
    return formatWriteStdinCommand(args, context);
  }
  if (payload.name === "apply_patch") {
    return "apply_patch";
  }
  return `${payload.name} ${JSON.stringify(args)}`;
}

function formatWriteStdinCommand(args, context) {
  const sessionId = normalizeSessionId(args?.session_id);
  const originalCommand = sessionId ? context.commandsBySessionId.get(sessionId) : null;
  const stdin = typeof args?.chars === "string" ? args.chars : "";
  const suffix = sessionId ? `session ${sessionId}` : "unknown session";
  const base = originalCommand
    ? `${originalCommand} (continued ${suffix})`
    : `write_stdin ${suffix}`;
  if (!stdin) {
    return base;
  }
  return `${base} stdin=${JSON.stringify(truncateMiddle(stdin, 160))}`;
}

function parseRunningSessionId(output) {
  const match = String(output ?? "").match(/Process running with session ID (\d+)/);
  return match ? match[1] : null;
}

function normalizeSessionId(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function truncateMiddle(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function parseFunctionOutputExitCode(output) {
  const match = String(output ?? "").match(/Process exited with code (-?\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function extractAssistantMessageText(payload) {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .map((part) => part?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

export function codexEventKey(event, timestamp = "") {
  const item = event?.item;
  if (item) {
    return [
      timestamp,
      event.type,
      item.id ?? "",
      item.type ?? "",
      item.command ?? "",
      item.text ?? "",
    ].join("|");
  }
  return [
    timestamp,
    event?.type ?? "",
    event?.raw?.turn_id ?? "",
    event?.usage?.total_tokens ?? "",
    event?.timeUsedSeconds ?? "",
  ].join("|");
}
