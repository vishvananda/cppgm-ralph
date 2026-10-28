# v5rust repository guide

This repository is an exact safe Rust port of the frozen cppgm-extended
compiler. Follow `CLONE_CONTRACT.md`, `spec.md` and
`docs/rust-clone-plan.md`. Read the current `paN/README.md` and
`docs/port/paN.md`. Consult the read-only C++ implementation directly.

Compiler code belongs in `dev/src/`; entry points in `dev/bin/`. Keep reusable
algorithms in their owning phase. Preserve typed facts, parse-once ownership,
compact IDs, explicit demand and per-function backend lifetimes. Keep
`docs/port/source-map.tsv` current. No unsafe code or C++ implementation fallback.
Preserve the reference algorithm, state lifetimes, demand/short-circuit order
and cache boundaries before optional redesign. Safe Rust ownership adapts the
representation, not the execution lifecycle.

Use `make build`, `make lint`, `make audit-rust`, `make test-paN` and
`make course-paN`. Run earlier completed stages after a coherent change.
`make test-harness` checks the clone checker; `make inception` is the final
cross-implementation PA34 proof, not a Rust self-compiler.

Fixtures and benchmarks are compiler inputs: never format them. Never change
frozen reference files or protected gate policy. New required fixtures go in
the earliest owning assignment's executed lane. Do not commit generated
outputs, artifacts, logs or Cargo target files. Compiler stubs return status
86; this is not a successful C++ rejection.

Rustfmt and strict Clippy are required. Use Result and structured errors,
checked host-size conversions, explicit target wrap/truncation, private typed
store APIs and narrow justified lint expectations. No blanket lint suppression,
mechanical part/chunk files, text reparsing between phases, or environment
reads under `dev/src/`; collect them in `dev/bin/` and pass typed options.
The companion file audit is authoritative for source
limits; passing Clippy alone is insufficient.

Use up to three read-only subagents for disjoint owner reviews; the parent owns
edits and source-map certification. While a broad audit is open, use focused
tests, clone_quality.py --review and clone_evidence.py checkpoint. Run full
prior/quality checks at substantial milestones and final acceptance; the strict
snapshot still requires valid receipts. Keep one compact ledger. Raw cases stay
in artifacts and previous plans in Git. Add broad probes/resource studies only for a changed
invariant or stated question. For each stage record its base and audited tip, C++/Rust owners,
completed behavior groups, exact failing case IDs, next dependency boundary,
validation commands/artifact paths and measured resource costs. Do not claim a
stage complete from fixture counts alone. Keep source responsibilities and
architecture review in the audit. Commit coherent increments and leave a clean
checkout at handoff. Ralph owns goals, gate execution and stage advancement;
never edit its state or create/replace its goal.

PA35 is not an active conversion stage. Preserve code generation, including
the existing optimizer and register allocator. PA34 must compile the frozen
C++ sources and prove full object/tool byte equality with the C++ fixed point.
