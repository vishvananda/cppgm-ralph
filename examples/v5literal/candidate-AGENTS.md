# Literal compiler port

Translate the pinned C++ compiler into Rust, file by file in dependency order.
Read `CLONE_CONTRACT.md`, `spec.md`, `porting.md` and `docs/port/pa33.md`.
The reference source and tools are read-only; their location is recorded in
`scripts/clone/settings.json`. Assignment handouts are validation descriptions,
not an implementation sequence. Ralph's PA33 label tracks the source inventory;
PA34 is the unchanged cross-implementation bootstrap proof.

Preserve C++ functions, fields, control flow, state lifetimes, lazy/short-circuit
order, queues, cache keys, numeric rules and emitted bytes. Follow the frozen
`port/inventory.json` mapping. Do not reorganize classes, combine queries, replace
algorithms, optimize or redesign the pipeline. Adapt syntax and representation
only where Rust requires it, and record the reason in the owning source review.
Header declarations and implementation bodies have separate mapped Rust files;
one class may have implementations across several files, as in C++.

First establish shared ownership, pointer/arena, null, error and integer rules in
`dev/src/compat/`. Preserve original object lifetimes and aliasing behavior without
creating invalid Rust references. Narrow unsafe blocks are allowed with SAFETY
comments and exact entries in `port/unsafe.json`; run `make audit-rust` to check
the ledger. No C++ implementation FFI, compiler fallback, embedded oracle answers,
fixture recognition or silent baseline/reference updates.

After a reference update, recover changed completed files from
`port/reference-update.json` first; retain unchanged work and renew affected
reviews/evidence against the current pin. Old ledgers never override new source.

Select a substantial connected producer/consumer group from `porting.md`; finish
its shared dependencies, removing stubs or closing owners before handing off. Use `make inspect SOURCE=dev/path.cpp` for original definitions
and mapped Rust function identities. A completed source needs complete function
correspondence, declaration/state review, documented adaptations and hashed
validation evidence. Update `port/source-map.tsv` and `port/reviews/` honestly.
Source progress is reviewed implementation, never an added-test count.

Use `make build`, `make lint`, `make audit-rust` and focused differential cases.
Use the shared probe runner; reserve memory/alias and fault matrices for changed
ownership/lifetime/cleanup or concrete safety concerns. Reuse unchanged evidence.
Run course milestones when usable and at stable boundaries; retain final closure.
Use frozen-source bootstrap probes early to prioritize real mismatches; probes
are not final acceptance. Preserve all prior successful behavior. Formatting and
correctness checks apply; there are no style-driven file/function size limits.

Keep one compact ledger: batch, C++/Rust files, reviewed tip, outstanding findings,
evidence and next dependency. Commit a coherent handoff and leave clean. Ralph
owns the native goal and stage advancement. Complete the bounded handoff goal;
do not create/reset goals, edit Ralph state or weaken protected checks.
