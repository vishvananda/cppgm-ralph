import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  buildSubagentTurnResolver as buildTurnResolver,
  compactSubagentText as compactText,
  existingSubagentEventKeys,
  subagentEventThreadId as eventThreadId,
  subagentRunRecord as runRecord,
  subagentTextValue as textValue,
} from "./subagent-event-utils.js";

const CODEX_INDEX_TTL_MS = 2_000;
const THREAD_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sessionIndexes = new Map();

export const DEFAULT_CODEX_DIR = path.join(os.homedir(), ".codex");

export async function collectCodexSubagentEvents(events, options = {}) {
  const rootThreadIds = [...new Set((events ?? []).map(eventThreadId).filter(Boolean))];
  if (!rootThreadIds.length) {
    return [];
  }

  const codexDir = options.codexDir ?? DEFAULT_CODEX_DIR;
  const index = await codexSessionIndex(codexDir);
  const resolveTurn = options.resolveTurn ?? buildTurnResolver(events);
  const existing = existingSubagentEventKeys(events);
  const discovered = new Set(rootThreadIds);
  const queue = rootThreadIds.map((threadId) => ({
    threadId,
    rootThreadId: threadId,
  }));
  const additions = [];

  while (queue.length) {
    const parent = queue.shift();
    const parentFiles = index.get(parent.threadId) ?? [];
    const childRefs = await readChildReferences(parentFiles);
    for (const childRef of childRefs.values()) {
      if (!childRef.threadId || discovered.has(childRef.threadId)) {
        continue;
      }
      discovered.add(childRef.threadId);
      queue.push({ threadId: childRef.threadId, rootThreadId: parent.rootThreadId });

      const childFiles = index.get(childRef.threadId) ?? [];
      const child = await readCodexSubagent(childFiles, childRef, options);
      if (!child) {
        continue;
      }
      const turnNumber = resolveTurn(child.startedAt, parent.rootThreadId);
      if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
        continue;
      }

      const startKey = `start:${parent.rootThreadId}:${child.threadId}`;
      if (!existing.has(startKey)) {
        existing.add(startKey);
        additions.push(runRecord(
          child.startedAt,
          parent.rootThreadId,
          turnNumber,
          "item.started",
          subagentItem(child, "running"),
        ));
      }

      if (child.completedAt) {
        const notificationId = `codex:${child.threadId}`;
        const completeKey = `complete:${parent.rootThreadId}:${notificationId}`;
        if (!existing.has(completeKey)) {
          existing.add(completeKey);
          additions.push(runRecord(
            child.completedAt,
            parent.rootThreadId,
            turnNumber,
            "item.completed",
            {
              ...subagentItem(child, child.status),
              notification_id: notificationId,
              result: compactText(child.result, options.resultLimit),
              ...(Number.isFinite(child.durationMs) ? { duration_ms: child.durationMs } : {}),
              ...(Number.isFinite(child.toolUses) ? { tool_uses: child.toolUses } : {}),
              ...(child.usage ? {
                usage: child.usage,
                subagent_tokens: usageTotalTokens(child.usage),
              } : {}),
            },
          ));
        }
      }
    }
  }

  return additions.sort((left, right) =>
    String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? "")));
}

function subagentItem(child, status) {
  return {
    id: child.threadId,
    type: "subagent",
    provider: "codex",
    status,
    agent_thread_id: child.threadId,
    parent_thread_id: child.parentThreadId,
    model: child.model,
    reasoning_effort: child.reasoningEffort,
    nickname: child.nickname,
    description: firstLine(child.prompt) || child.nickname || "Codex subagent",
    prompt: compactText(child.prompt),
    synthetic: true,
    derived_from_child_transcript: true,
  };
}

async function readChildReferences(filePaths) {
  const refs = new Map();
  for (const filePath of filePaths) {
    const lines = readline.createInterface({
      input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes("agent_id") && !line.includes("agent_path") && !line.includes("subagent_notification")) {
        continue;
      }
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const recordedAt = textValue(raw.timestamp);
      const text = responsePayloadText(raw.payload);
      for (const threadId of extractAgentThreadIds(text)) {
        mergeChildReference(refs, { threadId, startedAt: recordedAt });
      }
      for (const notification of parseSubagentNotifications(text, recordedAt)) {
        mergeChildReference(refs, notification);
      }
    }
  }
  return refs;
}

function mergeChildReference(refs, update) {
  if (!update?.threadId) {
    return;
  }
  const current = refs.get(update.threadId) ?? { threadId: update.threadId };
  refs.set(update.threadId, {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null && value !== "")),
  });
}

function extractAgentThreadIds(text) {
  const regex = new RegExp(`["'](?:agent_id|agent_path)["']\\s*:\\s*["'](${THREAD_ID_PATTERN})["']`, "gi");
  return [...String(text ?? "").matchAll(regex)].map((match) => match[1]);
}

function parseSubagentNotifications(text, recordedAt) {
  const notifications = [];
  const regex = /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/gi;
  let match;
  while ((match = regex.exec(String(text ?? ""))) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (_) {
      continue;
    }
    const threadId = textValue(parsed.agent_path ?? parsed.agent_id);
    if (!new RegExp(`^${THREAD_ID_PATTERN}$`, "i").test(threadId)) {
      continue;
    }
    const status = parsed.status && typeof parsed.status === "object" ? parsed.status : {};
    const failed = status.failed ?? status.errored ?? status.error ?? null;
    const completed = status.completed ?? null;
    notifications.push({
      threadId,
      completedAt: recordedAt,
      status: failed != null ? "failed" : "completed",
      result: textValue(failed ?? completed ?? parsed.result),
    });
  }
  return notifications;
}

