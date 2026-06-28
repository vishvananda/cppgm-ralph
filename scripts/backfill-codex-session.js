#!/usr/bin/env node

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  backfillCodexSessionEvents,
  codexEventKey,
  createCodexSessionTailer,
} from "../codex-session-events.js";

const args = parseArgs(process.argv.slice(2));
if (!args.threadId || !args.eventLogPath || !Number.isInteger(args.turnNumber)) {
  usage();
  process.exit(2);
}

const codexDir = args.codexDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const sinceMs = args.since ? parseTime(args.since) : await inferSinceMs(args.eventLogPath, args.threadId);
if (!Number.isFinite(sinceMs)) {
  throw new Error("Could not infer --since; pass an ISO timestamp or epoch milliseconds.");
}

const seenKeys = await readExistingEventKeys(args.eventLogPath);
let appended = 0;

const appendEvent = async (event, record) => {
  const eventRecord = {
    recordedAt: record?.timestamp ?? new Date().toISOString(),
    threadId: args.threadId,
    turnNumber: args.turnNumber,
    eventType: event.type,
    event,
  };
  await fs.appendFile(args.eventLogPath, `${JSON.stringify(eventRecord)}\n`, "utf8");
  appended += 1;
  if (!args.quiet) {
    console.log(`${eventRecord.recordedAt} ${eventRecord.eventType}`);
  }
};

await backfillCodexSessionEvents({
  codexDir,
  threadId: args.threadId,
  sinceMs,
  seenKeys,
  onEvent: appendEvent,
});

if (!args.watch) {
  if (!args.quiet) {
    console.error(`Backfilled ${appended} event(s).`);
  }
  process.exit(0);
}

if (!args.quiet) {
  console.error(`Backfilled ${appended} event(s); watching for more.`);
}

const tailer = createCodexSessionTailer({
  codexDir,
  threadId: args.threadId,
  sinceMs,
  pollMs: args.pollMs ?? 1000,
  seenKeys,
  onEvent: appendEvent,
  onError: (error) => {
    console.error(`backfill watcher error: ${error.message}`);
  },
});
tailer.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    tailer.stop();
    process.exit(0);
  });
}

setInterval(() => {}, 60_000);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--thread") {
      parsed.threadId = argv[++index];
    } else if (arg === "--event-log") {
      parsed.eventLogPath = argv[++index];
    } else if (arg === "--turn") {
      parsed.turnNumber = Number.parseInt(argv[++index], 10);
    } else if (arg === "--since") {
      parsed.since = argv[++index];
    } else if (arg === "--codex-dir") {
      parsed.codexDir = argv[++index];
    } else if (arg === "--poll-ms") {
      parsed.pollMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--watch") {
      parsed.watch = true;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  console.error(
    "usage: node scripts/backfill-codex-session.js " +
      "--thread <id> --event-log <run.jsonl> --turn <n> [--since <time>] [--watch]",
  );
}

function parseTime(value) {
  if (/^\d+$/.test(String(value))) {
    return Number(value);
  }
  return Date.parse(value);
}

async function inferSinceMs(eventLogPath, threadId) {
  let best = null;
  try {
    for await (const record of readEventLogRecords(eventLogPath)) {
      if (
        record.threadId === threadId &&
        record.eventType === "thread.started" &&
        typeof record.recordedAt === "string"
      ) {
        best = record.recordedAt;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return best ? Date.parse(best) - 1000 : NaN;
}

async function readExistingEventKeys(eventLogPath) {
  const keys = new Set();
  try {
    for await (const record of readEventLogRecords(eventLogPath)) {
      if (record?.event) {
        keys.add(codexEventKey(record.event, record.recordedAt));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return keys;
}

async function* readEventLogRecords(eventLogPath) {
  const lines = readline.createInterface({
    input: createReadStream(eventLogPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch (_) {
      // Ignore malformed log lines.
    }
  }
}
