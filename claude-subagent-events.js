import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CLAUDE_INDEX_TTL_MS = 5_000;
const DEFAULT_RESULT_LIMIT = 12_000;
let sessionIndex = null;
let sessionIndexBuiltAt = 0;

export const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function claudeSubagentStartItem(block) {
  const input = block?.input && typeof block.input === "object" ? block.input : {};
  return {
    id: block?.id ?? "claude-agent",
    type: "subagent",
    provider: "claude",
    status: "running",
    description: textValue(input.description),
    subagent_type: textValue(input.subagent_type),
    prompt: textValue(input.prompt),
  };
}

export function claudeSubagentResultItem(toolUseId, pending, output, options = {}) {
  const startedAtMs = Date.parse(pending?.startedAt ?? "");
  const completedAtMs = Date.parse(options.completedAt ?? "");
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, completedAtMs - startedAtMs)
    : null;
  return {
    ...claudeSubagentStartItem({ id: toolUseId, input: pending?.input }),
    status: options.failed ? "failed" : "completed",
    result: compactText(output, options.resultLimit),
    ...(Number.isFinite(durationMs) ? { duration_ms: durationMs } : {}),
  };
}

export function isClaudeAsyncSubagentLaunch(output) {
  return /\bAsync agent launched successfully\b/i.test(String(output ?? ""));
}

export function claudeResumedSubagentStartItem(toolUseId, pending, toolUseResult, output) {
  const resumedAgentId = textValue(toolUseResult?.resumedAgentId) ||
    textValue(toolUseResult?.resumed_agent_id) ||
    resumedAgentIdFromText(output);
  if (!resumedAgentId) {
    return null;
  }
  const input = pending?.input && typeof pending.input === "object" ? pending.input : {};
  return {
    id: toolUseId,
    type: "subagent",
    provider: "claude",
    status: "running",
    task_id: resumedAgentId,
    description: textValue(input.summary) || `Resume agent ${resumedAgentId}`,
    subagent_type: "resumed",
    prompt: textValue(input.message ?? input.content),
  };
}

export function parseClaudeTaskNotification(event, options = {}) {
  const attachment = event?.attachment ?? event;
  const attachmentPrompt = attachment?.type === "queued_command" &&
    attachment.commandMode === "task-notification"
    ? textValue(attachment.prompt)
    : "";
  const userPrompt = event?.type === "user" && typeof event.message?.content === "string"
    ? event.message.content
    : "";
  const prompt = attachmentPrompt || userPrompt;
  if (!prompt.includes("<task-notification>")) {
    return null;
  }
  const summary = xmlTag(prompt, "summary");
  const tokenCount = numberTag(prompt, "subagent_tokens");
  if (!Number.isFinite(tokenCount) && !/^Agent\s+["']/i.test(summary)) {
    return null;
  }
  const toolUseId = xmlTag(prompt, "tool-use-id");
  if (!toolUseId) {
    return null;
  }
  const rawStatus = xmlTag(prompt, "status").toLowerCase();
  const status = rawStatus === "completed" ? "completed" : rawStatus || "failed";
  const durationMs = numberTag(prompt, "duration_ms");
  const toolUses = numberTag(prompt, "tool_uses");
  const notificationId = textValue(event?.uuid) ||
    `${toolUseId}:${textValue(event?.timestamp ?? attachment.timestamp)}`;
  return {
    id: toolUseId,
    type: "subagent",
    provider: "claude",
    status,
    task_id: xmlTag(prompt, "task-id"),
    notification_id: notificationId,
    summary,
    description: agentDescription(summary),
    result: compactText(xmlTag(prompt, "result"), options.resultLimit),
    ...(Number.isFinite(durationMs) ? { duration_ms: durationMs } : {}),
    ...(Number.isFinite(toolUses) ? { tool_uses: toolUses } : {}),
    ...(Number.isFinite(tokenCount) ? { subagent_tokens: tokenCount } : {}),
  };
}

export async function collectClaudeSubagentEvents(events, options = {}) {
  const threadIds = [...new Set((events ?? []).map(eventThreadId).filter(Boolean))];
  if (!threadIds.length) {
    return [];
  }
  const claudeDir = options.claudeDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  const files = await findClaudeSessionFiles(claudeDir, threadIds);
  if (!files.size) {
    return [];
  }
  const resolveTurn = options.resolveTurn ?? buildTurnResolver(events);
  const closedTurns = closedTurnNumbers(events);
  const existing = existingSubagentEventKeys(events);
  const additions = [];
  for (const threadId of threadIds) {
    const filePath = files.get(threadId);
    if (!filePath) {
      continue;
    }
    const threadAdditions = await readClaudeSubagentEvents(
      filePath,
      threadId,
      resolveTurn,
      existing,
      { ...options, closedTurns },
    );
    for (const event of threadAdditions) additions.push(event);
  }
  return additions.sort((left, right) =>
    String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? "")));
}

