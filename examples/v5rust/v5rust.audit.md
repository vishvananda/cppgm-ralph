Complete a substantial source-faithful parity batch for {{testStage}}.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, the current ledger and selected frozen C++
owners. This is a translation: preserve the reference algorithm, state lifetime,
phase transitions, query/short-circuit order, queue traversal and cache boundaries.
Adapt pointers to safe Rust IDs/stores; defer optional redesign and optimization.
A temporary borrowing facade must retain the C++ owner's persistent state.

Select a finite batch with explicit closure criteria: normally a whole source
owner, or several related mechanisms when the owner is larger. Map C++ functions,
branches and entry/exit state to Rust. Fix shared lifecycle producers before
consumers; continue through the selected mechanisms after each repair. One isolated
fix is not the default handoff boundary. Follow necessary dependencies and queue
unrelated discoveries instead of expanding the audit indefinitely.
Use up to three read-only reviewers on disjoint ranges within the selected group;
the parent owns edits, integration and source-map certification.

Translate the full mechanism, including failure restoration and lazy demands, then
validate affected consumers. Reuse focused controls; add a regression only for an
uncovered invariant. Do not multiply every input across dump modes or run routine
resource studies. Measure supported scales only for a concrete changed work bound.
Use the protected stack qualification for actual exhaustion, never cutoff matching.

During PA33, use python3 scripts/clone/clone_bootstrap_probe.py --limit 4 for a
bounded diagnostic against frozen compiler sources. Reuse its recorded result until
relevant code changes; --source selects a unit and --start-after continues the
inventory. Reduce the first mismatch at its earliest compiler boundary. Diagnostic
objects are isolated and confer no PA34 acceptance; all normal gates remain due.

Iterate with focused checks and python3 scripts/clone_quality.py --review. Index
open work using clone_evidence.py checkpoint {{testStage}} --out PATH --evidence FILE.
Refresh broad prior/full quality once when the selected batch stabilizes; reuse
valid content-bound successes. Ralph runs stage/course/preservation and release
checks at the boundary; do not duplicate them or repeat release/debug probes while
known source incompleteness blocks acceptance. Keep focused checks between repairs.

Close a source-map responsibility only after its entire selected C++ contract is
translated/reviewed and affected checks pass. Report newly closed/reopened owners,
remaining findings and the next dependency in one compact ledger; raw evidence and
old plans stay in artifacts/Git. Commit a coherent checkpoint and leave clean.
Complete Ralph's existing native handoff goal and return; a bounded audit handoff
need not complete the assignment. Do not report an outstanding defect as accepted.

Final stage acceptance still requires the exact stage, original course, all prior,
full Rust quality, preservation and applicable release/debug/bootstrap checks plus
the strict evidence snapshot. PA33 requires all source responsibilities; PA34
requires C1==C2==CR==C3. Preserve the frozen oracle, cases, architecture and codegen.
No unsafe/compiler fallback, output normalization, gate change, goal reset or Ralph
state edit. PA35 optimization is excluded.

{{modelValidation}}
