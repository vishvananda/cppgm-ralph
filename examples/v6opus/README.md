# V6 Opus student compiler scaffold

`v6opus` starts before PA1 from the V6 assignments snapshot
`20df0087fc72097316d9ac319b1aaad52593fa1b`, exported from Extended
`aef30fb44c0659452af90f57cb68d81b4f2fce0f`, and works through the PA35 audit.
It uses Claude Code's `opus` alias with `high` effort, native `/goal`, a fresh
session per turn and checkpoint review every third incomplete handoff; in PA35
a restructure phase takes the review's place. The
installed CLI resolves the alias to the available Opus model. Default Claude
credentials are used; there is no separate credential profile.

The spec and prompts distinguish reusable semantic substitution from demanded
body analysis. Reviews check required reuse as well as bounded growth, with
focused controls and reuse of valid measurement evidence. They preserve
context-dependent identities and all required substitution checks. The spec
also states generated-code properties (one register over a value's whole
range, exception regions included; models replaced rather than tuned around)
that apply from the first backend owner, since the assignments measure the
kernels dynamically from PA33. The spec and core templates are concise
replacements for the V5 Sol instructions.

The snapshot includes the reusable semantic design guidance, PA33's dynamic
kernel checks and PA35's per-owner instruction-class attribution. No compiler
implementation, stage plan, audit or Ralph state is inherited. The existing
`assignmentLayout: "v5"` names Ralph's PA1–PA35 stage mapping; V6 keeps that map.

The config retains the course check commands: through reports and file audits for
PA1–PA33, the PA34 self-test ladder and inception, and PA35's unmodified final
17-gate acceptance. Implementation/checkpoint phases use canonical progress
rungs. PA35 implementation handoffs are coherent batches against one owner's
largest excess and keep a mechanism ledger; every third accepted batch enters
the `restructure` phase, which replaces one owner's limiting model completely
and ends when correctness, smoke, inception and preserved rungs hold, with no
gain required. Goals include required checks and fit Claude's 4000-character limit.
Ralph installs each goal; Claude's completion check ends the phase. Partial
handoffs end a turn, and Ralph verifies checks before advancing the assignment.

Install once from `cppgm-ralph`:

```sh
bash examples/v6opus/install.sh
```

The installer provisions a new dedicated 100 GiB filesystem, installs the
specification as one preparation commit, copies the config and 18 sidecars to
`~/work`, and creates the private `vishvananda/cppgm-run-v6opus` repository.
It refuses existing run paths, repositories and unmounted existing volumes.
Verification checks initial PA1 failures, the file audit, hardware counters and
sampling, and a trivial native Opus goal inside the actual Bubblewrap/64 GiB
memory scope. The connectivity probe does not start the compiler worker.

Launch separately:

```sh
RALPH_CONFIG=/home/vishvananda/work/v6opus.config.json npm run ralph
```

The checkout is `~/work/v6opus`; state is `~/work/.ralph/v6opus-opus-high`.
Artifacts and caches stay under `~/work/private/v6opus`. The run uses at most
500 turns and stops after the PA35 audit. Installation leaves it unstarted.
