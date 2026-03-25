#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT_DIR = process.cwd();
const RALPH_DIR = path.join(ROOT_DIR, ".ralph");
const PORT = Number.parseInt(process.env.RALPH_VIZ_PORT ?? "4173", 10);
const HOST = process.env.RALPH_VIZ_HOST ?? "0.0.0.0";
const SPA_DIR = path.dirname(fileURLToPath(import.meta.url));

// Scan .ralph/*/events/*.jsonl
async function listFiles() {
  const results = [];
  try {
    const dirs = await fs.readdir(RALPH_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const eventsDir = path.join(RALPH_DIR, dir.name, "events");
      let files;
      try {
        files = await fs.readdir(eventsDir, { withFileTypes: true });
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        throw e;
      }
      const jsonls = files.filter(f => f.isFile() && f.name.endsWith(".jsonl"));
      for (const f of jsonls) {
        const fileBase = path.basename(f.name, ".jsonl");
        // id encodes both dir name and file for lookup
        const id = `${dir.name}/${fileBase}`;
        // display label: just (name) if single jsonl, else (name uuid4)
        const label = jsonls.length === 1
          ? dir.name
          : `${dir.name} ${fileBase.slice(0, 4)}`;
        results.push({
          id,
          label,
          filePath: path.join(eventsDir, f.name),
        });
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

function safeRunId(id) {
  // id is "dirName/fileBase" — validate both parts
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  if (!parts.every(p => /^[a-zA-Z0-9._-]+$/.test(p))) return null;
  return path.join(RALPH_DIR, parts[0], "events", `${parts[1]}.jsonl`);
}

async function readRunFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed);
      }
    } catch (error) {
      // keep parser resilient to one-off bad lines in a stream log
    }
  }
  return events;
}

function buildSummary(events) {
  const byTurn = new Map();
  const eventTypes = new Map();
  let firstAt = null;
  let lastAt = null;
  for (const event of events) {
    const turn = Number.isInteger(event.turnNumber) ? event.turnNumber : 0;
    byTurn.set(turn, (byTurn.get(turn) ?? 0) + 1);
    eventTypes.set(event.eventType, (eventTypes.get(event.eventType) ?? 0) + 1);
    const recordedAt = event.recordedAt ?? null;
    if (recordedAt && (!firstAt || recordedAt < firstAt)) {
      firstAt = recordedAt;
    }
    if (recordedAt && (!lastAt || recordedAt > lastAt)) {
      lastAt = recordedAt;
    }
  }

  return {
    eventCount: events.length,
    turnCount: byTurn.size,
    maxTurn: byTurn.size > 0 ? Math.max(...Array.from(byTurn.keys())) : null,
    eventTypes: Array.from(eventTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count })),
    firstAt,
    lastAt,
    threadId: events.length > 0 ? events[0].threadId : null,
  };
}

async function currentRunId() {
  // Look for state.json in any .ralph/*/state.json and return the matching run id
  try {
    const dirs = await fs.readdir(RALPH_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const statePath = path.join(RALPH_DIR, dir.name, "state.json");
      try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.threadId === "string") {
          return `${dir.name}/${parsed.threadId}`;
        }
      } catch (_) { /* no state file, skip */ }
    }
  } catch (_) {}
  return null;
}

async function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendStaticFile(res, filePath, contentType, fallback = "Not found") {
  return fs
    .readFile(filePath, "utf8")
    .then((content) => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(fallback);
    });
}

async function requestHandler(req, res) {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/") {
    return sendStaticFile(res, path.join(SPA_DIR, "index.html"), "text/html; charset=utf-8");
  }

  if (pathname === "/app.js") {
    return sendStaticFile(res, path.join(SPA_DIR, "app.js"), "application/javascript; charset=utf-8");
  }

  if (pathname === "/styles.css") {
    return sendStaticFile(res, path.join(SPA_DIR, "styles.css"), "text/css; charset=utf-8");
  }

  if (pathname === "/api/state") {
    const currentThread = await currentRunId();
    return sendJson(res, { currentThread });
  }

  if (pathname === "/api/runs") {
    const fileEntries = await listFiles();
    const runs = [];
    for (const entry of fileEntries) {
      const events = await readRunFile(entry.filePath);
      const summary = buildSummary(events);
      const stat = await fs.stat(entry.filePath);
      runs.push({
        id: entry.id,
        label: entry.label,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        events: events.length,
        summary,
      });
    }
    return sendJson(res, { runs });
  }

  if (pathname.startsWith("/api/run/")) {
    const rawId = decodeURIComponent(pathname.slice("/api/run/".length));
    const filePath = safeRunId(rawId);
    if (!filePath) {
      return sendJson(res, { error: "Invalid run id" }, 400);
    }
    let events = [];
    try {
      events = await readRunFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      throw error;
    }
    if (!events.length) {
      return sendJson(res, { error: "Run not found" }, 404);
    }
    return sendJson(res, { events });
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    await requestHandler(req, res);
  } catch (error) {
    const body = JSON.stringify({ error: error?.message ?? "Server failure" });
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  const runsPath = path.relative(ROOT_DIR, RALPH_DIR);
  console.log(`[ralph-viz] serving from ${runsPath}/*/events`);
  console.log(`[ralph-viz] open http://${HOST}:${PORT}`);
});
