#!/usr/bin/env python3
"""Run one Ralph turn through the Google Antigravity SDK.

The Node runner owns prompts, checks, persistence, and event logs. This bridge
keeps the provider boundary narrow by translating one stdin prompt into
Codex-shaped JSONL events on stdout.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import traceback
from typing import Any


def main() -> int:
  config = load_config()
  prompt = sys.stdin.read()
  try:
    if config.get("mockResponse") is not None:
      run_mock_turn(config, prompt)
      return 0
    asyncio.run(run_antigravity_turn(config, prompt))
    return 0
  except Exception as exc:  # pylint: disable=broad-exception-caught
    emit("turn.failed", error={"message": str(exc), "traceback": traceback.format_exc()})
    return 0


def load_config() -> dict[str, Any]:
  raw = os.environ.get("RALPH_ANTIGRAVITY_CONFIG_JSON", "{}")
  try:
    config = json.loads(raw)
  except json.JSONDecodeError as exc:
    raise RuntimeError("RALPH_ANTIGRAVITY_CONFIG_JSON is not valid JSON") from exc
  return config if isinstance(config, dict) else {}


def emit(event_type: str, **payload: Any) -> None:
  record = {"type": event_type, **payload}
  print(json.dumps(to_jsonable(record), separators=(",", ":")), flush=True)


def run_mock_turn(config: dict[str, Any], prompt: str) -> None:
  thread_id = get_thread_id(config)
  emit("thread.started", thread_id=thread_id)
  emit("turn.started", thread_id=thread_id)
  goal = read_goal(config)
  if goal:
    append_progress(config, {
        "status": "mock",
        "summary": "Mock Antigravity turn read the active Ralph goal.",
        "goalId": goal.get("id"),
    })
  response = str(config.get("mockResponse") or "Mock Antigravity response.")
  emit("item.completed", item={
      "id": "mock-agent-message",
      "type": "agent_message",
      "text": response,
  })
  emit("turn.completed", thread_id=thread_id, usage={
      "input_tokens": count_words(prompt),
      "cached_input_tokens": 0,
      "output_tokens": count_words(response),
      "reasoning_output_tokens": 0,
      "total_tokens": count_words(prompt) + count_words(response),
  })


async def run_antigravity_turn(config: dict[str, Any], prompt: str) -> None:
  sdk_path = config.get("sdkPath")
  if sdk_path:
    sys.path.insert(0, str(sdk_path))

  try:
    import pydantic
    from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    from google.antigravity import types
    from google.antigravity.hooks import hooks, policy
  except Exception as exc:  # pylint: disable=broad-exception-caught
    raise RuntimeError(
        "Failed to import google-antigravity. Install `google-antigravity` "
        "and its dependencies in the configured Python environment. "
        "RALPH_ANTIGRAVITY_SDK_PATH may point at an unpacked SDK wheel, but "
        "the configured Python still needs the SDK dependencies installed."
    ) from exc

  class RalphTurnReport(pydantic.BaseModel):
    goal_status: str = "in_progress"
    summary: str = ""
    checks_run: list[str] = pydantic.Field(default_factory=list)
    remaining_failures: list[str] = pydantic.Field(default_factory=list)
    files_changed: list[str] = pydantic.Field(default_factory=list)
    commit_status: str = ""
    handoff_summary: str = ""

  reported_goal_complete = False
  try:
    request_delay_seconds = max(0.0, float(config.get("requestDelayMs") or 0) / 1000.0)
  except (TypeError, ValueError):
    request_delay_seconds = 0.0

  async def throttle_model_request() -> None:
    if request_delay_seconds <= 0:
      return
    await asyncio.sleep(request_delay_seconds)

  def get_ralph_goal() -> dict[str, Any]:
    """Returns the active Ralph loop goal for this turn."""
    return read_goal(config) or {"status": "missing"}

  def report_ralph_progress(
      summary: str,
      status: str = "in_progress",
      details: str = "",
  ) -> dict[str, Any]:
    """Records notable progress toward Ralph's active goal."""
    record = {
        "status": status,
        "summary": summary,
        "details": details,
    }
    append_progress(config, record)
    return {"recorded": True, **record}

  def complete_ralph_goal(
      summary: str,
      checks_run: list[str] | None = None,
      remaining_failures: list[str] | None = None,
  ) -> dict[str, Any]:
    """Reports that the goal appears complete; Ralph will verify externally."""
    nonlocal reported_goal_complete
    reported_goal_complete = True
    record = {
        "status": "reported_complete",
        "summary": summary,
        "checks_run": checks_run or [],
        "remaining_failures": remaining_failures or [],
    }
    append_progress(config, record)
    return {
        "recorded": True,
        "message": "Ralph recorded this completion report and will verify with configured checks.",
        **record,
    }

  @hooks.post_tool_call
  async def emit_post_tool_call(data: Any) -> None:
    name = enum_value(getattr(data, "name", "tool"))
    error = getattr(data, "error", None)
    emit("item.completed", item={
        "id": getattr(data, "id", None) or f"tool-{name}",
        "type": "mcp_tool_call",
        "server": "antigravity",
        "tool": name,
        "status": "failed" if error else "completed",
        "result": to_jsonable(getattr(data, "result", None)),
        **({"error": {"message": stringify(error)}} if error else {}),
    })
    await throttle_model_request()

  @hooks.on_interaction
  async def skip_interaction(data: Any) -> Any:
    responses = []
    for question in getattr(data, "questions", []) or []:
      options = getattr(question, "options", []) or []
      if options:
        responses.append(types.QuestionResponse(selected_option_ids=[options[0].id]))
      else:
        responses.append(types.QuestionResponse(skipped=True))
    return types.QuestionHookResult(responses=responses)

  requested_thread_id = get_requested_thread_id(config)
  current_thread_id = requested_thread_id
  started_emitted = False

  def emit_start(candidate_thread_id: str | None = None) -> str:
    nonlocal current_thread_id, started_emitted
    if candidate_thread_id:
      current_thread_id = candidate_thread_id
    if not current_thread_id:
      current_thread_id = "antigravity-thread"
    if not started_emitted:
      emit("thread.started", thread_id=current_thread_id)
      emit("turn.started", thread_id=current_thread_id)
      started_emitted = True
    return current_thread_id

  if requested_thread_id:
    emit_start(requested_thread_id)

  save_dir = absolute_dir(config.get("saveDir"))
  app_data_dir = absolute_dir(config.get("appDataDir"))
  response_schema = RalphTurnReport if config.get("structuredFinish", True) else None
  enabled_builtin_tools = [
      types.BuiltinTools.LIST_DIR,
      types.BuiltinTools.SEARCH_DIR,
      types.BuiltinTools.FIND_FILE,
      types.BuiltinTools.VIEW_FILE,
      types.BuiltinTools.CREATE_FILE,
      types.BuiltinTools.EDIT_FILE,
      types.BuiltinTools.RUN_COMMAND,
  ]
  if response_schema is not None:
    enabled_builtin_tools.append(types.BuiltinTools.FINISH)
  policy_kwargs = {"policies": [policy.allow_all()]} if config.get("allowAll", True) else {}
  agent_config = LocalAgentConfig(
      system_instructions=build_system_instructions(),
      tools=[get_ralph_goal, report_ralph_progress, complete_ralph_goal],
      hooks=[emit_post_tool_call, skip_interaction],
      capabilities=CapabilitiesConfig(
          enable_subagents=False,
          enabled_tools=enabled_builtin_tools,
      ),
      workspaces=[str(Path(p).resolve()) for p in config.get("workspaces", []) if p],
      conversation_id=requested_thread_id or None,
      save_dir=save_dir,
      app_data_dir=app_data_dir,
      skills_paths=[str(Path(p).resolve()) for p in config.get("skillsPaths", []) if p],
      response_schema=response_schema,
      **policy_kwargs,
      **({"model": config["model"]} if config.get("model") else {}),
  )

  latest_usage = None
  final_text = ""
  final_emitted = False
  last_step_error = ""
  async with Agent(agent_config) as agent:
    await throttle_model_request()
    await agent.conversation.send(prompt)
    async for step in agent.conversation.receive_steps():
      emit_start(agent.conversation_id or getattr(step, "cascade_id", "") or requested_thread_id)
      usage = getattr(step, "usage_metadata", None)
      if usage is not None:
        latest_usage = usage
      if getattr(step, "error", ""):
        last_step_error = str(getattr(step, "error", ""))
      event_item = step_to_item(step)
      if event_item:
        emit("item.completed", item=event_item)
        if event_item.get("type") == "agent_message":
          final_text = event_item.get("text", "")
          final_emitted = True
      if getattr(step, "is_complete_response", False):
        structured = getattr(step, "structured_output", None)
        final_text = getattr(step, "content", "") or (
            json.dumps(to_jsonable(structured), indent=2) if structured is not None else ""
        )

    if last_step_error and not reported_goal_complete:
      emit("turn.failed", error={"message": last_step_error})
      return

    if not final_emitted and final_text:
      emit_start(agent.conversation_id or requested_thread_id)
      emit("item.completed", item={
          "id": "antigravity-final-message",
          "type": "agent_message",
          "text": final_text,
      })
    total_usage = getattr(agent.conversation, "total_usage", None)
    emit("turn.completed", thread_id=emit_start(agent.conversation_id or requested_thread_id), usage=usage_to_codex_shape(latest_usage or total_usage))


