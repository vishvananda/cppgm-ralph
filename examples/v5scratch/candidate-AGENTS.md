# v5scratch student compiler

Implement one cumulative Linux x86-64 C++11 compiler in safe Rust, working
through PA1–PA33. Read the current `paN/README.md`, `TESTING_AND_REFERENCES.md`
and `spec.md`. Handouts describe C++ starter files; implement those roles in
Rust under `dev/src/`, with command-line entry points under `dev/bin/`.

Use the handouts, checked fixtures, C++11 standard and supplied reference
binaries. Do not read or copy completed compiler sources, other runs or solution
repositories, locally or online. Implement required compiler work yourself;
reference tools perform only the grading/observation roles in the handouts.
The normal production path never calls a reference or external implementation
for preprocessing, semantics, lowering, optimization or object generation.
The handouts' allowed host configuration, linking and runtime support remain.

Use typed identities, private stores, parse-once facts, demand-driven work,
per-function editable IR and explicit lifetime boundaries. No unsafe code or
FFI implementation. Read the environment at tool boundaries, passing typed
options into phases. Avoid per-node heap ownership, implicit deep clones,
mechanical file fragments and blanket lint suppression.

Run `make build`, `make test-paN`, `make test-report-through-paN`,
`make rust-quality` and `make audit-rust`. The Rust tool names and CLI contracts
match the course. Cargo builds release binaries; ordinary course workers invoke
them without a C++ embedded batch runner. Rustfmt, Clippy and Cargo tests are
required. Use the owning assignment's debug and inspection targets when due.

Preserve course fixtures and comparison semantics. Corrections require the
proof described in `TESTING_AND_REFERENCES.md`. Keep personal controls in
`student.tests/`. New implementations may choose their own valid storage,
diagnostics and code generation; this is not an exact clone acceptance gate.

Record compact stage plans, reviewed commits, remaining behavior groups and
validation evidence. Measure affected supported work under spec section 11;
reuse unchanged observations and expand only for a stated question. Commit
coherent changes and leave the checkout clean. Ralph owns the native phase goal,
external checks and advancement. Never create/replace its goal or edit its state.
A coherent partial handoff may complete an implementation goal without passing
the stage; checkpoint and final audits govern acceptance.

The run stops after the PA33 audit. PA34/PA35 remain handout material and have
no exit criteria in this run. Preserve NOTICE and inherited attribution.
