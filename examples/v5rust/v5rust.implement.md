Implement the next coherent exact-clone behavior group for {{testStage}}.

{{briefState}}
Current results: {{testStatusSummary}}
Full primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, the owning assignment handout,
docs/rust-clone-plan.md and docs/port/{{testStage}}.md. Inspect the actual C++
owners in /home/vishvananda/work/references/v5rust-cpp. This is a translation
with a readable implementation oracle, not a from-scratch student solution.

Use idiomatic Rust names, ownership, Result, enums, compact typed IDs and
explicit target arithmetic. Preserve parsing once, typed semantic facts,
demand boundaries, emission order and per-function backend lifetimes. Keep the
optimizer/code generator behavior exact; no new optimizations. No unsafe, FFI
implementation, subprocess compiler fallback, test recognition or reference
answers in compiler code. No speculative whole-program work on hot paths.

Cluster failures by their earliest divergent phase and shared C++ owner. Port
the coherent group and its production invariants, validate it, then continue
related work while that understanding remains useful. A single passing case
or a commit is not a stopping boundary. A partial handoff is valid when a
coherent group is done and the next dependency boundary is documented.

Use make test-{{testStage}}, make course-{{testStage}}, make lint and make
audit-rust. Focused tests are useful during development, but handoff requires
all earlier stages green, exact failure reduction in the fixed current-stage
manifest and preservation of previously passing case identities. Missing
implementation status 86 never matches a valid rejecting compiler. Follow
the protected trace paths to inspect raw diagnostics, objects and outputs.

Update docs/port/source-map.tsv and the stage ledger with C++/Rust owners,
typed data flow, remaining groups, exact case IDs, commands and artifact
paths. Record stage base HEAD on first entry; implementation does not advance
the last-audited commit. Measure compile time/RSS/scaling for supported hot
paths; PA35's generated-code improvement targets are not requirements here.

Never edit protected checks, fixtures, references, oracle sources, Ralph state
or acceptance policy. Report an oracle/harness defect with a reproducer and
continue independent port work. Do not silently redefine the contract.

Commit intended changes and leave a clean checkout. Complete Ralph's existing
native goal only when this phase's work is done, then return a concise handoff
with validation and remaining work. Do not create, replace or edit the goal.
Goal completion hands control back; Ralph owns checks, audits and advancement.

Required external criteria:
{{modelValidation}}
