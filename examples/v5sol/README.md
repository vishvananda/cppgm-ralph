# V5 Sol native Codex scaffold

`v5sol` starts before PA1 from `cppgm-assignments` tag `v5`, commit
`4fc4f61d8897f09293a2ef9202fd49373c602a29`, and works through PA35. It uses
native Codex `gpt-6.1-sol` with `high` reasoning, native phase goals, a fresh
thread per turn, and checkpoint review every third incomplete handoff.
No compiler implementation, stage plans/audits or Ralph state is inherited.

The scaffold includes its config, 16 prompt/goal sidecars, specification,
installer and setup verifier. The architecture spec follows
`cppgm-extended/spec.md` at `72181d97`, with a shorter review checklist and a
run-specific performance policy. It treats named structures as examples of
required properties, preserves typed phase boundaries and editable per-function
IR, and applies requirements only to capabilities introduced so far.

Performance instructions require a stated question, qualification before
timing, frozen provenance, a small fixed input set and reuse of unchanged
results. Implementation/checkpoints measure affected owners after coherent
changes stabilize; shared changes get representative consumer smokes.
Routine diagnostics use three interleaved measurements per variant, with
additional repeats, profiling or full simulation justified by a concrete
uncertainty. Canonical course scripts retain their own protocols and limits.
Final reviews fill evidence gaps rather than repeat historical matrices.

V5's shipped `scripts/cppgm_file_audit.pl` is a required check over `dev` in
every phase. The course treats it as advisory; this run makes it mandatory.
It is used unchanged. V4's supplemental controls are not copied into this run:
V5 supplies the optimization workloads and acceptance gates under `pa35/`.

PA1–PA33 use the root through report. PA34 retains the host regression,
self-test ladder, pptoken comparison and canonical inception checks.
PA35 has separate implementation, checkpoint and final-audit templates:

- Implementation/checkpoints preserve earlier correctness, run the course
  smoke check, and require improved/preserved rungs from `test-progress`.
  The model must refresh affected gate-group measurements and record valid
  hashes/provenance; the rung reader itself performs no measurements.
- Final acceptance requires `make -C pa35 test` (all 17 unmodified gates),
  the through-PA33 report, canonical inception and file audit.
- Supplied cached quick checks and focused group measurements support iteration.
  Full cache simulation belongs to final acceptance or a justified diagnostic.

Ralph creates each native goal. The model satisfies its phase instructions,
calls `update_goal` with status `complete`, and returns a handoff. Ralph verifies
the goal and external checks before advancing; a partial implementation goal
does not certify the assignment.

Install once from this repository:

```sh
bash examples/v5sol/install.sh
```

The installer provisions a dedicated 100 GiB ext4 LV (`vg0/cppgm_v5sol`),
persists its UUID mount, creates the private checkout and adds only the spec
as one preparation commit. It installs `/home/vishvananda/work/v5sol` as a
symlink, copies `v5sol.*` sidecars into `/home/vishvananda/work`, verifies
hardware counting/sampling and file audit in Bubblewrap plus the 64 GiB/no-swap
systemd scope, and pushes the private
[cppgm-run-v5sol](https://github.com/vishvananda/cppgm-run-v5sol) repository.
It refuses existing run paths/remotes and never formats an existing LV.
GitHub SSH access, delegated user systemd and noninteractive sudo/LVM access
are required. Installation leaves the run unstarted.

Launch separately from `cppgm-ralph`:

```sh
RALPH_CONFIG=/home/vishvananda/work/v5sol.config.json npm run ralph
```

Ralph state is `/home/vishvananda/work/.ralph/v5sol-gpt-6.1-sol-high`;
scratch/cache/artifacts stay on the bounded private volume. `maxTurns` is 500,
with no stage stop limit. A `stop-after-turn` file in the state directory requests
a boundary stop. For comparisons/exports through PA35, use `--through pa40`:
V5's new stage is canonical landmark 40 after the previous inception landmark.
Older assignment layouts have no counterpart for it.

`v5rust` is intentionally deferred until its implementation and harness choices
are discussed; this scaffold does not impose a Rust design.
