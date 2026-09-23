# Strands with a Codex subscription

This is a small, separate proof that the Strands harness can run on a ChatGPT-authenticated Codex model. It uses Strands' OpenAI Responses model with a custom transport pointed at the Codex backend. The transport reads the existing Codex login file for **each** model request; it never uses `OPENAI_API_KEY` or sends the token to another host.

Requires Node.js 20+ and a Codex CLI login made with ChatGPT (`codex login`). The login must be stored in `$CODEX_HOME/auth.json` or `~/.codex/auth.json`; an OS-keyring-only login is not read by this prototype. You can also set `OPENAI_CODEX_AUTH_FILE` to a specific Codex auth file.

```sh
cd prototypes/strands-codex
npm ci
env -u OPENAI_API_KEY npm run smoke
STRANDS_CODEX_TOOLS=1 env -u OPENAI_API_KEY npm run smoke -- \
  'Use the shell tool to run pwd, then tell me the exact directory.'
```

The default model is `gpt-6-luna` at `max` reasoning effort; `STRANDS_CODEX_MODEL` and `STRANDS_CODEX_EFFORT` override them. The smoke harness disables memory, sessions, skills, and background tasks so that a test turn has no lasting side effects. Set `STRANDS_CODEX_TOOLS=1` to enable its shell tool. Set `STRANDS_CODEX_WEB_SEARCH=1` to enable native Codex web search, or `STRANDS_CODEX_DEBUG_EVENTS=1` to inspect Strands events.

Ralph's `strands` provider runs `runner.js` inside its normal isolation and resource limits. The runner persists Strands sessions, enables the harness's file tools and shell, and streams JSONL events. Ralph groups each model response's reasoning and tool requests for the viewer, records shell output and failures, and sums token usage directly from Codex Responses events. See [`../../examples/v4strands/README.md`](../../examples/v4strands/README.md) for the comparable V4 run.

The bridge re-reads the Codex login for every request. If a request gets HTTP 401, it lets the Codex CLI refresh its own login with a short, ephemeral read-only turn, then retries once. The refresh file must be named `auth.json`; other explicit auth files must be renewed externally. That refresh turn is outside Ralph's token accounting. A revoked login still requires `codex login`. Strands' current Responses adapter drops reasoning blocks from the history it resends on later model calls. The transport restores encrypted reasoning before the matching tool calls in later requests within the same runner process. A resumed Strands session in a new runner process cannot restore those encrypted blocks.