def step_to_item(step: Any) -> dict[str, Any] | None:
  step_id = getattr(step, "id", None) or f"antigravity-step-{getattr(step, 'step_index', 0)}"
  step_type = enum_value(getattr(step, "type", "UNKNOWN"))
  content = getattr(step, "content", "") or ""
  thinking = getattr(step, "thinking", "") or ""
  structured = getattr(step, "structured_output", None)
  tool_calls = getattr(step, "tool_calls", []) or []
  error = getattr(step, "error", "") or ""

  if thinking:
    return {
        "id": f"{step_id}-thinking",
        "type": "reasoning",
        "text": thinking,
    }
  if getattr(step, "is_complete_response", False):
    return {
        "id": step_id,
        "type": "agent_message",
        "text": content or (json.dumps(to_jsonable(structured), indent=2) if structured is not None else ""),
    }
  if tool_calls:
    return None
  if step_type == "COMPACTION":
    return {
        "id": step_id,
        "type": "reasoning",
        "text": content or "Antigravity compacted conversation context.",
    }
  if error:
    return {
        "id": step_id,
        "type": "error",
        "message": error,
    }
  return None


def build_system_instructions() -> str:
  return (
      "Ralph is the outer automation loop. Ralph owns the active goal, runs the "
      "verification commands, checks for regressions, and decides whether the "
      "run may advance. Treat the Ralph Portable Goal block in each user prompt "
      "as mandatory. Use get_ralph_goal to reread it, report_ralph_progress for "
      "important intermediate state, and complete_ralph_goal only when the goal "
      "appears ready for Ralph's external verification. Do not ask the user for "
      "routine permission; make progress autonomously within the configured "
      "workspace and leave intended work committed when Ralph asks for a clean "
      "handoff."
  )


