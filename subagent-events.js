import {
  collectClaudeSubagentEvents,
  DEFAULT_CLAUDE_PROJECTS_DIR,
} from "./claude-subagent-events.js";
import {
  collectCodexSubagentEvents,
  DEFAULT_CODEX_DIR,
} from "./codex-subagent-events.js";

export { DEFAULT_CLAUDE_PROJECTS_DIR, DEFAULT_CODEX_DIR };

export async function collectSubagentEvents(events, options = {}) {
  const [claude, codex] = await Promise.all([
    collectClaudeSubagentEvents(events, options),
    collectCodexSubagentEvents(events, options),
  ]);
  return [...claude, ...codex].sort((left, right) =>
    String(left.recordedAt ?? "").localeCompare(String(right.recordedAt ?? "")));
}
