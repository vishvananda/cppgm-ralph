Translate a substantial frozen C++ dependency batch for {{testStage}} into safe Rust.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read the current handout, contract/spec, compact ledger and selected C++ owners.
Map their functions, branches, persistent state and phase boundaries to Rust.
Preserve algorithms, evaluation/short-circuit and emission order, live queue
traversal, cache keys and state lifetimes. Adapt pointer representation to typed
IDs/owned stores; defer optional redesign. Temporary borrowing facades must not
reset persistent state. Work from C++ source rather than reconstructing behavior
from fixtures. Preserve the existing optimizer/backend policy and safe Rust rules.

Select a finite batch with explicit closure criteria: normally a whole source
owner, or several related mechanisms when the owner is larger. Fix shared
producers before consumers; continue through the selected mechanisms after each
repair. One passing case or isolated fix is not the default handoff boundary.
Queue unrelated discoveries. Up to three read-only reviewers cover disjoint
ranges; the parent edits and certifies only fully reviewed source responsibilities.

Iterate with affected fixtures and a few controls for changed invariants, plus
clone_quality.py --review. Do not routinely expand mode matrices, stack campaigns
or timings. Use protected stack qualification for actual exhaustion. Measure two
supported scales only for a concrete changed allocation/repeated-work bound.
During PA33, clone_bootstrap_probe.py --limit 4 is an isolated diagnostic, never
PA34 acceptance; reuse recorded results and reduce the first divergent boundary.

Use clone_evidence.py checkpoint {{testStage}} --out PATH --evidence FILE during
open work. Refresh broad prior/full quality once when the selected batch stabilizes,
reusing valid content-bound successes. Ralph runs stage/course/preservation and
release checks at the boundary; do not duplicate them or repeat release/debug
probes while known source incompleteness blocks acceptance. Final acceptance still
requires every stage/release/bootstrap gate, source owner and strict snapshot.
No per-fix full sweeps, copied receipts, hardcoded validators or relaxed comparison.

Replace the ledger with selected owners, state mapping, finite findings,
closed/reopened responsibilities, evidence and the next dependency. Raw controls
stay in artifacts and prior plans in Git. Commit coherent work, leave clean,
complete Ralph's existing native handoff goal and return. Partial completion ends
the handoff, not the assignment. Never reset goals or edit Ralph state.

{{modelValidation}}