def get_thread_id(config: dict[str, Any]) -> str:
  return get_requested_thread_id(config) or "antigravity-thread"


def get_requested_thread_id(config: dict[str, Any]) -> str:
  return str(config.get("conversationId") or "")


def absolute_dir(value: Any) -> str | None:
  if not value:
    return None
  directory = Path(str(value)).expanduser().resolve()
  directory.mkdir(parents=True, exist_ok=True)
  return str(directory)


def read_goal(config: dict[str, Any]) -> dict[str, Any] | None:
  path = config.get("goalPath")
  if not path:
    return None
  try:
    with open(path, "r", encoding="utf-8") as handle:
      data = json.load(handle)
  except FileNotFoundError:
    return None
  return data if isinstance(data, dict) else None


def append_progress(config: dict[str, Any], record: dict[str, Any]) -> None:
  path = config.get("goalProgressPath")
  if not path:
    return
  target = Path(str(path))
  target.parent.mkdir(parents=True, exist_ok=True)
  payload = {
      "threadId": get_thread_id(config),
      **record,
  }
  with open(target, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(to_jsonable(payload), separators=(",", ":")) + "\n")


def usage_to_codex_shape(usage: Any) -> dict[str, int]:
  if usage is None:
    return {
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "output_tokens": 0,
        "reasoning_output_tokens": 0,
        "total_tokens": 0,
    }
  data = to_jsonable(usage)
  input_tokens = int(data.get("prompt_token_count") or data.get("promptTokenCount") or 0)
  cached_tokens = int(data.get("cached_content_token_count") or data.get("cachedContentTokenCount") or 0)
  output_tokens = int(data.get("candidates_token_count") or data.get("candidatesTokenCount") or 0)
  reasoning_tokens = int(data.get("thoughts_token_count") or data.get("thoughtsTokenCount") or 0)
  total_tokens = int(data.get("total_token_count") or data.get("totalTokenCount") or input_tokens + output_tokens + reasoning_tokens)
  return {
      "input_tokens": input_tokens,
      "cached_input_tokens": cached_tokens,
      "output_tokens": output_tokens,
      "reasoning_output_tokens": reasoning_tokens,
      "total_tokens": total_tokens,
  }


def to_jsonable(value: Any) -> Any:
  if value is None or isinstance(value, (str, int, float, bool)):
    return value
  if isinstance(value, dict):
    return {str(k): to_jsonable(v) for k, v in value.items()}
  if isinstance(value, (list, tuple, set)):
    return [to_jsonable(v) for v in value]
  if hasattr(value, "model_dump"):
    return to_jsonable(value.model_dump(mode="json"))
  if hasattr(value, "dict"):
    return to_jsonable(value.dict())
  return stringify(value)


def enum_value(value: Any) -> str:
  return str(getattr(value, "value", value))


def stringify(value: Any) -> str:
  return "" if value is None else str(value)


def count_words(value: str) -> int:
  return len(str(value).split())


if __name__ == "__main__":
  raise SystemExit(main())
