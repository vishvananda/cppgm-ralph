# V9 literal Rust recovery

The current source pin is cppgm **v0.9.1**,
`c9b05c4c0f7bb1294c717551c61145940b21125e`. Exported assignments are
`57072c63636274eed3088da8ae3ac1164478117a`, whose reference manifest names
that exact source. The `assignments-v9` course tag remains at its v0.9.0 base;
patch releases must descend from it. No moving branch substitutes for a pin.

The Rust implementation starts from optimized V8 commit `e72bb2b6`, retaining
its full-LTO Cargo profile. The source census is 469 -> 777: 132 unchanged
owners, 333 existing owners to recover (including three renames), and 312
genuinely new owners. Changed and renamed reviews are pending; preparation
never certifies parity. Removed owners retire when replacements are integrated.

`v9literal.config.json`, its concise prompts/goals and `spec.md` describe the
fresh native Codex worker. It uses default shared authentication, a private
writable filesystem, 64 GiB memory and two CPUs. The existing V8 run's source,
controls, logs and optimized binaries are retained. PA33 is only the source
progress transport; Ralph next visits PA35 bootstrap. The owning final checks
require PA1–34, PA37 wasm and **PA38 C**, including shipped LowIR interfaces.
PA38 is optional only for the student Sol run. PA36 supplies performance
workloads; retain the <=5% frozen O0/O3 compile-time target against the pin.

Stage a later update from an exact released source and matching export:

```sh
~/work/v5literal-control/venv/bin/python scripts/prepare-v9literal.py \
  --control ~/work/v9literal-control \
  --source /mnt/vizier/cppgm-v091-reference \
  --assignments ~/cppgm-assignments-release \
  --version v0.9.1 \
  --source-revision c9b05c4c0f7bb1294c717551c61145940b21125e \
  --assignments-revision 57072c63636274eed3088da8ae3ac1164478117a \
  --output /mnt/vizier/v9literal-prepared
```

This stages Git history, tagged source inventory, exported fixtures/wrappers,
renamed Rust owners and reviewed controller routing. It changes no active run,
copies no credentials, creates no Ralph state and starts no worker. Activation
must rebind installation paths and refresh the protected manifest, then verify
preflight, unsafe reviews, source counts and isolation before starting Ralph.
The legacy updater refuses V9 through its old installation path.

Recover connected producers/consumers in order: target/machine records;
preprocessing/parser; semantic facts/lowering; optimizer/backend; wasm/C;
LowIR interfaces. Preserve original algorithms and lifetimes. Existing Rust
fast paths remain only when current source invariants still hold. Refresh
changed evidence; reuse valid unchanged reviews. Completion requires exact
outputs/artifacts, all configured course/debug checks and complete
C1 == C2 == CR == C3 bootstrap proof. Record performance separately from
Cargo build time, using paired wall time and available instruction/cycle/RSS
measurements with explicit LTO modes.

Local installation, source/export provenance and campaign logs are under
`/mnt/vizier/cppgm-v091-intel-campaign/`; the new worker is `v9literal`.
