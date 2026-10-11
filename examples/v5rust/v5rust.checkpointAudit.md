Audit the accepted partial work for {{testStage}} without requiring future
unimplemented behavior to pass.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, the handout and stage ledger. Review
the diff since its last-audited commit (initially the stage base), relevant C++
owners and the Rust source map. Trace behavior through typed representations,
including failure paths, lifetimes, rollback, demand and deterministic order.

Check real algorithmic completeness for the groups marked done. Look for
fixture-specific shortcuts, C++/oracle delegation, needless cloning or global
scans, duplicate parsers, unsafe paths, suppressed Clippy warnings, mechanical
file splits and missing ownership invariants. Check exact numeric semantics,
diagnostic bytes and emission order where touched. Production tool names stay
compatible; Rust identifiers follow Rust naming conventions.

Fix findings in the completed groups, add required regressions in the owning
lane and run meaningful validation. Preserve the entire accepted passing-case
set and all earlier stages. Do not waive a finding because the fixture count
is unchanged. Do not require the entire current assignment to be finished.
For PA34 audit source/object mapping, fresh-build provenance and path identity;
do not substitute a C++ object for a failed Rust output.

Record findings, fixes, commands and evidence in the stage ledger; advance its
last-audited commit to the reviewed implementation commit. Commit a coherent
audit result and leave a clean checkout. Complete Ralph's existing phase goal
and hand control back; do not create/reset goals or edit Ralph state.

{{modelValidation}}
