Implement a coherent PA35 Rust compiler optimization.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read spec.md, pa35/README.md and gates.txt. PA34 used the
@PROFILE@ profile; PA35 permits valid optimizer/backend and internal counter
differences under ordinary course contracts. Preserve its completed bootstrap proof
as history, not a byte-equality restriction on new optimizations.
R's C++ compile time/RSS/scaling measures compiler throughput. A=R(S) relative
to B=host(S) measures generated code. S is immutable; C/D fixed-point binaries
do not measure R's codegen. Use the configured reference variables and actual
release binaries, including R's own backend for correctness and kernels.

Work in order: correctness, bounded speed/scaling, codegen, then speed-only
changes preserving output. Use focused smoke/groups and cached hardware counts;
full simulation needs final acceptance or a stated unresolved question. Retain
old R for constant-source ab.pl comparisons. Reuse unchanged qualification and
host observations; do not grow matrices or repeat identical measurements.
Refresh affected canonical group receipts before test-progress. Missing or
stale results cannot certify changed code. Record compact mechanism/evidence
and remaining gates. Commit and leave clean. Coherent partial progress can
complete this implementation handoff; final acceptance still requires all
17 gates, complete bootstrap, earlier correctness and Rust quality.
Complete Ralph's existing native handoff goal with update_goal; never create
or replace it or edit checker/Ralph state.

{{modelValidation}}
