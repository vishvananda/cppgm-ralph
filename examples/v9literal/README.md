# V9 update of the literal Rust compiler

The source target is `bb09801053e48486beebe014071a71353ce9be0b` in
`vishvananda/cppgm`, to be published as `assignments-v9` and `v0.9.0`.
The assignments export must have its matching `v0.9.0` tag and source SHA.
PA38 C is **required for the Rust port**, alongside wasm, all native features
and shipped LowIR interfaces. It remains optional only for student runs.

Preparation already built all nine C++ tools at that commit in
`/mnt/vizier/cppgm-v9-reference-bb09801`. The active optimized Rust compiler
and its V8 pins are unchanged. Its current commit is `e72bb2b6`.

The source plan is 469 -> 770 responsibilities: 134 unchanged; 331 existing
owners require recovery, including three renames; 305 genuinely new owners.
The driver/scaffold rename to `cppgm` and global-data move into `machine/`
have explicit origins and Rust relocation paths. Removed source owners are
retired after their replacements are integrated, not blindly deleted.

After the source and export tags exist, stage a migration without replacing
or starting the active run:

```sh
~/work/v5literal-control/venv/bin/python scripts/prepare-v9literal.py \
  --control ~/work/v5literal-control \
  --source /mnt/vizier/cppgm-v9-reference-bb09801 \
  --assignments ~/cppgm-assignments-release \
  --output /mnt/vizier/v9literal-prepared
```

Fetch release tags into both checkouts first. The command fails before creating
the output when tags or export provenance are missing/mismatched. It clones the
existing Rust Git history, installs tagged **exported** tests/wrappers, retains
implementation bytes, relocates renamed owners and records changed files as
pending. It prepares reviewed controller templates with explicit V9 routing,
including PA33 LowIR optimization, PA34 backend optimization, PA35 bootstrap,
PA37 wasm and PA38 C. It creates no Ralph state, copies no credentials, starts
no worker and does not change the active checkout/control/reference pins.
The result is intentionally a staging branch for review and source recovery,
not a deployment, a passed build or a parity certificate.

The legacy `reference_update.py` now has rename-aware dry-run plans but refuses
to apply V9 using its old installation path. Use this staged migration instead.
Legacy profiles and their tests remain supported.

Recover connected producers/consumers in this order: shared target and machine
records; preprocessing/parser; semantic facts and typed lowering; optimizer and
native backend; wasm and C integration; LowIR library interfaces. Existing Rust
fast paths may remain only when current source behavior, storage and failure
invariants still hold. Do not replay the entire C++ commit history or rewrite
algorithms. Each coherent group needs focused exact comparisons and refreshed
source/unsafe reviews. Reuse unchanged evidence; refresh dependent checks.

Completion requires current course/debug checks (including PA38), exact raw
outputs/counters/artifacts and the C1 == C2 == CR == C3 bootstrap proof for all
objects/tools. Measure runtime separately from Rust's own Cargo build time.
The old frozen workload's 53 files are unchanged and now live under PA36;
retain that benchmark and add full-source self-compilation. Keep the <=5%
frozen O0/O3 wall-time target against the pinned V9 reference. Record LTO modes
explicitly, and use paired wall time plus instruction/cycle/RSS evidence.

Raw census, reference build and initial migration diagnostics are under
`/mnt/vizier/v5literal-v9-planning-20261115/`. The initial old-Rust/new-C++
comparison is diagnostic only; it does not claim V9 parity or performance.
