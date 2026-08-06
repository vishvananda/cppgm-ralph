import fs from "node:fs/promises";
import path from "node:path";

const MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

export function parseCodexUsageLimitResetAt(message) {
  if (typeof message !== "string") {
    return null;
  }
  const match = message.match(
    /\b(?:try again at|resets? at)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i,
  );
  if (!match) {
    return null;
  }
  const month = MONTHS.get(match[1].slice(0, 3).toLowerCase());
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  let hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6] ?? "0", 10);
  if (month == null || hour < 1 || hour > 12 || minute > 59 || second > 59) {
    return null;
  }
  hour %= 12;
  if (match[7].toUpperCase() === "PM") {
    hour += 12;
  }
  const resetAtMs = new Date(year, month, day, hour, minute, second).getTime();
  return Number.isFinite(resetAtMs) ? resetAtMs : null;
}

export function normalizePersistedLimitWait(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const resumeAtMs = Date.parse(value.resumeAt ?? "");
  if (!Number.isFinite(resumeAtMs)) {
    return null;
  }
  return {
    version: 1,
    id: typeof value.id === "string" && value.id ? value.id : null,
    provider: typeof value.provider === "string" ? value.provider : null,
    reason: typeof value.reason === "string" ? value.reason : "usage_limit",
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    turnNumber: Number.isInteger(value.turnNumber) && value.turnNumber > 0
      ? value.turnNumber
      : null,
    attempt: Number.isInteger(value.attempt) && value.attempt > 0 ? value.attempt : 1,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    resumeAt: new Date(resumeAtMs).toISOString(),
    message: typeof value.message === "string" ? value.message : "",
  };
}

export async function readPersistedLimitWait(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizePersistedLimitWait(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writePersistedLimitWait(filePath, value) {
  const normalized = normalizePersistedLimitWait(value);
  if (!normalized) {
    throw new Error("Cannot persist an invalid provider limit wait");
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
  return normalized;
}

export async function clearPersistedLimitWait(filePath, expectedId = null) {
  if (expectedId) {
    const current = await readPersistedLimitWait(filePath);
    if (current?.id && current.id !== expectedId) {
      return false;
    }
  }
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