async function readClaudeSubagentEvents(filePath, threadId, resolveTurn, existing, options) {
  const additions = [];
  const startsById = new Map();
  const pendingMessages = new Map();
  const completedIds = new Set();
  const lines = readline.createInterface({
    input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (
      !line.includes('"name":"Agent"') &&
      !line.includes('"name":"SendMessage"') &&
      !line.includes("resumedAgentId") &&
      !line.includes("<subagent_tokens>")
    ) {
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const recordedAt = textValue(raw.timestamp);
    const turnNumber = resolveTurn(recordedAt, threadId);
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      continue;
    }
    if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
      for (const block of raw.message.content) {
        if (block?.type !== "tool_use" || !block.id) {
          continue;
        }
        if (block.name === "SendMessage") {
          pendingMessages.set(block.id, {
            pending: { input: block.input },
            recordedAt,
            turnNumber,
          });
          continue;
        }
        if (block.name !== "Agent") continue;
        const key = `start:${threadId}:${block.id}`;
        if (existing.has(key)) {
          continue;
        }
        existing.add(key);
        const item = {
          ...claudeSubagentStartItem(block),
          synthetic: true,
        };
        startsById.set(block.id, { item, recordedAt, turnNumber });
        additions.push(runRecord(recordedAt, threadId, turnNumber, "item.started", item));
      }
      continue;
    }
    if (raw.type === "user" && Array.isArray(raw.message?.content)) {
      for (const block of raw.message.content) {
        if (block?.type !== "tool_result" || !block.tool_use_id) continue;
        const pending = pendingMessages.get(block.tool_use_id);
        if (!pending) continue;
        pendingMessages.delete(block.tool_use_id);
        const output = toolResultText(block, raw.toolUseResult);
        const item = claudeResumedSubagentStartItem(
          block.tool_use_id,
          pending.pending,
          raw.toolUseResult,
          output,
        );
        if (!item) continue;
        const key = `start:${threadId}:${item.id}`;
        if (!existing.has(key)) {
          existing.add(key);
          startsById.set(item.id, {
            item: { ...item, synthetic: true },
            recordedAt,
            turnNumber,
          });
          additions.push(runRecord(recordedAt, threadId, turnNumber, "item.started", {
            ...item,
            synthetic: true,
          }));
        }
      }
      continue;
    }
    const item = parseClaudeTaskNotification(raw, options);
    if (!item) {
      continue;
    }
    completedIds.add(item.id);
    const key = `complete:${threadId}:${item.notification_id}`;
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    additions.push(runRecord(recordedAt, threadId, turnNumber, "item.completed", {
      ...item,
      synthetic: true,
    }));
  }
  if (options.childTranscriptFallback !== false) {
    const fallbacks = await childTranscriptCompletionFallbacks(
      filePath,
      threadId,
      startsById,
      completedIds,
      existing,
      options,
    );
    for (const event of fallbacks) additions.push(event);
  }
  return additions;
}

