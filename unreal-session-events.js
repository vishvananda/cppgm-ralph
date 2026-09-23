import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { UnrealAgentEventConverter } from "./unreal-agent-events.js";

function pendingCommands(events) {
  const byThread = new Map();
  for (const record of events) {
    const threadId = record?.threadId;
    const item = record?.event?.item;
    if (typeof threadId !== "string" || !threadId.startsWith("unreal-") || !item?.id) continue;
    const commands = byThread.get(threadId) ?? new Map();
    if (record.eventType === "item.started" && item.type === "command_execution") {
      commands.set(item.id, record);
    } else if (record.eventType === "item.completed") {
      commands.delete(item.id);
    }
    byThread.set(threadId, commands);
  }
  return [...byThread.entries()].filter(([, commands]) => commands.size > 0);
}

function unrealThreadTurns(events) {
  const threads = new Map();
  for (const record of events) {
    const threadId = record?.threadId;
    if (typeof threadId !== "string" || !threadId.startsWith("unreal-")) continue;
    if (!Number.isInteger(record.turnNumber) || record.turnNumber <= 0) continue;
    const turns = threads.get(threadId) ?? new Map();
    const time = Date.parse(record.recordedAt ?? "");
    const previous = turns.get(record.turnNumber);
    if (!previous || (Number.isFinite(time) && time < previous.time)) {
      turns.set(record.turnNumber, { turnNumber: record.turnNumber, time });
    }
    threads.set(threadId, turns);
  }
  return new Map([...threads].map(([threadId, turns]) => [threadId,
    [...turns.values()].sort((a, b) => a.time - b.time)]));
}

function turnForTimestamp(turns, timestamp) {
  const time = Date.parse(timestamp ?? "");
  let selected = turns[0]?.turnNumber ?? null;
  for (const turn of turns) {
    if (Number.isFinite(time) && Number.isFinite(turn.time) && turn.time > time) break;
    selected = turn.turnNumber;
  }
  return selected;
}

async function sessionDirectory(filePath, workDir) {
  const runDir = path.dirname(path.dirname(filePath));
  const runName = path.basename(runDir);
  const stateBaseDir = path.dirname(runDir);
  const defaultDir = path.join(stateBaseDir, "unreal-provider", runName, "sessions");
  if (existsSync(defaultDir) || !workDir) return defaultDir;

  // A run can override unrealStateDir. Only consult configs when the default
  // location is absent; the common live path needs no config-directory scan.
  let names;
  try {
    names = await fs.readdir(workDir);
  } catch (_) {
    return defaultDir;
  }
  for (const name of names.filter((entry) => entry.endsWith(".config.json"))) {
    try {
      const config = JSON.parse(await fs.readFile(path.join(workDir, name), "utf8"));
      if (config.provider !== "unreal" || !config.unrealStateDir) continue;
      const shape = `${config.name}-${config.model}-${config.reasoningEffort}`;
      if (shape === runName) return path.join(config.unrealStateDir, "sessions");
    } catch (_) {
      // Unrelated or partially written configs do not affect this run.
    }
  }
  return defaultDir;
}

export async function unrealSessionPathsForEvents(events, { filePath, workDir = null }) {
  const threads = unrealThreadTurns(events);
  if (!threads.size) return [];
  const directory = await sessionDirectory(filePath, workDir);
  return [...threads.keys()].map((threadId) => path.join(directory, `${threadId}.session.jsonl`));
}

export async function addUnrealSessionDisplayEvents(events, { filePath, workDir = null, onSourceFile = null }) {
  const pending = new Map(pendingCommands(events));
  const threads = unrealThreadTurns(events);
  if (!threads.size) return events;
  const directory = await sessionDirectory(filePath, workDir);
  const synthetic = [];
  const responseGroups = new Map();
  const existingReasoning = new Set(events.filter((record) =>
    record.eventType === "item.completed" && record.event?.item?.type === "reasoning")
    .map((record) => `${record.threadId}\0${record.event.item.id}`));
  for (const [threadId, turns] of threads) {
    const sessionPath = path.join(directory, `${threadId}.session.jsonl`);
    if (!existsSync(sessionPath)) continue;
    onSourceFile?.(sessionPath);
    const converter = new UnrealAgentEventConverter();
    let responseStep = 0;
    for (const [id, record] of pending.get(threadId) ?? []) converter.commands.set(id, record.event.item);
    const lines = readline.createInterface({
      input: createReadStream(sessionPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let sessionRecord;
      try {
        sessionRecord = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const item = sessionRecord.data?.Item;
      if (item?.Kind === "model_response") {
        responseStep += 1;
        const outputs = item.Data?.Response?.Output ?? [];
        const commandCount = outputs.filter((output) =>
          output?.Type === "tool_call" && output.Data?.Name === "Bash").length;
        for (const [index, output] of outputs.entries()) {
          const id = String(output?.Type === "tool_call"
            ? output.Data?.CallID || output.ProviderID || `${item.Sequence}-${index}`
            : output?.ProviderID || `${item.Sequence}-${index}`);
          responseGroups.set(`${threadId}\0${id}`, { response_step: responseStep, response_command_count: commandCount });
          if (output?.Type !== "reasoning") continue;
          const summary = Array.isArray(output.Data?.Summary)
            ? output.Data.Summary.filter((part) => typeof part === "string" && part.trim()).join("\n")
            : "";
          const key = `${threadId}\0${id}`;
          if (!summary || existingReasoning.has(key)) continue;
          existingReasoning.add(key);
          synthetic.push({
            recordedAt: item.RecordedAt ?? new Date().toISOString(),
            threadId,
            turnNumber: turnForTimestamp(turns, item.RecordedAt),
            eventType: "item.completed",
            event: { type: "item.completed", item: {
              id, type: "reasoning", text: summary,
              response_step: responseStep, response_command_count: commandCount,
            } },
          });
        }
      }
      for (const event of converter.completeFromSessionRecord(sessionRecord)) {
        const start = pending.get(threadId)?.get(event.item.id);
        synthetic.push({
          recordedAt: item?.RecordedAt ?? new Date().toISOString(),
          threadId,
          turnNumber: start?.turnNumber ?? null,
          eventType: event.type,
          event,
        });
      }
    }
  }
  const withResponseGroup = (record) => {
    const item = record.event?.item;
    const group = item?.id && responseGroups.get(`${record.threadId}\0${item.id}`);
    return group && (item.response_step !== group.response_step ||
      item.response_command_count !== group.response_command_count)
      ? { ...record, event: { ...record.event, item: { ...item, ...group } } }
      : record;
  };
  const groupedEvents = events.map(withResponseGroup);
  if (!synthetic.length) return groupedEvents;
  return [...groupedEvents, ...synthetic.map(withResponseGroup)].sort((left, right) =>
    String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? "")));
}
