# V7 Sol student compiler scaffold

`v7sol` keeps [v6sol](../v6sol/README.md)'s native Codex `gpt-6.1-sol` / `high`
setup, four phases, three-checkpoint review cadence, PA35 restructure policy,
checks and 500-turn limit. It runs PA1–PA35 with native phase goals, a 100 GiB
private filesystem and a 64 GiB/no-swap scope. It uses the default Codex profile
and SSH identity, with no copied credentials or repository credential helper.

The installed base is assignments tag `v7.1`, commit
`90f57e195bc1232e56a63cffd8239f277e44c1aa`, including the PA6/PA7
compact-storage guidance and the floating-point fixes. Preparation commit
`256f31e2` adds only `spec.md`; `935f6456` refines the backend and optimization
guidance. The private run repository's `main` is pushed; Ralph remains
unstarted. See [VALIDATION.txt](VALIDATION.txt) for setup evidence.
The installer resolves the release tag before provisioning and refuses an
existing destination. It never substitutes V6 or a moving main branch.

The general implementation, checkpoint-audit and final-audit prompts/goals
reinforce compact common records, separate optional payloads and short-lived
scratch. When common layouts change, collect record sizes, counts, capacities,
owned payloads and peak RSS on a representative input; reuse unaffected evidence.
The spec adds the same storage property and recommends retaining virtual value
identities through selection, with replaceable placement over actual instruction
constraints. Implementation and audit prompts reinforce that seam from PA24.
PA35 prompts/goals rank removable cost across producers and consumers using
function/call attribution with instruction mix; coupled changes can span owners,
and repeated small gains trigger review of the blocking model. These are general
instructions, with no run-specific diagnosis or new acceptance thresholds.
Large implementation batches and existing focused-validation guidance remain.

Validate the prepared config, all 18 sidecars and goal sizes without creating
or starting a run:

```sh
node examples/v7sol/verify-setup.mjs --templates-only
```

To reproduce the setup on a fresh host, install from `cppgm-ralph`:

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
