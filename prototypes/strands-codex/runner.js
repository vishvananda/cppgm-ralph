#!/usr/bin/env node

import { createHarness } from "@strands-agents/harness";
import { makeShell } from "@strands-agents/sdk/vended-tools/bash";
import { z } from "zod";
import { createCodexSubscriptionModel } from "./codex-model.js";

// Ralph consumes stdout as JSONL. Keep Strands' diagnostic logging on stderr.
for (const method of ["log", "info", "warn", "debug"]) {
  console[method] = (...args) => console.error(...args);
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function readRequest() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const request = JSON.parse(raw);
  if (!request.prompt || !request.sessionId || !request.sessionDir) {
    throw new Error("Strands runner requires prompt, sessionId, and sessionDir");
  }
  return request;
}

async function main() {
  const request = await readRequest();
  const model = createCodexSubscriptionModel({
    model: request.model,
    effort: request.effort,
    webSearch: request.webSearchEnabled === true,
    codexPath: request.codexPath,
    onUsage: (usage) => emit({ type: "model.usage", usage: {
      input_tokens: usage.input_tokens,
      input_tokens_details: usage.input_tokens_details,
      output_tokens: usage.output_tokens,
      output_tokens_details: usage.output_tokens_details,
    } }),
  });
  const agent = await createHarness({
    model,
    session: { id: request.sessionId, dir: request.sessionDir },
    memory: false,
    skills: false,
    backgroundTasks: false,
    builtinTools: ["read", "write", "edit", "web_fetch"],
    tools: [makeShell({ inputSchema: z.object({
      command: z.string().describe("The shell command to execute."),
      timeout: z.number().positive().default(1800)
        .describe("Timeout in seconds; defaults to 1800 for compiler builds and tests."),
    }) })],
    printer: false,
  });
  emit({ type: "driver.started", sessionId: agent.sessionId ?? request.sessionId });
  for await (const event of agent.stream(request.prompt)) {
    switch (event.type) {
      case "beforeModelCallEvent":
        emit({ type: "model.start" });
        break;
      case "contentBlockEvent":
        emit({ type: "model.content", block: event.contentBlock });
        break;
      case "afterModelCallEvent":
        emit({ type: "model.complete", stopReason: event.stopData?.stopReason });
        break;
      case "beforeToolCallEvent":
        emit({ type: "tool.start", toolUse: event.toolUse });
        break;
      case "toolStreamUpdateEvent":
        emit({ type: "tool.progress", event: event.event });
        break;
      case "afterToolCallEvent":
        emit({ type: "tool.complete", toolUse: event.toolUse,
          result: event.result, error: event.error?.message });
        break;
      case "agentResultEvent":
        emit({ type: "driver.completed", stopReason: event.result?.stopReason,
          usage: event.result?.metrics?.accumulatedUsage ?? null });
        break;
      default:
        break;
    }
  }
}

try {
  await main();
} catch (error) {
  emit({ type: "driver.failed", message: error?.message ?? String(error) });
  process.exitCode = 1;
}
