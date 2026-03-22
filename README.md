# Ralph Runner

A small outer loop around the Codex SDK for `/work/cppgm`.

It persists a Codex thread id in `.ralph/state.json`, runs `make test` in
`/work/cppgm`, and if the suite still fails it resumes the same Codex thread
with the latest failure output until the suite passes, the worktree is clean,
or the max turn count is hit.

Ralph now also enforces a clean repository handoff:

- after each completed phase, Codex should commit its intended changes
- Ralph checks `git status --short`
- if the worktree is dirty, Ralph sends Codex back instead of accepting the handoff

## Usage

```bash
npm install
npm start
```

Default config lives in [ralph.config.json](/work/runner/ralph.config.json#L1).
Environment variables still override file settings.

The script expects a working Codex CLI environment. In practice that means:

- `codex` is on `PATH`
- an API key is already configured for Codex, such as `OPENAI_API_KEY` or
  `CODEX_API_KEY`

## Config

- `model`
  Default: `gpt-5.4-mini`
- `reasoningEffort`
  Default: `high`
- `workdir`
  Default: `/work/cppgm`
- `testCommand`
  Default: `make test`
- `maxTurns`
  Default: `1000`

## Environment overrides

- `RALPH_CONFIG`
  Default: `ralph.config.json`
- `RALPH_WORKDIR`
  Override `workdir`
- `RALPH_TEST_COMMAND`
  Override `testCommand`
- `RALPH_MAX_TURNS`
  Override `maxTurns`
- `RALPH_STATE_DIR`
  Override `stateDir`
- `RALPH_THREAD_ID`
  Optional explicit thread id override
- `RALPH_MODEL`
  Override `model`
- `RALPH_REASONING_EFFORT`
  Override `reasoningEffort`: `minimal`, `low`, `medium`, `high`, `xhigh`
- `RALPH_SANDBOX_MODE`
  Override `sandboxMode`
- `RALPH_APPROVAL_POLICY`
  Override `approvalPolicy`
- `RALPH_NETWORK_ACCESS`
  Override `networkAccessEnabled`
- `RALPH_ADDITIONAL_DIRECTORIES`
  Optional colon-delimited list passed through to the thread options

## State files

- `.ralph/state.json`
  Saved thread metadata
- `.ralph/last-test.log`
  Full output from the most recent `make test`
