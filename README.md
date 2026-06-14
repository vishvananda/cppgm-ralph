# Ralph Runner

A small outer loop around coding agents for per-run checkouts under `/work`.

It persists a provider thread id in `.ralph/<run-name>/state.json`, runs the
configured test command in `/work/<run-name>`, and if the suite still fails it
resumes the same thread with the latest failure output until the suite
passes, the worktree is clean, or the max turn count is hit.

Each thread also gets an append-only JSONL event log in
`.ralph/<run-name>/events/`.
If Ralph resumes the same thread later, it appends Ralph prompt events plus new
streamed provider events to the same file so each run can be visualized from one
timeline.

Ralph now also enforces a clean repository handoff:

- after each completed phase, the agent should commit its intended changes
- Ralph checks `git status --short`
- if the worktree is dirty, Ralph sends the agent back instead of accepting the handoff

For Codex runs, Ralph can also turn each outer loop into a persisted Codex goal.
When a real Codex thread id already exists, Ralph uses `codex app-server` to
clear any previous loop goal and set a fresh active goal for the current
blocker before resuming that thread. For a brand-new `codex exec` thread,
Ralph carries the same goal in the prompt until the CLI creates the local
rollout-backed thread id.

For Antigravity runs, Ralph uses portable goals instead. It writes the same loop
objective to `.ralph/<run-name>/current-goal.json`, appends it to the turn
prompt, exposes Ralph-owned goal tools through the Antigravity SDK bridge, and
records `ralph.goal` events in the same visualization stream. Ralph still
advances only after its own configured checks pass and the worktree is clean.

For Claude runs (`"provider": "claude"`, default model `claude-fable-5`), Ralph
drives the Claude Code CLI in skip-permissions mode the same way it drives the
Codex CLI: `claude --print --output-format stream-json --dangerously-skip-permissions`,
resuming the persisted session id on later turns. The stream-json events are
translated into the same Codex-shaped event log (`item.completed`,
`turn.completed` with normalized token usage plus the exact `total_cost_usd`).
Goal mode uses Claude Code's built-in `/goal` feature: each turn Ralph clears
any leftover goal, sends the turn as `/goal <objective>`, and delivers the
detailed turn instructions as appended system instructions, so Claude's graded
stop hook keeps the agent working until the loop goal is judged complete. The
`/goal` condition is limited to 4000 characters and the grader judges only the
objective, so goal sidecar templates should be self-contained (include the
required exit criteria); oversized objectives are tail-truncated as a last
resort. If Claude reports a usage/session limit mid-turn, Ralph waits for the
limit window to reset (using the reset time from the stream when available, 15
minutes otherwise) and resumes the same session so the turn continues with its
context intact. After an interrupted run, `node ralph.js --continue` resumes
the most recent provider thread for the next turn only (subsequent turns
follow `freshThreadPerTurn` again); for Claude, if that session's loop goal is
still active, Ralph skips re-sending the goal and instead sends a short
continuation nudge with refreshed turn instructions in the appended system
prompt. The CLI path can be overridden with `claudePath` / `RALPH_CLAUDE_PATH`.

To stop a run cleanly at the next turn boundary, create a `stop-after-turn`
file in the run's state directory (e.g.
`touch .ralph/<run-name>/stop-after-turn`). Ralph consumes the file and exits
before starting the next provider turn; restarting later resumes from the
saved state.

The first-turn default prompt can be customized with a Markdown sidecar file next
to the config file. For a config named `goals-2026-05-14.config.json`, Ralph
looks for `goals-2026-05-14.default.md`. If it is missing, Ralph falls back to
`templates/default.md`.

Runs can also be split into named phases. Each phase runs configured checks and
can use its own prompt and goal sidecars, for example
`goals-2026-05-14.implement.md`, `goals-2026-05-14.implement-goal.md`,
`goals-2026-05-14.audit.md`, and `goals-2026-05-14.audit-goal.md`.

For highly constrained models, Ralph can run in `slice` driver mode. Slice mode
keeps the normal phase/check system but adds a current test subset alongside the
current PA stage. Prompt and check templates can use `{{testSubset}}`,
`{{testSubsetShell}}`, `{{testSubsetOrFull}}`, `{{testSubsetOrFullShell}}`,
`{{testSubsetStage}}`, `{{testSubsetStageShell}}`, `{{testSubsetLabel}}`,
`{{targetLabel}}`, and `{{targetLabelShell}}`. After the final phase for one
subset passes, Ralph advances to the next configured subset for that stage
before moving to the next PA.

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

The default `codex` provider expects a working Codex CLI environment. In practice
that means:

- `codex` is on `PATH`
- an API key is already configured for Codex, such as `OPENAI_API_KEY` or
  `CODEX_API_KEY`

### Antigravity provider

Set `provider` to `antigravity` to run turns through the Google Antigravity SDK
bridge in `scripts/antigravity-turn.py`:

```json
{
  "provider": "antigravity",
  "model": "gemini-3.5-flash",
  "antigravityPython": "/path/to/python",
  "antigravitySdkPath": "/home/vishvananda/antigravity-research/pypi/wheel-unpacked",
  "antigravityHarnessPath": "/home/vishvananda/antigravity-research/pypi/wheel-unpacked/google/antigravity/bin/localharness",
  "antigravityRequestDelayMs": 65000
}
```

The configured Python environment must be able to import `google-antigravity`
and its dependencies, and `GEMINI_API_KEY` must be set for real SDK runs. The
bridge accepts `RALPH_ANTIGRAVITY_MOCK_RESPONSE=...` for local plumbing tests
without SDK dependencies or auth.

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
  Default: `gpt-5.3-codex` for `codex`, `gemini-3.5-flash` for
  `antigravity`.