async function childTranscriptCompletionFallbacks(
  parentFile,
  threadId,
  startsById,
  completedIds,
  existing,
  options,
) {
  const missing = [...startsById.entries()].filter(([id]) => !completedIds.has(id));
  if (!missing.length) {
    return [];
  }
  const subagentDir = path.join(
    path.dirname(parentFile),
    path.basename(parentFile, ".jsonl"),
    "subagents",
  );
  let entries;
  try {
    entries = await fs.readdir(subagentDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const childByPrompt = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !/^agent-.+\.jsonl$/.test(entry.name)) continue;
    const filePath = path.join(subagentDir, entry.name);
    const first = await firstJsonLine(filePath);
    const prompt = first?.type === "user" ? textValue(first.message?.content) : "";
    if (prompt) {
      const files = childByPrompt.get(prompt) ?? [];
      files.push(filePath);
      childByPrompt.set(prompt, files);
    }
  }

  const additions = [];
  for (const [toolUseId, start] of missing) {
    if (!options.closedTurns?.has(start.turnNumber)) continue;
    const files = childByPrompt.get(start.item.prompt) ?? [];
    const childFile = files.shift();
    if (!childFile) continue;
    const completion = await readChildTranscriptCompletion(childFile, options);
    if (!completion) continue;
    const notificationId = `child:${completion.agentId || path.basename(childFile, ".jsonl")}`;
    const key = `complete:${threadId}:${notificationId}`;
    if (existing.has(key)) continue;
    existing.add(key);
    additions.push(runRecord(
      completion.recordedAt,
      threadId,
      start.turnNumber,
      "item.completed",
      {
        ...start.item,
        status: completion.status,
        notification_id: notificationId,
        summary: `Agent "${start.item.description || "subagent"}" finished`,
        result: completion.result,
        duration_ms: completion.durationMs,
        tool_uses: completion.toolUses,
        synthetic: true,
        derived_from_child_transcript: true,
      },
    ));
  }
  return additions;
}

function closedTurnNumbers(events) {
  const turns = new Set();
  let latest = null;
  for (const record of events ?? []) {
    const turn = record?.turnNumber;
    if (!Number.isInteger(turn) || turn <= 0) continue;
    turns.add(turn);
    latest = latest == null ? turn : Math.max(latest, turn);
  }
  const closed = new Set();
  for (const turn of turns) {
    if (latest != null && turn < latest) closed.add(turn);
  }
  for (const record of events ?? []) {
    if (record?.eventType === "turn.completed" && Number.isInteger(record.turnNumber)) {
      closed.add(record.turnNumber);
    }
  }
  return closed;
}

async function firstJsonLine(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    return line ? JSON.parse(line) : null;
  } catch (_) {
    return null;
  } finally {
    await handle.close();
  }
}

