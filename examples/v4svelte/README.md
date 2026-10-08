# V4.4 Sol 6.1 native Codex run

`v4svelte` starts before PA1 from assignment v4.4
(`5a4e8c0e4103e9a629d42d0ed13226d056f4a4b9`), with the original file audit
and supplemental controls plus the revised specification. No compiler work,
stage plans, audits or Ralph state from another run are carried over. Installed
preparation commit: `642a35fd290480d8ee10237f9f9372f8d7036f82`; pushed to the
private [cppgm-run-v4svelte](https://github.com/vishvananda/cppgm-run-v4svelte)
repository. Sandbox counter/sampling verification passed at installation.

The config uses native Codex `gpt-6.1-sol` at `high` reasoning effort, native
phase goals, a fresh thread each turn, and the existing implementation/checkpoint/
final-audit schedule. Checkpoints occur every third incomplete handoff. The PA34
inception ladder, PA33/PA34 per-workload 1.25x GCC instruction gate, file audit,
prior-stage regression checks and progress-preservation checks are retained.

The prompts and spec scope implementation/checkpoint measurement to affected
owners, reuse valid unchanged evidence, and expand for shared changes or
regressions. Final audits verify complete stage-supported evidence and refresh
mandatory gates. Related facts and consumers form coherent handoffs; evidence
records stay compact. Correctness, architecture and counter protocols remain
mandatory. Prompt/goal text totals 3,126 words versus 3,512 in the source scaffold;
the spec is 2,869 words versus 2,834.

Install from this repository:

```sh
bash examples/v4svelte/install.sh
```

The installer first requests a boundary stop for `v4sol61`. It creates a dedicated
100 GiB ext4 LV (`vg0/cppgm_v4svelte`), persists its UUID mount in `/etc/fstab`,
and installs `/home/vishvananda/work/private/v4svelte/checkout` with the
`/home/vishvananda/work/v4svelte` symlink. It copies the config and ten sidecars
into `/home/vishvananda/work`, verifies hardware counting/sampling and the initial
file audit in Bubblewrap plus the 64 GiB systemd scope, then creates and pushes
the private `vishvananda/cppgm-run-v4svelte` repository. It refuses existing run
paths/remotes and never formats an existing LV. A correctly mounted private
filesystem can be provisioned separately. GitHub authentication, delegated user
systemd and LVM administration via sudo are required for installation.

The installer fetches only preparation commit
`433cb2cbde465843d79cdc1490597a83fda214ab` from the local source checkout,
checks out its assignment parent, restores the original controls and commits the
revised spec with those controls as one preparation commit. Later run commits
are excluded. `cppgm-assignments` remains the `upstream` remote.

Installation leaves the run unstarted, with no Ralph state. Start it separately:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4svelte.config.json npm run ralph
```

State is `/home/vishvananda/work/.ralph/v4svelte-gpt-6.1-sol-high`; verification
artifacts stay inside the private volume under `artifacts/scaffold-verification`.
Scratch/cache/shared memory share the bounded volume; provider state stays
outside. The normal memory scope remains 64 GiB with no swap. There is no stage
stop limit, and `maxTurns` remains 500.
