Independently review the completed frozen-source batch and close concrete translation gaps.

{{briefState}}
Inventory status: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, porting.md and the compact current
ledger. PA33 is the whole-source inventory label, not an assignment feature task.
Use the frozen C++ files directly. Preserve functions, fields, control flow,
persistent state, failure restoration, lazy/short-circuit order, live queues and
cache boundaries. Record Rust-required representation adaptations; defer optional
redesign, abstractions and optimization. Keep the frozen per-file mapping.

When `port/reference-update.json` exists, recover its changed completed sources
in dependency groups before new translation. Diff the pinned old/new C++ files;
update affected declarations and consumers together. Old plans and receipts do
not establish current parity. Reuse unchanged reviews, renew affected evidence
and usable milestones, and avoid repeating unrelated historical audits.

Review all changed source mappings since the recorded reviewed tip. Trace
original branches, state lifetimes and queue/cache boundaries, not just fixtures. Pending declarations/stubs may help compilation but do not
count as implemented. Use make inspect SOURCE=dev/path.cpp to map every function.
Unsafe needs SAFETY explanations, a precise ledger and valid alias/lifetime rules.
Never call C++ implementation code or substitute oracle answers/objects.

Validate a coherent batch with make build, make lint and make audit-rust; record
successful commands through scripts/clone/port_check.py record -- COMMAND.
Use focused differential cases and original course milestones when tools are
usable. Reuse controls, run broad suites at stable milestones/final closure and
use bounded frozen-source probes to prioritize the first real divergence.
Original tests, diagnostics, work counters and generated files remain exact.

Fill current whole-source reviews and function correspondence, then mark only
fully translated/reviewed source rows complete. Keep one ledger: batch, reviewed
tip, mappings/adaptations, findings, evidence and next dependency. Commit and
leave clean. Call update_goal with status complete and return after the bounded
handoff; the compiler may remain incomplete. Ralph refreshes progress gates
after return; their prior logs are not completion criteria. No goal reset or policy/state edit.

{{modelValidation}}

Final advancement requires the complete inventory, all PA1–PA33 differential/course/debug lanes and full Rust quality. PA34 then proves clean C1==C2==CR==C3; partial probes never satisfy it.
