// Convert unreal-agent-runner's persisted session items into Ralph's event
// vocabulary. The runner writes these items to stdout as they are committed;
// its on-disk session files wrap the same item under data.Item.
import { randomUUID } from "node:crypto";

export class UnrealAgentEventConverter {
  constructor() {
    this.counterId = randomUUID();
    this.usage = null;
    this.responses = 0;
    this.error = null;
    this.commands = new Map();
  }

  convert(record) {
    if (record?.type === "error") {
      this.error = String(record.message ?? "Unreal Agent failed");
      return [];
    }
    const item = record?.Kind ? record : record?.type === "item" ? record.data?.Item : null;
    if (!item || typeof item !== "object") return [];
    if (item.Kind === "tool_call_status") {
      const callId = String(item.Data?.CallID ?? "");
      const command = this.commands.get(callId);
      const error = item.Data?.Status?.Error;
      if (!command || !error) return [];
      this.commands.delete(callId);
      return [{ type: "item.completed", item: { ...command, status: "failed", output: String(error) } }];
    }
    if (item.Kind !== "model_response") return [];
    const response = item.Data?.Response;
    if (!response || typeof response !== "object") return [];
    this.responses += 1;
    const responseUsage = normalizeUnrealUsage(response.Usage);
    this.usage = addUsage(this.usage, responseUsage);
    const events = [];
    const responseGroup = {
      response_step: this.responses,
      response_command_count: (response.Output ?? []).filter((output) =>
        output?.Type === "tool_call" && output.Data?.Name === "Bash").length,
    };
    for (const [index, output] of (response.Output ?? []).entries()) {
      const id = String(output?.ProviderID || `${item.Sequence}-${index}`);
      if (output?.Type === "message" && output.Data?.Role === "assistant") {
        events.push({ type: "item.completed", item: {
          id, type: "agent_message", text: String(output.Data.Text ?? ""), ...responseGroup,
          ...(output.Data.Phase ? { phase: output.Data.Phase } : {}),
        } });
      } else if (output?.Type === "reasoning") {
        const summary = Array.isArray(output.Data?.Summary)
          ? output.Data.Summary.filter((part) => typeof part === "string" && part.trim()).join("\n")
          : "";
        if (summary) events.push({ type: "item.completed", item: {
          id, type: "reasoning", text: summary, ...responseGroup,
        } });
      } else if (output?.Type === "tool_call") {
        const callId = String(output.Data?.CallID || id);
        const command = toolCommand(output.Data);
        const started = {
          id: callId,
          type: output.Data?.Name === "Bash" ? "command_execution" : "tool_call",
          status: "in_progress",
          command,
          tool_name: String(output.Data?.Name ?? ""),
          ...responseGroup,
        };
        this.commands.set(callId, started);
        events.push({ type: "item.started", item: started });
      }
    }
    if (response.Failure?.Message) {
      this.error = String(response.Failure.Message);
    }
    if (responseUsage) events.push({
      type: "codex.session.token_count",
      source: "unreal-live",
      counter_scope: "turn",
      counter_id: this.counterId,
      usage: { ...this.usage },
    });
    return events;
  }

  completeFromSessionRecord(record) {
    const item = record?.type === "item" ? record.data?.Item : null;
    if (item?.Kind !== "tool_call_status") return [];
    const callId = String(item.Data?.CallID ?? "");
    const command = this.commands.get(callId);
    if (!command) return [];
    const waitingFor = item.Data?.Status?.WaitingFor ?? [];
    const operations = record.data?.Operations ?? [];
    if (!waitingFor.length || !operations.length) return [];
    const relevant = waitingFor.map((id) => operations.find((operation) => operation.ID === id));
    if (relevant.some((operation) => !operation || !["completed", "failed", "canceled"].includes(operation.Status))) {
      return [];
    }
    const results = relevant.map((operation) => operation.State?.Result ?? {});
    const exitCode = results.find((result) => Number.isInteger(result.ExitCode))?.ExitCode;
    const output = relevant.map((operation) => {
      const state = operation.State ?? {};
      const result = state.Result ?? {};
      return [result.Out, result.Err, state.TerminalError].filter(Boolean).join("\n");
    }).filter(Boolean).join("\n");
    const displayOutput = output.length > 20_000
      ? `[earlier command output omitted]\n${output.slice(-20_000)}`
      : output;
    this.commands.delete(callId);
    return [{ type: "item.completed", item: {
      ...command,
      status: relevant.some((operation) => operation.Status !== "completed") ||
        (Number.isInteger(exitCode) && exitCode !== 0) ? "failed" : "completed",
      aggregated_output: displayOutput,
      ...(Number.isInteger(exitCode) ? { exit_code: exitCode } : {}),
    } }];
  }

  completePendingCommands() {
    const events = [...this.commands.values()].map((command) => ({
      type: "item.completed",
      item: { ...command, status: "completed", aggregated_output: "" },
    }));
    this.commands.clear();
    return events;
  }
}

function toolCommand(call) {
  const raw = String(call?.Arguments ?? "");
  if (call?.Name !== "Bash") return raw;
  try {
    const args = JSON.parse(raw);
    return String(args.command ?? args.cmd ?? raw);
  } catch (_) {
    return raw;
  }
}

export function normalizeUnrealUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Math.max(0, Number(usage.InputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage.CachedInputTokens) || 0));
  const output = Math.max(0, Number(usage.OutputTokens) || 0);
  if (!input && !output) return null;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: Math.min(output, Math.max(0, Number(usage.ReasoningTokens) || 0)),
    total_tokens: input + output,
  };
}

export function addUsage(left, right) {
  if (!right) return left;
  if (!left) return right;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
  };
}
