# Mechanical translation workflow

The work inventory is `port/inventory.json`, frozen from the pinned C++ tree.
Ralph uses PA33 as the inventory transport label and PA34 for bootstrap. No
assignment is considered passed merely because this run starts at that label.
Read the reference implementation, not another Rust solution. Do not build a
new compiler from the handouts.

## Order and adaptation

1. Read original ownership/storage support and representative users. Establish
   the minimal common pointer/arena, nullable identity, error/cleanup and target
   integer conventions. Preserve original lifetimes and aliasing without invalid
   Rust references. Record narrowly needed unsafe operations and invariants.
2. Translate foundational declarations and vocabulary, then their implementation
   files in dependency order. Mutually recursive declarations may form one batch.
   Keep each original file's mapped path, functions, fields and control flow.
3. Progress through lexer/preprocessor, syntax/types/ABI, semantic owners,
   lowering, optimizer, native/object support and driver wiring according to
   actual dependencies. Follow existing algorithms, not independent PA solutions.
   Independent LowIR/native tools can be translated when their dependencies are
   ready, rather than waiting for source semantics. Exercise usable tools early.
4. Run focused differential controls and record stable usable course milestones.
   Start bounded frozen-source compilation probes when source compilation works.
   At full source closure, every original PA1–PA33 course/differential/debug lane
   is mandatory regardless of the milestone list. Then prove PA34 equality.

Naming/overloading, explicit casts, template representation, C++ inheritance and
exception/RAII propagation can require Rust adaptations. Explain those locally
and preserve their algorithmic effects. Do not combine state owners, replace
pointer graphs with a different semantic design, fuse queries, change ordering,
add optimizations or split functions merely to satisfy style rules. Reusable
compatibility support is not permission to replace original compiler phases.

## Recording a translated source

`make inspect SOURCE=dev/path.cpp` prints frozen function IDs, parser gaps, the
mapped Rust path and current Rust function hashes. Header and implementation
paths are distinct (`*_h.rs` and `*_cpp.rs`), preserving directory structure.
Register real modules or mapped `include!` files in `dev/src/translated/`.
`python3 scripts/port_check.py draft dev/path.cpp` generates a proposed source-order
function map and hashes so you need not transcribe IDs. Its review flags remain
false and evidence empty: inspect and validate the mapping before certification.

Run successful validation through:

```
python3 scripts/port_check.py record -- cargo build --manifest-path dev/Cargo.toml --workspace --release --locked
```

The wrapper uses the installed control venv Python. It records current mapped
source hashes, command exit and raw log
identity in a receipt under the run's artifact directory. Use focused cases via
`python3 scripts/clone_check.py case paN tests/path.t` when relevant tools work.

For `dev/path.cpp`, create `port/reviews/dev/path.cpp.json` with:

```
{
  "source_sha256": "from inventory",
  "rust_sha256": "current whole mapped file hash",
  "declarations_reviewed": true,
  "state_lifetimes_reviewed": true,
  "functions": {"frozen function id": {"rust_sha256": "current Rust function hash"}},
  "manual_ranges": ["every frozen parser-gap id, if any"],
  "adaptations": ["Rust-required representation change and why behavior/order is preserved"],
  "validation": [{"path": "receipt.json absolute path", "sha256": "receipt hash"}]
}
```

An empty adaptations list is valid if none were needed. Review all declarations,
fields, macros and branch/state behavior; function counts alone are insufficient.
Every frozen function must map to a distinct non-test Rust function in that same
mapped production file. Comment-only, unregistered and cfg(test)-only files do
not count. Set the source-map row to `complete` only after its whole source is
translated/reviewed. Current-byte and evidence hashes invalidate stale reviews.

`make audit-rust` checks unsafe identities in `port/unsafe.json`. Each entry names
file, syntax hash, original source (or compatibility rationale), reason,
allocation/alias/lifetime invariants and validation. Use `port_check.py unsafe-scan`
to inspect actual constructs. SAFETY comments and correctness lints still apply.

## Bounded handoffs

Keep the current batch finite. Review source correspondence independently at
checkpoint audits. Fix a required shared dependency, but queue unrelated findings.
Keep `docs/port/pa33.md` compact: selected files, reviewed tip, adaptations,
findings, evidence and next dependency. Commit and leave clean. A native goal
ends a coherent handoff; it does not demand the whole compiler in one turn.

Use `make milestones` for the stages listed in `port/milestones.json`; it does
not replace final validation. `clone_bootstrap_probe.py --limit 4` and `--source`
provide isolated diagnostic object comparisons, not bootstrap acceptance. Broad
sweeps belong at stable milestones and final closure, not after every file.
