Translate a substantial connected frozen C++ dependency group into Rust.

{{briefState}}
Inventory status: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, porting.md and the compact current
ledger. PA33 is the whole-source inventory label, not an assignment feature task.
Use the frozen C++ files directly. Preserve functions, fields, control flow,
persistent state, failure restoration, lazy/short-circuit order, live queues and
cache boundaries. Record Rust-required representation adaptations; defer optional
redesign, abstractions and optimization. Keep the frozen per-file mapping.

After a reference update, recover remaining changed owners and consumers first.
Diff the pinned sources; old plans and receipts do not establish current parity.
Reuse unchanged reviews and renew affected evidence and usable milestones.

Choose a closed producer/consumer group that removes production stubs or closes
near-complete owners. Follow its shared dependencies through; do not stop at a
few helpers merely because they build. Keep a finite handoff. Stubs receive no
credit. Use make inspect SOURCE=dev/path.cpp for correspondence. Preserve shared
pointer/error conventions, SAFETY invariants and the unsafe ledger. No C++ FFI
or oracle substitution.

Build, lint and audit the group once at handoff; run focused exact comparisons
while translating. Reuse probe infrastructure via python3 scripts/port_check.py
probe RECIPE.json, or record -- COMMAND. Run memory/alias and allocation-failure
probes for changed ownership, lifetime or cleanup behavior and concrete safety
concerns; reuse evidence for unchanged mechanisms. Broad matrices and course
sweeps belong at stable checkpoints/final closure. Keep all final gates exact.

Fill current whole-source reviews and function correspondence, then mark only
fully translated/reviewed source rows complete. Keep one ledger: batch, reviewed
tip, mappings/adaptations, findings, evidence and next dependency. Commit and
leave clean. Call update_goal with status complete and return after the bounded
handoff; the compiler may remain incomplete. Ralph refreshes progress gates
after return; their prior logs are not completion criteria. No goal reset or policy/state edit.

{{modelValidation}}
