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

export class CodexSessionConverter {
  constructor() {
    this.commandsByCallId = new Map();
    this.functionCallsByCallId = new Map();
    this.commandsBySessionId = new Map();
    this.sessionIdsByStoreKey = new Map();
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
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const args = parseFunctionCallArgs(payload);
      const command = formatFunctionCall(payload, args, this);
      if (payload.call_id) {
        const batchCommands = payload.name === "exec" && typeof args?.input === "string"
          ? extractToolCommandBatch(args.input, this)
          : [];
        this.commandsByCallId.set(payload.call_id, command);
        this.functionCallsByCallId.set(payload.call_id, {
          name: payload.name,
          args,
          command,
          batchCommands,
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
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = this.functionCallsByCallId.get(payload.call_id) ?? null;
      const parentSessionId = functionCallParentSessionId(call, this);
      const parentCommand = parentSessionId
        ? this.commandsBySessionId.get(parentSessionId)
        : null;
      const sessionId = parseRunningSessionId(payload.output);
      const batchCommands = buildCommandBatch(call?.batchCommands, payload.output);
      if (batchCommands) {
        for (const part of batchCommands) {
          const partSessionId = part.session_id == null ? "" : String(part.session_id);
          if (partSessionId && part.command && !this.commandsBySessionId.has(partSessionId)) {
            this.commandsBySessionId.set(partSessionId, part.command);
          }
        }
      } else if (sessionId && (parentCommand || call?.command)) {
        this.commandsBySessionId.set(sessionId, parentCommand ?? call.command);
      }
      const sessionStoreKey = functionCallSessionStoreKey(call);
      if (sessionId && sessionStoreKey) {
        this.sessionIdsByStoreKey.set(sessionStoreKey, sessionId);
      }
      const command =
        call?.batchCommands?.length > 1
          ? call.command
          : call?.name === "write_stdin"
          ? formatWriteStdinCommand(call.args, this)
          : parentCommand
            ? `${parentCommand} (continued session ${parentSessionId})`
            : this.commandsByCallId.get(payload.call_id) ?? "";
      return {
        type: "item.completed",
        item: {
          id: payload.call_id,
          type: "command_execution",
          status: "completed",
          exit_code: parseFunctionOutputExitCode(payload.output, command),
          command,
          session_id: call?.batchCommands?.length > 1
            ? null
            : call?.args?.session_id ?? parentSessionId ?? sessionId ?? null,
          stdin: call?.name === "write_stdin" ? call.args?.chars ?? "" : null,
          aggregated_output: commandOutputText(payload.output),
          ...(batchCommands ? { batch_commands: batchCommands } : {}),
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

function buildCommandBatch(commands, output) {
  const chunks = codexCommandOutputChunks(output);
  if (!Array.isArray(commands) || commands.length <= 1) {
    return null;
  }
  if (chunks.length === commands.length) {
    return commands.map((command, index) => ({
      command,
      output: chunks[index].output,
      exit_code: Number.isFinite(chunks[index].exit_code) ? chunks[index].exit_code : null,
      wall_time_seconds: Number.isFinite(chunks[index].wall_time_seconds)
        ? chunks[index].wall_time_seconds
        : null,
      session_id: chunks[index].session_id ?? null,
      chunk_id: chunks[index].chunk_id ?? null,
    }));
  }
  const labeledOutputs = codexLabeledCommandOutputs(output);
  if (labeledOutputs.length !== commands.length) {
    return null;
  }
  return commands.map((command, index) => ({
    command,
    output: labeledOutputs[index].output,
    exit_code: labeledOutputs[index].exit_code,
    wall_time_seconds: null,
    session_id: null,
    chunk_id: null,
  }));
}

function parseFunctionCallArgs(payload) {
  if (payload.type === "custom_tool_call") {
    return typeof payload.input === "string" ? { input: payload.input } : {};
  }
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
  if (payload.name === "exec" && typeof args.input === "string") {
    return formatCustomExecCommand(args.input, context);
  }
  return `${payload.name} ${JSON.stringify(args)}`;
}

function isExecCallName(name) {
  return name === "exec_command" || name === "exec";
}

function functionCallParentSessionId(call, context = null) {
  if (call?.name === "wait") {
    return normalizeSessionId(call.args?.cell_id);
  }
  if (call?.name === "write_stdin") {
    return resolveStoredSessionId(call.args, context);
  }
  if (call?.name === "exec" && typeof call.args?.input === "string") {
    return resolveStoredSessionId(extractToolWriteStdinArgs(call.args.input), context);
  }
  return null;
}

function functionCallSessionStoreKey(call) {
  return call?.name === "exec" && typeof call.args?.input === "string"
    ? extractSessionStoreKey(call.args.input)
    : null;
}

function resolveStoredSessionId(args, context) {
  const sessionId = normalizeSessionId(args?.session_id);
  if (sessionId) {
    return sessionId;
  }
  return args?.session_store_key
    ? normalizeSessionId(context?.sessionIdsByStoreKey?.get(args.session_store_key))
    : null;
}

function formatCustomExecCommand(input, context = null) {
  const commands = extractToolCommandBatch(input, context ?? {});
  if (commands.length === 1) {
    return commands[0];
  }
  if (commands.length > 1) {
    return commands.map((command, index) => `command ${index + 1}: ${command}`).join("\n");
  }
  if (/\btools\.apply_patch\s*\(/.test(input)) {
    return "apply_patch";
  }
  if (/\btools\.update_goal\s*\(/.test(input)) {
    return "update_goal";
  }
  return `exec ${input}`;
}

function extractToolWriteStdinArgs(input) {
  return extractToolWriteStdinArgEntries(input)[0]?.args ?? null;
}

function extractToolWriteStdinArgEntries(input) {
  const text = String(input ?? "");
  const entries = [];
  const regex = /\btools\.write_stdin\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    entries.push({
      index: match.index,
      args: {
        session_id: jsObjectPropertyValue(match[1], "session_id"),
        session_store_key: extractSessionLoadKey(match[1]),
        chars: jsObjectPropertyValue(match[1], "chars") ?? "",
      },
    });
  }
  return entries;
}

function extractSessionLoadKey(input) {
  const match = String(input ?? "").match(/\bload\s*\(\s*(["'])([^"']+)\1\s*\)/);
  return match ? match[2] : null;
}

function extractSessionStoreKey(input) {
  const match = String(input ?? "").match(
    /\bstore\s*\(\s*(["'])([^"']+)\1\s*,\s*[^\n)]*?\.session_id\b/,
  );
  return match ? match[2] : null;
}

function jsObjectPropertyValue(text, propertyName) {
  const pattern = new RegExp(
    `(?:\\b${propertyName}\\b|["']${propertyName}["'])\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))`,
  );
  const match = String(text ?? "").match(pattern);
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

function extractToolExecCommands(input) {
  return extractToolExecCommandEntries(input).map((entry) => entry.command);
}

function extractToolExecCommandEntries(input) {
  const commands = extractMappedToolExecCommandEntries(input);
  const text = String(input ?? "");
  const regex = /(?:\bcmd\b|["']cmd["'])\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    commands.push({ index: match.index, command: decodeJsStringLiteral(match[2]) });
  }
  return commands.sort((left, right) => left.index - right.index);
}

function extractMappedToolExecCommandEntries(input) {
  const text = String(input ?? "");
  const entries = [];
  const mapRegex = /\b([A-Za-z_$][\w$]*)\.map\(\s*([A-Za-z_$][\w$]*)\s*=>\s*tools\.exec_command\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\)/g;
  let mapMatch;
  while ((mapMatch = mapRegex.exec(text)) !== null) {
    const [, arrayName, parameterName, properties] = mapMatch;
    const escapedParameter = escapeRegExp(parameterName);
    const usesParameter = new RegExp(
      `(?:\\bcmd\\b|["']cmd["'])\\s*:\\s*${escapedParameter}\\b`,
    ).test(properties) || (
      parameterName === "cmd" && /(?:^|,)\s*cmd\s*(?=,|$)/.test(properties)
    );
    if (!usesParameter) {
      continue;
    }
    const initializer = findJsArrayInitializer(text, arrayName, mapMatch.index);
    if (!initializer) {
      continue;
    }
    const literalRegex = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
    let literalMatch;
    while ((literalMatch = literalRegex.exec(initializer.body)) !== null) {
      entries.push({
        index: initializer.start + literalMatch.index,
        command: decodeJsStringLiteral(literalMatch[2]),
      });
    }
  }
  return entries;
}

function findJsArrayInitializer(text, variableName, beforeIndex) {
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(variableName)}\\s*=\\s*\\[`,
    "g",
  );
  let match;
  let latest = null;
  while ((match = declaration.exec(text)) !== null && match.index < beforeIndex) {
    latest = match;
  }
  if (!latest) {
    return null;
  }
  const open = latest.index + latest[0].lastIndexOf("[");
  let quote = null;
  let escaped = false;
  let depth = 1;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open + 1, index), start: open + 1 };
      }
    }
  }
  return null;
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractToolCommandBatch(input, context = null) {
  return [
    ...extractToolExecCommandEntries(input),
    ...extractToolWriteStdinArgEntries(input).map((entry) => ({
      index: entry.index,
      command: formatWriteStdinCommand(entry.args, context ?? {}),
    })),
  ]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.command);
}

function decodeJsStringLiteral(value) {
  return String(value ?? "")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\([\s\S])/g, (_, escaped) => {
      switch (escaped) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      default: return escaped;
      }
    });
}

function formatWriteStdinCommand(args, context) {
  const sessionId = resolveStoredSessionId(args, context);
  const originalCommand = sessionId ? context.commandsBySessionId?.get(sessionId) : null;
  const stdin = typeof args?.chars === "string" ? args.chars : "";
  const suffix = sessionId
    ? `session ${sessionId}`
    : args?.session_store_key
      ? `stored session ${args.session_store_key}`
      : "unknown session";
  const base = originalCommand
    ? `${originalCommand} (continued ${suffix})`
    : `write_stdin ${suffix}`;
  if (!stdin) {
    return base;
  }
  return `${base} stdin=${JSON.stringify(truncateMiddle(stdin, 160))}`;
}

function parseRunningSessionId(output) {
  const chunkSessionId = codexCommandOutputChunks(output)
    .map((chunk) => chunk.session_id)
    .find((sessionId) => sessionId != null && sessionId !== "");
  if (chunkSessionId != null) {
    return String(chunkSessionId);
  }
  const bareSessionId = bareCommandOutputSessionId(output);
  if (bareSessionId != null) {
    return bareSessionId;
  }
  const match = textValue(output).match(
    /(?:Process running with session ID|Script running with cell ID)\s+([A-Za-z0-9._-]+)/,
  );
  return match ? match[1] : null;
}

function bareCommandOutputSessionId(value) {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const sessionId = bareCommandOutputSessionId(entry);
      if (sessionId != null) {
        return sessionId;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.session_id != null && value.session_id !== "") {
      return String(value.session_id);
    }
    return bareCommandOutputSessionId(value.text ?? value.output ?? null);
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.session_id != null && parsed.session_id !== "") {
      return String(parsed.session_id);
    }
  } catch (_) {
    // Fall through to the transport-envelope form.
  }
  const match = text.match(
    /(?:^|\n)\s*(?:\{\s*"session_id"\s*:\s*"?([A-Za-z0-9._-]+)"?\s*\}|SESSION_ID=([A-Za-z0-9._-]+))\s*$/,
  );
  return match ? match[1] ?? match[2] : null;
}

function normalizeSessionId(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function truncateMiddle(value, maxLength) {
  const text = textValue(value);
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function parseFunctionOutputExitCode(output, command = "") {
  const chunkExitCode = codexCommandOutputChunks(output)
    .map((chunk) => chunk.exit_code)
    .find((exitCode) => Number.isFinite(exitCode));
  if (Number.isFinite(chunkExitCode)) {
    return chunkExitCode;
  }
  const match = textValue(output).match(/Process exited with code (-?\d+)/);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  const explicitExitCode = parseExplicitCommandOutputExitCode(output);
  if (Number.isFinite(explicitExitCode)) {
    return explicitExitCode;
  }
  if (parseRunningSessionId(output) != null) {
    return null;
  }
  return inferDirectMakeExitCode(command, output);
}

function parseExplicitCommandOutputExitCode(output) {
  const match = textValue(output).match(
    /(?:^|\r?\n)\s*EXIT(?:_CODE)?\s*(?:=\s*)?(-?\d+)\s*$/i,
  );
  return match ? Number.parseInt(match[1], 10) : null;
}

function inferDirectMakeExitCode(command, output) {
  const text = String(command ?? "").replace(/\s+\(continued session [^)]+\)\s*$/, "");
  if (!isDirectMakeCommand(text)) {
    return null;
  }
  const outputText = textValue(output);
  if (/^make(?:\[\d+\])?: \*\*\* .*?(?:Error \d+|Terminated|Killed)\s*$/m.test(outputText)) {
    return 2;
  }
  return isTerminalSuccessfulMakeOutput(outputText) ? 0 : null;
}

function isTerminalSuccessfulMakeOutput(output) {
  const lastLine = String(output ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  return (
    /^===== ALL TESTS PASSED SUCCESSFULLY!(?: \(\d+\s*\/\s*\d+\))? =====$/.test(lastLine) ||
    /^make: Leaving directory ['"].+['"]$/.test(lastLine) ||
    /^pa\d+ course\/[^:]+: PASS \(\d+\/\d+\)$/.test(lastLine)
  );
}

function isDirectMakeCommand(command) {
  const text = String(command ?? "").trim();
  if (!/^\s*(?:env\s+)?(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*make(?:\s|$)/.test(text)) {
    return false;
  }
  const scanText = shellOperatorScanTextForExitInference(text);
  return !/[\n;&|<>`]/.test(scanText) && !/\$\(/.test(scanText);
}

function shellOperatorScanTextForExitInference(text) {
  let result = "";
  let quote = null;
  let escaped = false;
  for (const char of String(text ?? "")) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      result += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

function textValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return structuredTextStringValue(value);
  }
  if (Array.isArray(value)) {
    return joinTextParts(value.map((entry) => textValue(entry)));
  }
  if (typeof value === "object") {
    if (isCodexCommandOutputChunk(value)) {
      return value.output;
    }
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.output === "string") {
      return value.output;
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function commandOutputText(value) {
  const chunks = codexCommandOutputChunks(value);
  return chunks.length > 0
    ? joinTextParts(chunks.map((chunk) => chunk.output))
    : stripCommandOutputTransport(textValue(value));
}

function stripCommandOutputTransport(value) {
  return String(value ?? "")
    .replace(/^Script completed\r?\nWall time [^\r\n]*\r?\nOutput:\r?\n/, "")
    .replace(/^Script running with cell ID\s+[^\r\n]+\r?\n?/, "")
    .trim();
}

function structuredTextStringValue(value) {
  const envelope = codexCommandOutputEnvelopeText(value);
  if (envelope != null) {
    return envelope;
  }
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "[" && trimmed[0] !== "{")) {
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
  return isStructuredTextPayload(parsed) || isCodexCommandOutputChunk(parsed)
    ? textValue(parsed)
    : value;
}

function codexCommandOutputEnvelopeText(value) {
  const text = String(value ?? "");
  const match = text.match(/^([\s\S]*?\bOutput:\r?\n)(\{[\s\S]*\})\s*$/);
  if (!match) {
    return null;
  }
  const chunk = parseCodexCommandOutputChunk(match[2]);
  return chunk ? `${match[1]}${chunk.output}` : null;
}

function codexCommandOutputChunks(value) {
  const chunks = [];
  collectCodexCommandOutputChunks(value, chunks);
  if (chunks.length === 0) {
    const labeled = parseLabeledCodexCommandOutputChunks(rawTextValue(value));
    if (labeled.length > 0) {
      chunks.push(...labeled);
    }
  }
  return chunks;
}

function collectCodexCommandOutputChunks(value, chunks) {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    const direct = parseCodexCommandOutputChunk(value);
    if (direct) {
      chunks.push(direct);
      return;
    }
    const labeled = parseLabeledCodexCommandOutputChunks(value);
    if (labeled.length > 0) {
      chunks.push(...labeled);
      return;
    }
    const envelope = String(value).match(/\bOutput:\s*(\{[\s\S]*\})\s*$/);
    const nested = envelope ? parseCodexCommandOutputChunk(envelope[1]) : null;
    if (nested) {
      chunks.push(nested);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCodexCommandOutputChunks(entry, chunks);
    }
    return;
  }
  if (typeof value === "object") {
    if (isCodexCommandOutputChunk(value)) {
      chunks.push(value);
      return;
    }
    if (typeof value.text === "string") {
      collectCodexCommandOutputChunks(value.text, chunks);
    }
    if (typeof value.output === "string") {
      collectCodexCommandOutputChunks(value.output, chunks);
    }
  }
}

function parseLabeledCodexCommandOutputChunks(value) {
  const outputs = parseLabeledCommandOutputs(value);
  const chunks = [];
  for (const output of outputs) {
    const chunk = parseCodexCommandOutputChunk(output.output);
    if (!chunk) {
      return [];
    }
    chunks.push(chunk);
  }
  return chunks;
}

function codexLabeledCommandOutputs(value) {
  return parseLabeledCommandOutputs(rawTextValue(value));
}

function parseLabeledCommandOutputs(value) {
  const text = String(value ?? "");
  const marker = /^---\s+(?:result\s+)?(\d+)(?:\s+(.*?))?\s+---\s*$/gim;
  const matches = [...text.matchAll(marker)];
  if (matches.length <= 1) {
    return [];
  }
  const firstLabel = Number.parseInt(matches[0][1], 10);
  if (firstLabel !== 0 && firstLabel !== 1) {
    return [];
  }
  const outputs = [];
  for (let index = 0; index < matches.length; index += 1) {
    if (Number.parseInt(matches[index][1], 10) !== firstLabel + index) {
      return [];
    }
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const suffixExitCode = String(matches[index][2] ?? "").match(/\bexit=(-?\d+)\b/i);
    outputs.push({
      output: text.slice(start, end).replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
      exit_code: suffixExitCode ? Number.parseInt(suffixExitCode[1], 10) : null,
    });
  }
  return outputs;
}

function rawTextValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return joinTextParts(value.map((entry) => rawTextValue(entry)));
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.output === "string") {
      return value.output;
    }
  }
  return String(value);
}

function parseCodexCommandOutputChunk(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed[0] !== "{") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isCodexCommandOutputChunk(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isCodexCommandOutputChunk(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.output === "string" &&
      (typeof value.chunk_id === "string" ||
        Object.prototype.hasOwnProperty.call(value, "wall_time_seconds") ||
        Object.prototype.hasOwnProperty.call(value, "session_id") ||
        Object.prototype.hasOwnProperty.call(value, "exit_code") ||
        Object.prototype.hasOwnProperty.call(value, "original_token_count")),
  );
}

function isStructuredTextPayload(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isStructuredTextPayload);
  }
  const type = typeof value?.type === "string" ? value.type : "";
  return Boolean(
    value &&
      typeof value === "object" &&
      (type === "input_text" || type === "output_text") &&
      (typeof value.text === "string" || typeof value.output === "string"),
  );
}

function joinTextParts(parts) {
  const filtered = parts.filter((part) => part !== "");
  let result = "";
  for (const part of filtered) {
    if (result && !/[\r\n]$/.test(result) && !/^[\r\n]/.test(part)) {
      result += "\n";
    }
    result += part;
  }
  return result;
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
      event.type,
      item.id ?? "",
      item.type ?? "",
      item.command ?? "",
      item.text ?? "",
      item.status ?? "",
    ].join("|");
  }
  return [
    event?.type ?? "",
    event?.raw?.turn_id ?? "",
    event?.usage?.total_tokens ?? "",
    event?.timeUsedSeconds ?? "",
    timestamp && !event?.raw?.turn_id && !event?.usage?.total_tokens && !event?.timeUsedSeconds
      ? timestamp
      : "",
  ].join("|");
}
