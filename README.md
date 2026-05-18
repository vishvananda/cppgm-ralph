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

Runs can also be split into named phases. Each phase runs configured checks and
can use its own prompt and goal sidecars, for example
`goals-2026-05-14.implement.md`, `goals-2026-05-14.implement-goal.md`,
`goals-2026-05-14.audit.md`, and `goals-2026-05-14.audit-goal.md`.

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
- active phase and configured check status when the event log contains
  `ralph.phase-status` or a phase-aware Ralph prompt
- event-level drill-down with full JSON payload
- event-type filtering

Scroll debug logging is off by default. Open the viewer with
`?scrollDebug=1` to log scroll diagnostics to `.ralph/viz-scroll-debug.jsonl`;
use `?scrollDebug=0` to disable it again.

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
commits through the requested PA commit, runs the rendered primary check command
such as `make test-report-through-pa8`, writes `<target-run>.config.json`,
copies prompt/goal sidecars if needed, seeds
`.ralph/<target-run>-<model>-<reasoning>/state.json` so Ralph starts on the next
PA, and pushes when a remote is supplied.

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
  Default: `make test`. Backward-compatible shorthand for a single primary
  `tests` check. If the command contains `paX` or `{{testStage}}`, Ralph
  substitutes the active assignment stage, for example
  `make test-report-through-paX` becomes `make test-report-through-pa4`.
- `checks`
  Optional object or array of named checks. Each check has `command`, optional
  `required` (default `true`), optional `primary`, and optional `kind`. If
  omitted, Ralph synthesizes a primary required `tests` check from `testCommand`.
  All required checks in the active phase must pass before the phase can
  complete.
- `phases`
  Optional ordered array of phase definitions. Each phase has `name`, optional
  `checks` (defaults to all checks), optional `promptTemplate` (defaults to the
  phase name), optional `goalTemplate` (defaults to `<phase>-goal`), and optional
  `runWhenChecksPass`. If omitted, Ralph uses one `default` phase that matches
  the old behavior. A phase with `runWhenChecksPass: true` sends Codex one turn
  even when checks already pass, which is useful for audit/cleanup phases.
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
  Legacy alias for the rendered primary check command.
- `{{testCommandTemplate}}`
  The raw primary check command template, such as `make test-report-through-paX`.
- `{{testStage}}`
  The active stage used to render a stage-aware test command.
- `{{stageNumber}}`
  The numeric part of `{{testStage}}`, for example `17`.
- `{{phaseName}}`
  The active phase name.
- `{{primaryCheckCommand}}`
  The rendered primary check command.
- `{{phaseChecks}}`
  Markdown list of checks configured for the current phase.
- `{{checkResults}}`
  Latest status for all phase checks, including log paths for failing checks.
- `{{testStatusSummary}}`
- `{{stageBreakdown}}`
- `{{lastTestLogPath}}`
- `{{failingStage}}`
- `{{passingThrough}}`
- `{{firstFailureLine}}`

Per-loop goals are generated deterministically unless the active phase has a
goal sidecar. When a check command contains `paX` or `{{testStage}}`, Ralph
renders that template with the active stage and uses the rendered checks in the
goal, prompt, and Ralph's own verification run. The goal requires all required
phase checks to pass before returning, plus cohesive progress commits and a
clean worktree. The generated goal also treats the accompanying prompt as
mandatory completion criteria, so requested planning, review, cleanup,
documentation, or retrospective work must be completed rather than deferred once
the check gate passes.

Example two-phase setup:

```json
{
  "testCommand": "make test-report-through-paX",
  "checks": {
    "tests": {
      "command": "make test-report-through-{{testStage}}",
      "primary": true,
      "required": true,
      "kind": "test"
    },
    "fileAudit": {
      "command": "make file-audit-through-{{testStage}}",
      "required": true
    }
  },
  "phases": [
    {
      "name": "implement",
      "promptTemplate": "implement",
      "goalTemplate": "implement-goal",
      "checks": ["tests", "fileAudit"]
    },
    {
      "name": "audit",
      "promptTemplate": "audit",
      "goalTemplate": "audit-goal",
      "runWhenChecksPass": true,
      "checks": ["tests", "fileAudit"]
    }
  ]
}
```

The repo includes two CPPGM audit helpers. `scripts/cppgm_file_audit.pl` is the
current richer audit used by phase runs; copy it into the assignment worktree
when the run config invokes `perl scripts/cppgm_file_audit.pl`:

```json
"fileAudit": {
  "command": "perl scripts/cppgm_file_audit.pl --stage {{testStage}} --paths dev",
  "required": true
}
```

`scripts/cppgm-file-audit.js` is a smaller legacy file-size-only helper that can
also be referenced directly from the Ralph repo:

```json
"fileAudit": {
  "command": "node /home/vishvananda/cppgm-ralph/scripts/cppgm-file-audit.js --stage {{testStage}} --paths dev --max-file-lines 1500",
  "required": true
}
```

## State files

- `.ralph/<run-name>/state.json`
  Saved thread metadata, including the current event log path
- `.ralph/<run-name>/last-test.log`
  Full output from the most recent primary check command
- `.ralph/<run-name>/checks/last-<check>.log`
  Full output from the most recent run of each configured check
- `.ralph/<run-name>/events/<thread-id>.jsonl`
  Append-only stream of Ralph prompt events plus all Codex SDK events for that thread
