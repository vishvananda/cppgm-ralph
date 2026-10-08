# V4.4 Sol 6.1 native Codex run

`v4sol61` uses native Codex with `gpt-6.1-sol` at `high` reasoning effort.
It starts before PA1 from `cppgm-assignments`
tag `v4.4` (`5a4e8c0e4103e9a629d42d0ed13226d056f4a4b9`). Commit
`433cb2cb` adds the pre-run specification, file audit, and 14 supplemental
quality-control files. No compiler implementation
or prior run state is carried over. These preparation files are committed so
the new checkout starts clean.

The shared [supplemental backend controls](../backend-quality/README.md) include
the PA33/PA34 instruction checker and all its fixtures for reference. They are
separate from the assignment's course tests.

The checkout is [cppgm-run-v4sol61](https://github.com/vishvananda/cppgm-run-v4sol61),
a private repository with `cppgm-assignments` retained as `upstream`.
`/home/vishvananda/work/v4sol61` points to
`/home/vishvananda/work/private/v4sol61/checkout`. A separate 100 GiB LVM ext4
filesystem, `/dev/vg0/cppgm_v4sol61`, bounds all checkout files, artifacts,
caches, temporary files and shared-memory writes. Its UUID mount is recorded in
`/etc/fstab`; Ralph refuses to run if this filesystem is missing or oversized.
The normal systemd scope limits each turn to 64 GiB memory with no swap.

The installed config and ten prompt/goal sidecars are
`/home/vishvananda/work/v4sol61.*`. They match this example; `spec.md` matches
the checkout. Checks and phase scheduling use
implementation, checkpoint review every third incomplete handoff, and final
stage audit, with the PA34 inception ladder and the PA33/PA34 per-workload
1.25x GCC instruction gate. Measurements use the same repeated hardware-counter
protocol, including instructions/cycles, IPC, sampling attribution, latency,
RSS and code size.

Ralph enables Codex's native goals with `loopGoalsEnabled: true`. Each turn
starts a fresh native Codex thread. Ralph creates the phase goal; the model
must satisfy its phase criteria, call `update_goal` with status `complete`,
and provide a validation handoff. An implementation goal may end while the
assignment remains incomplete. Ralph verifies native goal completion, reruns
external checks and schedules the next phase. The goal sidecars and phase
prompts use this native completion rule throughout, including PA34.

Scaffolding leaves the run ready to launch at PA1 with no Ralph state or prior
sessions. Start it from the Ralph repository:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4sol61.config.json npm run ralph
```

Its state path is `/home/vishvananda/work/.ralph/v4sol61-gpt-6.1-sol-high`.
There is no stage stop limit; the run continues through PA34 subject to its
required checks and `maxTurns: 500`. Create `stop-after-turn` in that state
directory to stop after the current turn and checks. Codex uses the existing
ChatGPT-authenticated login; native sessions remain outside the private volume.

The installed Codex CLI's native goal protocol and hardware-counter counting
and DWARF sampling were checked inside this run's Bubblewrap sandbox and
64 GiB systemd scope. Verification artifacts are in
`/home/vishvananda/work/private/v4sol61/artifacts/scaffold-verification`.