async function readCodexSubagent(filePaths, reference, options) {
  if (!filePaths.length) {
    return null;
  }
  const child = {
    threadId: reference.threadId,
    parentThreadId: "",
    nickname: "",
    model: "",
    reasoningEffort: "",
    prompt: "",
    result: textValue(reference.result),
    status: reference.status ?? "running",
    startedAt: textValue(reference.startedAt),
    completedAt: textValue(reference.completedAt),
    durationMs: null,
    toolUses: 0,
    usage: null,
  };

  for (const filePath of filePaths) {
    const lines = readline.createInterface({
      input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const recordedAt = textValue(raw.timestamp);
      child.startedAt = earlierTimestamp(child.startedAt, recordedAt);

      if (raw.type === "session_meta") {
        const payload = raw.payload ?? {};
        const spawn = payload.source?.subagent?.thread_spawn ?? {};
        child.threadId = textValue(payload.id ?? payload.session_id) || child.threadId;
        child.parentThreadId = textValue(payload.parent_thread_id ?? spawn.parent_thread_id) || child.parentThreadId;
        child.nickname = textValue(spawn.agent_nickname ?? payload.agent_nickname) || child.nickname;
        continue;
      }
      if (raw.type === "turn_context") {
        child.model = textValue(raw.payload?.model) || child.model;
        child.reasoningEffort = textValue(raw.payload?.effort) || child.reasoningEffort;
        continue;
      }
      if (raw.type === "response_item") {
        const payload = raw.payload ?? {};
        if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          child.toolUses += 1;
        }
        if (payload.type === "message") {
          const message = responsePayloadText(payload);
          const userTask = payload.role === "user" &&
            !message.includes("<subagent_notification>") &&
            !isCodexInjectedUserContext(message);
          if (userTask) {
            child.prompt ||= message;
            // A completed child can be resumed with send_input. Keep one
            // trajectory/card for the child, but do not leave that card marked
            // complete while a later supervised milestone is still running.
            if (child.completedAt) {
              child.completedAt = "";
              child.status = "running";
            }
          } else if (payload.role === "assistant" && message.trim()) {
            child.result = message;
          }
        }
        continue;
      }
      if (raw.type !== "event_msg") {
        continue;
      }
      const payload = raw.payload ?? {};
      if (payload.type === "token_count" && payload.info?.total_token_usage) {
        child.usage = payload.info.total_token_usage;
      } else if (payload.type === "task_complete") {
        child.completedAt = recordedAt || child.completedAt;
        child.status = "completed";
        child.result = textValue(payload.last_agent_message) || child.result;
        const durationMs = Number(payload.duration_ms);
        if (Number.isFinite(durationMs) && durationMs >= 0) {
          child.durationMs = (Number.isFinite(child.durationMs) ? child.durationMs : 0) + durationMs;
        }
      } else if (payload.type === "task_failed" || payload.type === "turn_aborted") {
        child.completedAt = recordedAt || child.completedAt;
        child.status = "failed";
        child.result = textValue(payload.message ?? payload.error?.message) || child.result;
      }
    }
  }

  if (!child.startedAt) {
    return null;
  }
  if (child.completedAt && !Number.isFinite(child.durationMs)) {
    const start = Date.parse(child.startedAt);
    const end = Date.parse(child.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      child.durationMs = Math.max(0, end - start);
    }
  }
  child.prompt = compactText(child.prompt, options.resultLimit);
  child.result = compactText(child.result, options.resultLimit);
  return child;
}

function responsePayloadText(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  for (const key of ["content", "output"]) {
    if (Array.isArray(payload[key])) {
      return payload[key].map(responsePayloadText).filter(Boolean).join("\n");
    }
  }
  if (typeof payload.output === "string") {
    return payload.output;
  }
  return "";
}

function usageTotalTokens(usage) {
  const total = Number(usage?.total_tokens ?? usage?.totalTokenCount);
  if (Number.isFinite(total) && total >= 0) {
    return total;
  }
  return Math.max(0,
    Number(usage?.input_tokens ?? 0) +
    Number(usage?.output_tokens ?? 0));
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/, 1)[0];
}

function isCodexInjectedUserContext(value) {
  return /^<(?:recommended_plugins|environment_context|permissions|skills|apps|plugins)_?\b/i.test(
    String(value ?? "").trim(),
  );
}

function earlierTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return leftMs <= rightMs ? left : right;
}

async function codexSessionIndex(codexDir) {
  const root = path.resolve(codexDir, "sessions");
  const now = Date.now();
  const cached = sessionIndexes.get(root);
  if (cached && now - cached.loadedAt < CODEX_INDEX_TTL_MS) {
    return cached.index;
  }
  const index = new Map();
  await walkCodexSessions(root, index, 0);
  sessionIndexes.set(root, { loadedAt: now, index });
  return index;
}

async function walkCodexSessions(directory, index, depth) {
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
      await walkCodexSessions(entryPath, index, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(new RegExp(`(${THREAD_ID_PATTERN})\\.jsonl$`, "i"));
    if (!match) {
      continue;
    }
    const files = index.get(match[1]) ?? [];
    files.push(entryPath);
    index.set(match[1], files);
  }
}