async function readChildTranscriptCompletion(filePath, options) {
  const lines = readline.createInterface({
    input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let firstAt = null;
  let lastAt = null;
  let agentId = "";
  let result = "";
  let toolUses = 0;
  for await (const line of lines) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const time = Date.parse(raw.timestamp ?? "");
    if (Number.isFinite(time)) {
      firstAt = firstAt == null ? time : Math.min(firstAt, time);
      lastAt = lastAt == null ? time : Math.max(lastAt, time);
    }
    agentId ||= textValue(raw.agentId);
    if (raw.type !== "assistant" || !Array.isArray(raw.message?.content)) continue;
    for (const block of raw.message.content) {
      if (block?.type === "tool_use") toolUses += 1;
      if (block?.type === "text" && textValue(block.text).trim()) {
        result = block.text;
      }
    }
  }
  if (firstAt == null || lastAt == null) {
    return null;
  }
  return {
    agentId,
    recordedAt: new Date(lastAt).toISOString(),
    durationMs: Math.max(0, lastAt - firstAt),
    toolUses,
    result: compactText(result, options.resultLimit),
    status: result ? "completed" : "failed",
  };
}

function runRecord(recordedAt, threadId, turnNumber, eventType, item) {
  return {
    recordedAt,
    threadId,
    turnNumber,
    eventType,
    event: { type: eventType, item },
  };
}

function existingSubagentEventKeys(events) {
  const keys = new Set();
  for (const record of events ?? []) {
    const item = record?.event?.item;
    if (item?.type !== "subagent" || !item.id) {
      continue;
    }
    const threadId = eventThreadId(record) ?? "";
    if (record.eventType === "item.started") {
      keys.add(`start:${threadId}:${item.id}`);
    } else if (record.eventType === "item.completed") {
      keys.add(`complete:${threadId}:${item.notification_id ?? `${item.id}:${record.recordedAt ?? ""}`}`);
    }
  }
  return keys;
}

async function findClaudeSessionFiles(root, threadIds) {
  const index = await claudeSessionIndex(root);
  const matches = new Map();
  for (const threadId of threadIds) {
    const filePath = index.get(threadId);
    if (filePath) {
      matches.set(threadId, filePath);
    }
  }
  return matches;
}

async function claudeSessionIndex(root) {
  const now = Date.now();
  if (sessionIndex && now - sessionIndexBuiltAt < CLAUDE_INDEX_TTL_MS) {
    return sessionIndex;
  }
  const index = new Map();
  await walkClaudeProjects(root, index, 0);
  sessionIndex = index;
  sessionIndexBuiltAt = now;
  return index;
}

async function walkClaudeProjects(directory, index, depth) {
  if (depth > 3) {
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
      if (entry.name !== "subagents") {
        await walkClaudeProjects(entryPath, index, depth + 1);
      }
      continue;
    }
    const match = entry.isFile() ? entry.name.match(/^(.+)\.jsonl$/) : null;
    if (match) {
      index.set(match[1], entryPath);
    }
  }
}

function buildTurnResolver(events) {
  const starts = (events ?? [])
    .filter((record) =>
      record?.eventType === "ralph.prompt" ||
      (record?.eventType === "ralph.phase-status" && record.event?.action === "turn-start"))
    .map((record) => ({
      threadId: eventThreadId(record),
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

function eventThreadId(record) {
  return record?.threadId ?? record?.event?.thread_id ?? record?.event?.threadId ?? null;
}

function xmlTag(text, name) {
  const match = String(text ?? "").match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeXml(match?.[1] ?? "").trim();
}

function numberTag(text, name) {
  const value = Number(xmlTag(text, name));
  return Number.isFinite(value) ? value : null;
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function agentDescription(summary) {
  const match = String(summary ?? "").match(/^Agent\s+["']([\s\S]*?)["']\s+finished$/i);
  return match?.[1] ?? String(summary ?? "");
}

function compactText(value, limit = DEFAULT_RESULT_LIMIT) {
  const text = textValue(value);
  const max = Number.isFinite(limit) ? Math.max(1_000, limit) : DEFAULT_RESULT_LIMIT;
  if (text.length <= max) {
    return text;
  }
  const edge = Math.floor((max - 80) / 2);
  return `${text.slice(0, edge)}\n\n... subagent output omitted ...\n\n${text.slice(-edge)}`;
}

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function resumedAgentIdFromText(value) {
  const text = textValue(value);
  const jsonMatch = text.match(/"resumedAgentId"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  return text.match(/Agent\s+["']([^"']+)["']\s+had no active task/i)?.[1] ?? "";
}

function toolResultText(block, toolUseResult) {
  if (typeof block?.content === "string") return block.content;
  if (Array.isArray(block?.content)) {
    return block.content
      .map((entry) => typeof entry === "string" ? entry : textValue(entry?.text))
      .filter(Boolean)
      .join("\n");
  }
  return toolUseResult && typeof toolUseResult === "object"
    ? JSON.stringify(toolUseResult)
    : "";
}
