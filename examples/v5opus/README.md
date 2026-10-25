# V5 Opus student compiler scaffold

`v5opus` starts before PA1 from the current `cppgm-assignments` main revision
`22e677f46ffa27a8e003c0b53331c9188d151071` and works through the PA35 audit.
It uses Claude Code's `opus` alias with `high` effort, native `/goal`, a fresh
session per turn and checkpoint review every third incomplete handoff. The
installed CLI resolves the alias to the available Opus model. Default Claude
credentials are used; there is no separate credential profile.

The spec and prompts distinguish reusable semantic substitution from demanded
body analysis. Reviews check required reuse as well as bounded growth, with
focused controls and reuse of valid measurement evidence. They preserve
context-dependent identities and all required substitution checks. The spec
and core templates are concise replacements for the V5 Sol instructions.

The assignment tree is unchanged. Revised student handouts are being reviewed
separately in Extended; update the assignments base after the planned reference
PRs merge and the student export is regenerated. No handout patch, compiler
implementation, stage plan, audit or Ralph state is copied into this run.

The config retains V5 Sol's course checks: through reports and file audits for
PA1–PA33, the PA34 self-test ladder and inception, and PA35's unmodified final
17-gate acceptance. Implementation/checkpoint phases use canonical progress
rungs. Goals include required checks and fit Claude's 4000-character limit.
Ralph installs each goal; Claude's completion check ends the phase. Partial
handoffs end a turn, and Ralph verifies checks before advancing the assignment.

Install once from `cppgm-ralph`:

```sh
bash examples/v5opus/install.sh
```

The installer provisions a new dedicated 100 GiB filesystem, installs the
specification as one preparation commit, copies the config and 16 sidecars to
`~/work`, and creates the private `vishvananda/cppgm-run-v5opus` repository.
It refuses existing run paths, repositories and unmounted existing volumes.
Verification checks initial PA1 failures, the file audit, hardware counters and
sampling, and a trivial native Opus goal inside the actual Bubblewrap/64 GiB
memory scope. The connectivity probe does not start the compiler worker.

Launch separately:

```sh
RALPH_CONFIG=/home/vishvananda/work/v5opus.config.json npm run ralph
```

The checkout is `~/work/v5opus`; state is `~/work/.ralph/v5opus-opus-high`.
Artifacts and caches stay under `~/work/private/v5opus`. The run uses at most
500 turns and stops after the PA35 audit. Installation leaves it unstarted.
