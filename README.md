# Ralph Runner

A small outer loop around the Codex SDK for per-run checkouts under `/work`.

It persists a Codex thread id in `.ralph/<run-name>/state.json`, runs `make test` in
`/work/<run-name>`, and if the suite still fails it resumes the same Codex thread
with the latest failure output until the suite passes, the worktree is clean,
or the max turn count is hit.

Each Codex thread also gets an append-only JSONL event log in
`.ralph/<run-name>/events/`.
If Ralph resumes the same thread later, it appends Ralph prompt events plus new
streamed Codex events to the same file so each run can be visualized from one
timeline.

Ralph now also enforces a clean repository handoff:

- after each completed phase, Codex should commit its intended changes
- Ralph checks `git status --short`
- if the worktree is dirty, Ralph sends Codex back instead of accepting the handoff

## Usage

```bash
npm install
npm start
```

### Run visualization (`ralph-viz`)

```bash
npm run ralph-viz
```

Then open:

```text
http://127.0.0.1:4173
```

`ralph-viz` reads `.ralph/<run-name>/events/<thread>.jsonl` and shows:

- a run summary
- turn-level rollup view
- event-level drill-down with full JSON payload
- event-type filtering

Default config lives in [ralph.config.json](/work/runner/ralph.config.json#L1).
Environment variables still override file settings.

The script expects a working Codex CLI environment. In practice that means:

- `codex` is on `PATH`
- an API key is already configured for Codex, such as `OPENAI_API_KEY` or
  `CODEX_API_KEY`

## Config

- `model`
  Default: `gpt-5.3-codex`
- `reasoningEffort`
  Default: `high`
- `name`
  Default: `cppgm`
- `baseDir`
  Default: `/work`
- `stateBaseDir`
  Default: `.ralph`
- `testCommand`
  Default: `make test`
- `maxTurns`
  Default: `1000`

Ralph builds a per-run name as `<name>-<model>-<reasoningEffort>`. That value is
used for the git branch, checkout directory under `baseDir`, and state directory
under `stateBaseDir`.

## Environment overrides

- `RALPH_CONFIG`
  Default: `ralph.config.json`
- `RALPH_BASE_DIR`
  Override `baseDir`
- `RALPH_NAME`
  Override `name`
- `RALPH_WORKDIR`
  Override the full checkout directory directly
- `RALPH_TEST_COMMAND`
  Override `testCommand`
- `RALPH_MAX_TURNS`
  Override `maxTurns`
- `RALPH_STATE_BASE_DIR`
  Override `stateBaseDir`
- `RALPH_STATE_DIR`
  Override the full state directory directly
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

- `.ralph/<run-name>/state.json`
  Saved thread metadata, including the current event log path
- `.ralph/<run-name>/last-test.log`
  Full output from the most recent `make test`
- `.ralph/<run-name>/events/<thread-id>.jsonl`
  Append-only stream of Ralph prompt events plus all Codex SDK events for that thread
