// Convert the Strands harness runner's JSONL records to Ralph's event format.
// Buffer each model response until it completes so reasoning and commands share
// the same response_step and response_command_count in the viewer.
export class StrandsAgentEventConverter {
  constructor() {
    this.step = 0;
    this.blocks = [];
    this.commands = new Map();
    this.rawUsage = null;
    this.usage = null;
    this.completed = false;
    this.error = null;
  }

  convert(record) {
    switch (record?.type) {
      case "driver.started":
        return [];
      case "model.start":
        this.step += 1;
        this.blocks = [];
        return [];
      case "model.content":
        this.blocks.push(record.block);
        return [];
      case "model.usage":
        this.rawUsage = addUsage(this.rawUsage, normalizeRawUsage(record.usage));
        return [];
      case "model.complete":
        return this.completeModel();
      case "tool.start":
        return this.startTool(record.toolUse);
      case "tool.progress":
        return [];
      case "tool.complete":
        return this.completeTool(record);
      case "driver.completed":
        this.completed = true;
        this.usage = this.rawUsage ?? normalizeSdkUsage(record.usage);
        return [];
      case "driver.failed":
        this.error = String(record.message ?? "Strands harness failed");
        return this.completePending(this.error);
      default:
        return [];
    }
  }

  completeModel() {
    const count = this.blocks.filter((block) => block?.toolUse?.name === "shell").length;
    const group = { response_step: this.step, response_command_count: count };
    const events = [];
    for (const [index, block] of this.blocks.entries()) {
      const id = `strands-${this.step}-${index}`;
      const reasoning = block?.reasoning?.text;
      if (reasoning) {
        events.push({ type: "item.completed", item: {
          id, type: "reasoning", text: reasoning, ...group,
        } });
      } else if (typeof block?.text === "string" && block.text) {
        events.push({ type: "item.completed", item: {
          id, type: "agent_message", text: block.text, ...group,
        } });
      } else if (block?.toolUse) {
        events.push(...this.startTool(block.toolUse, group));
      }
    }
    this.blocks = [];
    return events;
  }

  startTool(toolUse, group = null) {
    const id = String(toolUse?.toolUseId ?? "");
    if (!id || this.commands.has(id)) return [];
    const name = String(toolUse.name ?? "");
    const item = {
      id,
      type: name === "shell" ? "command_execution" : "tool_call",
      status: "in_progress",
      command: name === "shell" ? String(toolUse.input?.command ?? "") : JSON.stringify(toolUse.input ?? {}),
      tool_name: name,
      ...(group ?? { response_step: this.step, response_command_count: name === "shell" ? 1 : 0 }),
    };
    this.commands.set(id, item);
    return [{ type: "item.started", item }];
  }

  completeTool(record) {
    const toolUse = record.toolUse;
    const id = String(toolUse?.toolUseId ?? "");
    const started = this.commands.get(id);
    const events = started ? [] : this.startTool(toolUse);
    const item = started ?? this.commands.get(id);
    if (!item) return events;
    this.commands.delete(id);
    const result = record.result?.toolResult ?? record.result;
    const output = toolOutput(result);
    const exitCode = toolExitCode(result);
    const failed = Boolean(record.error || result?.status === "error" || exitCode != null && exitCode !== 0);
    events.push({ type: "item.completed", item: {
      ...item,
      status: failed ? "failed" : "completed",
      ...(item.type === "command_execution"
        ? { aggregated_output: [output, record.error].filter(Boolean).join("\n"),
          ...(exitCode != null ? { exit_code: exitCode } : {}) }
        : { output: [output, record.error].filter(Boolean).join("\n") }),
    } });
    return events;
  }

  completePending(message) {
    const events = [...this.commands.values()].map((item) => ({
      type: "item.completed",
      item: { ...item, status: "failed", aggregated_output: message, output: message },
    }));
    this.commands.clear();
    return events;
  }
}

function toolOutput(result) {
  return (result?.content ?? []).map((part) => {
    if (typeof part?.text === "string") return part.text;
    if (part?.json && typeof part.json === "object") {
      if (typeof part.json.output === "string" || typeof part.json.error === "string") {
        return [part.json.output, part.json.error].filter(Boolean).join("\n");
      }
      return JSON.stringify(part.json);
    }
    return "";
  }).filter(Boolean).join("\n");
}

function toolExitCode(result) {
  for (const part of result?.content ?? []) {
    const code = part?.json?.exit_code;
    if (Number.isInteger(code)) return code;
  }
  return null;
}

function normalizeRawUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Math.max(0, Number(usage.input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  return {
    input_tokens: input,
    cached_input_tokens: Math.min(input, Math.max(0, Number(usage.input_tokens_details?.cached_tokens) || 0)),
    output_tokens: output,
    reasoning_output_tokens: Math.min(output, Math.max(0, Number(usage.output_tokens_details?.reasoning_tokens) || 0)),
    total_tokens: input + output,
  };
}

function normalizeSdkUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  return {
    input_tokens: input,
    cached_input_tokens: Math.min(input, Math.max(0, Number(usage.cacheReadInputTokens) || 0)),
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function addUsage(left, right) {
  if (!right) return left;
  if (!left) return right;
  return Object.fromEntries(Object.keys(right).map((key) => [key, (left[key] ?? 0) + right[key]]));
}
