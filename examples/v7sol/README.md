# V7 Sol student compiler scaffold

`v7sol` keeps [v6sol](../v6sol/README.md)'s native Codex `gpt-6.1-sol` / `high`
setup, four phases, three-checkpoint review cadence, PA35 restructure policy,
checks and 500-turn limit. It runs PA1–PA35 with native phase goals, a 100 GiB
private filesystem and a 64 GiB/no-swap scope. It uses the default Codex profile
and SSH identity, with no copied credentials or repository credential helper.

The assignments `v7` tag is pending. The installer resolves that tag before
creating any run paths, volume or remote repository and refuses installation
if it is absent. It never substitutes V6 or a moving main branch. V7 is expected
to include the PA6/PA7 compact-storage handout guidance; release preparation
must include that change before tagging assignments.

The general implementation, checkpoint-audit and final-audit prompts/goals
reinforce compact common records, separate optional payloads and short-lived
scratch. When common layouts change, collect record sizes, counts, capacities,
owned payloads and peak RSS on a representative input; reuse unaffected evidence.
The spec adds the same storage property. These are general architecture
instructions, with no run-specific diagnosis or new acceptance thresholds.
Large implementation batches and existing focused-validation guidance remain.

Validate the prepared config, all 18 sidecars and goal sizes without creating
or starting a run:

```sh
node examples/v7sol/verify-setup.mjs --templates-only
```

Once the assignments tag is published, install from `cppgm-ralph`:

```sh
bash examples/v7sol/install.sh
```

Installation starts before PA1, adds only `spec.md` as a preparation commit and
pushes the fresh checkout to private `vishvananda/cppgm-run-v7sol`. No compiler
implementation, plans, audit history or Ralph state is copied. Verification
checks initial PA1 failures, file audit, hardware counters/sampling and native
goal completion inside the real sandbox; the worker remains unstarted.
The resolved tag and commit are saved in the verification artifacts.

Launch separately after installation:

```sh
RALPH_CONFIG=/home/vishvananda/work/v7sol.config.json npm run ralph
```

Checkout: `~/work/v7sol`. State: `~/work/.ralph/v7sol-gpt-6.1-sol-high`.
Artifacts: `~/work/private/v7sol/artifacts/scaffold-verification/`.
`assignmentLayout: "v5"` remains Ralph's PA1–PA35 comparison map.