- `provider`
  Default: `codex`. Supported values: `codex`, `antigravity`.
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
  `required` (default `true`), optional `primary`, optional `kind`, optional
  `targetStage`, optional `onlyStages`, and optional `excludeStages`. If omitted,
  Ralph synthesizes a primary required `tests` check from `testCommand`. All
  required checks in the active phase must pass before the phase can complete.
  `targetStage` binds a non-template command to a PA for state, prompts, and
  visualization. `onlyStages` and `excludeStages` make a check apply only to
  selected PA stages.
- `phases`
  Optional ordered array of phase definitions. Each phase has `name`, optional
  `checks` (defaults to all checks), optional `promptTemplate` (defaults to the
  phase name), optional `goalTemplate` (defaults to `<phase>-goal`), optional
  `promptTemplates` and `goalTemplates` maps keyed by PA stage, and optional
  `runWhenChecksPass`. If omitted, Ralph uses one `default` phase that matches
  the old behavior. A phase with `runWhenChecksPass: true` sends the agent one
  turn even when checks already pass, which is useful for audit/cleanup phases.
  In slice mode, `runOnLastSubsetOnly: true` skips a phase until the final
  subset for the active PA.
- `driverMode`
  Default: `standard`. Set to `slice` for small-model runs that should work one
  configured test subset at a time.
- `testSubsets`
  Optional array or object used only by `slice` mode. An array applies to every
  stage. An object can define `default` and/or per-stage arrays such as
  `"pa22": ["tests/general/100-*.t", "tests/spec/100-*.t"]`.
- `autoTestSubsets`, `autoTestSubsetThreshold`, `autoTestSubsetMaxFiles`
  Optional slice-mode auto-discovery. When enabled, stages with more than the
  threshold number of `.t` files are split into `tests/<prefix>-*.t` or
  `tests/<dir>/<prefix>-*.t` groups; symlinked course tests are kept as one
  `course/paN/*.t` slice. Set `autoTestSubsetMaxFiles` to split small groups
  into exact-file slices, such as `tests/200-basic-floating.t`, while leaving
  larger groups as prefix globs.
- `extraStages`
  Optional list of PA stages to include even if the assignment Makefile marks
  them experimental. This is useful for PA39-style runs where the normal
  `test-report-through-paX` ladder stops at the last non-experimental PA and
  the final stage uses custom checks.
- `initialStage`, `initialSubset`
  Optional starting target for a new run, useful for slice experiments that
  should begin at a later PA such as `pa22`.
- `maxTurns`
  Default: `1000`
- `webSearchEnabled`
  Default: `false`
- `codexPath`
  Default: `codex`
- `antigravityPython`
  Default: `python3`
- `antigravityScriptPath`
  Default: `scripts/antigravity-turn.py`
- `antigravitySdkPath`
  Optional path prepended to `PYTHONPATH`, useful for an unpacked
  `google-antigravity` wheel.
- `antigravityHarnessPath`
  Optional path passed as `ANTIGRAVITY_HARNESS_PATH`.
- `antigravitySaveDir`
  Default: `<stateDir>/antigravity-save`
- `antigravityAppDataDir`
  Default: `<stateDir>/antigravity-app-data`
- `antigravitySkillsPaths`
  Optional array or colon-delimited list of Antigravity skills paths.
- `antigravityAllowAll`
  Default: `true`. Allows autonomous Antigravity tool use, including shell
  commands, inside the configured workspaces.
- `antigravityStructuredFinish`
  Default: `true`. Enables a structured Ralph turn report finish schema.
- `antigravityRequestDelayMs`
  Default: `0`. Sleeps before the initial Antigravity request and after each
  Antigravity tool call, useful for conservative free-tier quota tests.
- `loopGoalsEnabled`
  Default: `true`. Uses native Codex goals for `codex` and portable Ralph goals
  for `antigravity`.
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
- `RALPH_PROVIDER`
  Override `provider`
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
- `RALPH_ANTIGRAVITY_PYTHON`
  Override `antigravityPython`
- `RALPH_ANTIGRAVITY_SCRIPT_PATH`
  Override `antigravityScriptPath`
- `RALPH_ANTIGRAVITY_SDK_PATH`
  Override `antigravitySdkPath`
- `RALPH_ANTIGRAVITY_HARNESS_PATH`
  Override `antigravityHarnessPath`
- `RALPH_ANTIGRAVITY_SAVE_DIR`
  Override `antigravitySaveDir`
- `RALPH_ANTIGRAVITY_APP_DATA_DIR`
  Override `antigravityAppDataDir`
- `RALPH_ANTIGRAVITY_SKILLS_PATHS`
  Override `antigravitySkillsPaths`
- `RALPH_ANTIGRAVITY_ALLOW_ALL`
  Override `antigravityAllowAll`
- `RALPH_ANTIGRAVITY_STRUCTURED_FINISH`
  Override `antigravityStructuredFinish`
- `RALPH_ANTIGRAVITY_MOCK_RESPONSE`
  Bypass the SDK and emit a mock Antigravity turn response for smoke tests
- `RALPH_ANTIGRAVITY_REQUEST_DELAY_MS`
  Override `antigravityRequestDelayMs`
- `RALPH_LOOP_GOALS`
  Set to `0`, `false`, `no`, or `off` to disable per-loop goals
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

For CPPGM runs, prompt and goal templates should treat file-size, file-audit,
and architecture requirements as substantive design constraints, not as text to
route around. If an agent discovers a pre-existing audit violation or a blind
spot such as hidden include fragments, macro-mediated includes, unchecked
extensions, or weakened check commands, the current phase should require fixing
that issue rather than deferring it because the visible checks pass.

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
