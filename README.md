# Ralph Runner

A small outer loop around the Codex SDK for per-run checkouts under `/work`.

It persists a Codex thread id in `.ralph/<run-name>/state.json`, runs the
configured test command in `/work/<run-name>`, and if the suite still fails it
resumes the same Codex thread with the latest failure output until the suite
passes, the worktree is clean, or the max turn count is hit.

Each Codex thread also gets an append-only JSONL event log in
`.ralph/<run-name>/events/`.
If Ralph resumes the same thread later, it appends Ralph prompt events plus new
streamed Codex events to the same file so each run can be visualized from one
timeline.

Ralph now also enforces a clean repository handoff:

- after each completed phase, Codex should commit its intended changes
- Ralph checks `git status --short`
- if the worktree is dirty, Ralph sends Codex back instead of accepting the handoff

For Codex runs, Ralph can also turn each outer loop into a persisted Codex goal.
Before each Codex turn it starts or resumes the thread through `codex app-server`,
clears any previous loop goal, sets a fresh active goal for the current blocker,
and then resumes that same thread through the Codex SDK.

The first-turn default prompt can be customized with a Markdown sidecar file next
to the config file. For a config named `goals-2026-05-14.config.json`, Ralph
looks for `goals-2026-05-14.default.md`. If it is missing, Ralph falls back to
`templates/default.md`.

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

### Forking a run at a PA boundary

Use `fork-run` to start a new run from the latest assignment repo plus the
completed work from an existing run through a PA boundary:

```bash
npm run fork-run -- \
  --source-run arch-2026-05-15 \
  --target-run arch2-2026-05-15 \
  --through pa8 \
  --remote git@github.com:vishvananda/cppgm-run-arch2.git
```

The script clones `/home/vishvananda/cppgm-assignments`, cherry-picks source run
commits through the requested PA commit, runs the rendered boundary command such
as `make test-report-through-pa8`, writes `<target-run>.config.json`, copies the
default prompt if needed, seeds `.ralph/<target-run>-<model>-<reasoning>/state.json`
so Ralph starts on the next PA, and pushes when a remote is supplied.

If the PA boundary cannot be inferred from commit subjects, pass an exact commit
with `--through-ref <commit>`.

Default config lives in `ralph.config.json`.
Environment variables still override file settings.

The script expects a working Codex CLI environment. In practice that means:

- `codex` is on `PATH`
- an API key is already configured for Codex, such as `OPENAI_API_KEY` or
  `CODEX_API_KEY`

### Example CPPGM run config

The repo includes an example of the current CPPGM assignment-run setup:

- `examples/cppgm-run.config.json`
- `examples/cppgm-run.default.md`

Copy those files next to each other, adjust `workdir`, `baseDir`,
`stateBaseDir`, and `name`, then run:

```bash
RALPH_CONFIG=/path/to/cppgm-run.config.json npm run ralph
```

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
  Default: `make test`. If the command contains `paX`, Ralph substitutes the
  active assignment stage, for example `make test-report-through-paX` becomes
  `make test-report-through-pa4`.
- `maxTurns`
  Default: `1000`
- `webSearchEnabled`
  Default: `false`
- `codexPath`
  Default: `codex`
- `loopGoalsEnabled`
  Default: `true`
- `goalTokenBudget`
  Default: `null`
- `workdir`
  Optional explicit checkout directory. `RALPH_WORKDIR` still takes precedence.
- `useExistingWorkdir`
  Default: `false`. Set to `true` when `workdir` already exists and Ralph should
  use it instead of cloning a fresh checkout.

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
- `RALPH_WEB_SEARCH_ENABLED`
  Override `webSearchEnabled`
- `RALPH_ADDITIONAL_DIRECTORIES`
  Optional colon-delimited list passed through to the thread options
- `RALPH_CODEX_PATH`
  Override the Codex executable used by both app-server goal setup and the SDK
- `RALPH_LOOP_GOALS`
  Set to `0`, `false`, `no`, or `off` to disable per-loop Codex goals
- `RALPH_GOAL_TOKEN_BUDGET`
  Optional positive token budget for each loop goal
- `RALPH_USE_EXISTING_WORKDIR`
  Set to `1`/`true` to use an existing configured workdir on a fresh state

## Default Prompt

The default prompt sidecar is plain Markdown with `{{variable}}` placeholders.
Common variables:

- `{{runName}}`
- `{{turnNumber}}`
- `{{testCommand}}`
  The rendered command Ralph is using for this loop.
- `{{testCommandTemplate}}`
  The raw configured command, such as `make test-report-through-paX`.
- `{{testStage}}`
  The active stage used to render a stage-aware test command.
- `{{testStatusSummary}}`
- `{{stageBreakdown}}`
- `{{lastTestLogPath}}`
- `{{failingStage}}`
- `{{passingThrough}}`
- `{{firstFailureLine}}`

Per-loop goals are generated deterministically from the current failing stage and
are not loaded from Markdown. When `testCommand` contains `paX`, Ralph renders
that template with the blocking stage and uses the same command in the goal,
prompt, and Ralph's own test run. The goal requires a full pass before
returning, plus cohesive progress commits and a clean worktree. The generated
goal also treats the accompanying prompt as mandatory completion criteria, so
requested planning, review, cleanup, documentation, or retrospective work must
be completed rather than deferred once the test gate passes.

## State files

- `.ralph/<run-name>/state.json`
  Saved thread metadata, including the current event log path
- `.ralph/<run-name>/last-test.log`
  Full output from the most recent configured test command
- `.ralph/<run-name>/events/<thread-id>.jsonl`
  Append-only stream of Ralph prompt events plus all Codex SDK events for that thread
