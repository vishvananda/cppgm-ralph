# V8 Sol student compiler scaffold

`v8sol` keeps [v6sol](../v6sol/README.md)'s native Codex `gpt-6.1-sol` / `high`
setup, four phases, three-checkpoint review cadence, PA35 restructure policy,
checks and 500-turn limit. It runs PA1–PA35 with native phase goals, a 100 GiB
private filesystem and a 64 GiB/no-swap scope. It uses the default Codex profile
and SSH identity, with no copied credentials or repository credential helper.

The installed base is assignments tag `v8`, commit
`22dbd7a3c197d57353dd39ce4542997ee3c1e41a`, exported from cppgm-extended
`08bba949b4a0c3f2a728bf52c6e7089a38b44797`. It includes the compact-storage
and PA24 placement guidance, revised optimization checks and current reference
bundle. The unstarted V7 scaffold's spec preparation was replayed onto V8;
`fa2b5bc7` is the renamed run tip, with only `spec.md` added to the tagged base.
The private run repository's `main` is pushed; Ralph remains unstarted.
See [VALIDATION.txt](VALIDATION.txt) for setup evidence.
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
node examples/v8sol/verify-setup.mjs --templates-only
```

To reproduce the setup on a fresh host, install from `cppgm-ralph`:

```sh
bash examples/v8sol/install.sh
```

Installation starts before PA1, adds only `spec.md` as a preparation commit and
pushes the fresh checkout to private `vishvananda/cppgm-run-v8sol`. No compiler
implementation, plans, audit history or Ralph state is copied. Verification
checks initial PA1 failures, file audit, hardware counters/sampling and native
goal completion inside the real sandbox; the worker remains unstarted.
The resolved tag and commit are saved in the verification artifacts.

Launch separately after installation:

```sh
RALPH_CONFIG=/home/vishvananda/work/v8sol.config.json npm run ralph
```

Checkout: `~/work/v8sol`. State: `~/work/.ralph/v8sol-gpt-6.1-sol-high`.
Artifacts: `~/work/private/v8sol/artifacts/scaffold-verification/`.
`assignmentLayout: "v5"` remains Ralph's PA1–PA35 comparison map.
