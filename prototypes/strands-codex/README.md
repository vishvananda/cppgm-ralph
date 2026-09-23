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

The default model is `gpt-6-luna` at `max` reasoning effort; `STRANDS_CODEX_MODEL` and `STRANDS_CODEX_EFFORT` override them. The smoke harness disables memory, sessions, skills, and background tasks so that a test turn has no lasting side effects. Set `STRANDS_CODEX_TOOLS=1` to enable its shell tool.

The Codex CLI refreshes its own login during Codex use. This bridge re-reads the auth file but does not refresh an expired token itself. For an unattended Ralph run, token renewal and Strands-to-Ralph event conversion remain to be implemented. Strands' current Responses adapter also drops reasoning blocks from the history it resends on later model calls; tool calls work in the smoke test, but this deserves attention before a long coding run.
