import { createHarness } from "@strands-agents/harness";
import { createCodexSubscriptionModel } from "./codex-model.js";

const agent = await createHarness({
  model: createCodexSubscriptionModel({
    model: process.env.STRANDS_CODEX_MODEL ?? "gpt-6-luna",
    effort: process.env.STRANDS_CODEX_EFFORT ?? "max",
  }),
  builtinTools: process.env.STRANDS_CODEX_TOOLS === "1" ? ["shell"] : [],
  builtinPlugins: [],
  memory: false,
  session: false,
  skills: false,
  contextManager: false,
  backgroundTasks: false,
  printer: false,
});

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: Strands Codex subscription works.";
for await (const event of agent.stream(prompt)) {
  if (event.type === "contentBlockEvent" && event.contentBlock?.type === "textBlock") {
    process.stdout.write(event.contentBlock.text);
  } else if (event.type === "beforeToolCallEvent") {
    process.stderr.write(`${JSON.stringify({ tool: event.toolUse?.name, input: event.toolUse?.input })}\n`);
  } else if (event.type === "afterToolCallEvent") {
    process.stderr.write(`${JSON.stringify({ tool: event.toolUse?.name, status: event.result?.status })}\n`);
  } else if (event.type === "agentResultEvent") {
    process.stdout.write("\n");
    process.stderr.write(`${JSON.stringify({
      stopReason: event.result?.stopReason,
      usage: event.result?.metrics?.accumulatedUsage ?? null,
    })}\n`);
  }
}
